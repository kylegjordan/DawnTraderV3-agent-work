import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';

const { checkout, write, load, capture, addAlert } = vi.hoisted(() => ({
  checkout: vi.fn(), write: vi.fn(), load: vi.fn(), capture: vi.fn(), addAlert: vi.fn(),
}));
vi.mock('../../db.js', () => ({ pool: { connect: checkout }, db: { execute: write } }));
vi.mock('../../asset_classes/xstock_spot/book-state-tracker.js', () => ({
  restoreRetainedRings: load, snapshotRetainableRings: capture,
}));
vi.mock('../../asset_classes/xstock_spot/book-state-config.js', () => ({
  resolveBookStateConfigSync: () => ({ trailingSpreadWindowSnaps: 10 }),
}));
vi.mock('../../services/system-alerts.js', () => ({ addAlert }));

import {
  _resetRingStoreForTest, flushRingSnapshotOnShutdown, persistRingSnapshot, restoreRingsAtBoot, snapshotTick,
} from '../../asset_classes/xstock_spot/book-state-ring-store.js';

const { pool } = await vi.importActual<typeof import('../../db.js')>('../../db.js');
const url = (pool as { options?: { connectionString?: string } }).options?.connectionString ?? '';
const localTestDb = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1|postgres)(:\d+)?\/test(\?|$)/.test(url);
if (process.env.CI && !localTestDb) throw new Error('Retained-ring boot requires the CI-local test database');

function launchRingProcess(schema: string, mode: 'writer' | 'replacement') {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/tests/integration/fixtures/xstock-retained-ring-process.ts', mode], {
    env: { ...process.env, NODE_ENV: 'test', PGOPTIONS: `-c search_path=${schema}` },
    stdio: 'pipe',
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  const exited = new Promise<number | null>(resolve => {
    child.once('error', error => { output += String(error); });
    child.once('close', resolve);
  });
  return { child, exited, output: () => output };
}

afterAll(() => pool.end());

describe.skipIf(!localTestDb)('guarded startup with real PostgreSQL', () => {
  it('orders replacement boot after a shutdown write already submitted by an exited process', async (ctx) => {
    const schema = `b_ring_process_${randomBytes(8).toString('hex')}`;
    let witness: PoolClient;
    try {
      witness = await pool.connect();
    } catch (error) {
      if (process.env.CI) throw error;
      return ctx.skip();
    }
    let blocker: PoolClient | undefined;
    let writer: ReturnType<typeof launchRingProcess> | undefined;
    let replacement: ReturnType<typeof launchRingProcess> | undefined;
    let created = false;
    try {
      expect((await witness.query('SELECT current_database() AS name')).rows[0].name).toBe('test');
      await witness.query(`CREATE SCHEMA ${schema}`);
      created = true;
      await witness.query(`SET search_path TO ${schema}`);
      for (const migration of [
        '2026-09-24-b-book-state-restart-durable.sql',
        '2026-11-28-b-xstock-retained-ring-writer-guard.sql',
      ]) {
        await witness.query(readFileSync(`drizzle/migrations/${migration}`, 'utf8'));
      }
      const symbol = 'D1-PROCESS/USD';
      await witness.query(
        'INSERT INTO xstock_book_state_rings (symbol, spreads, seed_basis, source, written_at, persisted_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [symbol, '[0.01]', 'judged', 'retained', new Date(1_000), new Date(2_000)],
      );
      writer = launchRingProcess(schema, 'writer');
      await expect.poll(writer.output, { timeout: 7_000 }).toContain('D1_PROCESS_READY');
      const authority = (await witness.query('SELECT generation, boot_id FROM xstock_book_state_ring_writer_guard')).rows[0];
      expect(authority).toMatchObject({ generation: '1', boot_id: expect.any(String) });

      blocker = await pool.connect();
      await blocker.query(`SET search_path TO ${schema}`);
      const [{ pid: blockerPid }] = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows;
      const waitingOn = async (pid: number, queryFragment: string) => (await witness.query(
        'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND strpos(query, $2) > 0 AND $1 = ANY(pg_blocking_pids(pid))',
        [pid, queryFragment],
      )).rows.map(row => Number(row.pid));
      await blocker.query('BEGIN');
      await blocker.query('SELECT symbol FROM xstock_book_state_rings WHERE symbol = $1 FOR UPDATE', [symbol]);
      writer.child.stdin.end('shutdown\n');
      const shutdownWrite = 'INSERT INTO xstock_book_state_rings';
      await expect.poll(() => waitingOn(blockerPid, shutdownWrite), { timeout: 4_000 }).toHaveLength(1);
      const [oldPid] = await waitingOn(blockerPid, shutdownWrite);
      const writerExit = await writer.exited;
      expect(writerExit, writer.output()).toBe(0);
      const deadlineLine = writer.output().split(/\r?\n/).find(line => line.includes('SNAPSHOT_DEADLINE_UNKNOWN '));
      if (!deadlineLine) throw new Error(`Writer exited without the shutdown deadline receipt:\n${writer.output()}`);
      const pending = JSON.parse(deadlineLine.split('SNAPSHOT_DEADLINE_UNKNOWN ')[1]);
      expect(pending).toMatchObject({ bootId: authority.boot_id, generation: '1', sequence: '1', kind: 'shutdown', symbols: [symbol] });
      expect(await waitingOn(blockerPid, shutdownWrite)).toEqual([oldPid]);

      replacement = launchRingProcess(schema, 'replacement');
      await expect.poll(() => waitingOn(oldPid, 'UPDATE xstock_book_state_ring_writer_guard'), { timeout: 7_000 }).toHaveLength(1);
      expect(replacement.output()).not.toContain('D1_PROCESS_RESTORED');
      await blocker.query('COMMIT');
      const replacementExit = await replacement.exited;
      expect(replacementExit, replacement.output()).toBe(0);
      const confirmed = replacement.output().split(/\r?\n/).find(line => line.startsWith('D1_PROCESS_RESTORED '));
      if (!confirmed) throw new Error(`Replacement exited without the restore receipt:\n${replacement.output()}`);
      expect(JSON.parse(confirmed.slice('D1_PROCESS_RESTORED '.length))).toEqual({
        spreads: [0.04], writtenAtMs: 3_000, persistedAtMs: pending.submittedAt,
      });
      const durable = await witness.query(
        'SELECT spreads, written_at, persisted_at, writer_generation, writer_boot_id, writer_sequence FROM xstock_book_state_rings',
      );
      expect(durable.rows).toEqual([{
        spreads: [0.04], written_at: new Date(3_000), persisted_at: new Date(pending.submittedAt),
        writer_generation: '1', writer_boot_id: authority.boot_id, writer_sequence: '1',
      }]);
      expect((await witness.query('SELECT generation FROM xstock_book_state_ring_writer_guard')).rows).toEqual([{ generation: '2' }]);
    } finally {
      try {
        await blocker?.query('ROLLBACK');
        for (const running of [writer, replacement]) {
          if (running?.child.exitCode === null && running.child.signalCode === null) running.child.kill();
          await running?.exited;
        }
        if (created) await witness.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        blocker?.release(true);
        witness.release(true);
      }
    }
  }, 25_000);

  it.for([
    'normal', 'lost after commit', 'lost before commit', 'silent after commit', 'different boot at same generation',
    'overlap with older write first', 'overlap with newer write first',
    'snapshot reply lost after commit', 'snapshot reply lost without commit', 'snapshot fenced by a different boot',
    'shutdown deadline with an older periodic write pending',
  ] as const)(
    '%s', async (mode, ctx) => {
      _resetRingStoreForTest();
      vi.resetAllMocks();
      const schema = `b_ring_boot_${randomBytes(8).toString('hex')}`;
      let witness: PoolClient;
      try {
        witness = await pool.connect();
      } catch (error) {
        if (process.env.CI) throw error;
        return ctx.skip();
      }
      const symbol = 'D1-RESTORE/USD';
      const source = { symbol, spreads: [0.01], seedBasis: 'judged', source: 'retained', writtenAtMs: 1_000 };
      const otherBootId = 'bcdd1077-8633-4aa3-8080-d39bd9f3ed05';
      const unproved = mode === 'lost before commit' || mode === 'different boot at same generation';
      const loseReply = unproved || mode === 'lost after commit' || mode === 'silent after commit';
      const commands: string[][] = [];
      const pids: number[] = [];
      let created = false;
      try {
        expect((await witness.query('SELECT current_database() AS name')).rows[0].name).toBe('test');
        await witness.query(`CREATE SCHEMA ${schema}`);
        created = true;
        await witness.query(`SET search_path TO ${schema}`);
        for (const migration of [
          '2026-09-24-b-book-state-restart-durable.sql',
          '2026-11-28-b-xstock-retained-ring-writer-guard.sql',
        ]) {
          await witness.query(readFileSync(`drizzle/migrations/${migration}`, 'utf8'));
        }
        await witness.query(
          `INSERT INTO xstock_book_state_rings (symbol, spreads, seed_basis, source, written_at, persisted_at)
           VALUES ($1, '[0.01]', 'judged', 'retained', $2, $3)`,
          [symbol, new Date(1_000), new Date(2_000)],
        );
        checkout.mockImplementation(async () => {
          const client = await pool.connect();
          try {
            await client.query(`SET search_path TO ${schema}`);
            pids.push((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
          } catch (error) {
            client.release(true);
            throw error;
          }
          const statements: string[] = [];
          const attempt = commands.push(statements);
          return {
            release: (destroy?: boolean) => client.release(destroy),
            query: async (statement: string, parameters?: string[]) => {
              statements.push(statement);
              if (statement === 'COMMIT') {
                expect(load).not.toHaveBeenCalled();
                expect(write).not.toHaveBeenCalled();
                if (attempt === 1 && loseReply) {
                  await client.query(unproved ? 'ROLLBACK' : 'COMMIT');
                  if (mode === 'different boot at same generation') {
                    const takeover = await witness.query(
                      'UPDATE xstock_book_state_ring_writer_guard SET generation = 1, boot_id = $1 WHERE singleton AND generation = 0',
                      [otherBootId],
                    );
                    expect(takeover.rowCount).toBe(1);
                  }
                  if (mode === 'silent after commit') return new Promise(() => {});
                  throw new Error('injected lost database reply');
                }
              }
              return client.query(statement, parameters);
            },
          };
        });
        write.mockImplementation(query => drizzle(witness).execute(query));
        load.mockReturnValue([symbol]);
        capture.mockReturnValue([{ ...source, spreads: [0.02], writtenAtMs: 3_000 }]);
        const restore = restoreRingsAtBoot();
        expect(restoreRingsAtBoot()).toBe(restore);
        expect((await persistRingSnapshot()).written).toBe(0);
        const loaded = await restore;

        expect(commands[0]).toMatchObject([
          'BEGIN ISOLATION LEVEL READ COMMITTED',
          expect.stringContaining('SELECT generation::text'), expect.stringContaining('UPDATE'),
          expect.stringContaining('FROM xstock_book_state_rings'), 'COMMIT',
        ]);
        const [{ generation, boot_id }] = (await witness.query(
          'SELECT generation::text, boot_id FROM xstock_book_state_ring_writer_guard',
        )).rows;

        if (!loseReply) {
          expect(commands).toHaveLength(1);
        } else {
          expect(pids).toHaveLength(2);
          expect(pids[1]).not.toBe(pids[0]);
          const recovery = [
            'BEGIN ISOLATION LEVEL READ COMMITTED',
            expect.stringContaining('FOR SHARE'),
          ];
          expect(commands[1]).toEqual(unproved ? recovery : [
            ...recovery, expect.stringContaining('FROM xstock_book_state_rings'), 'COMMIT',
          ]);
        }

        if (unproved) {
          expect(loaded).toBe(0);
          expect(generation).toBe(mode === 'lost before commit' ? '0' : '1');
          expect(boot_id).toBe(mode === 'lost before commit' ? null : otherBootId);
          expect(load).not.toHaveBeenCalled();
          await snapshotTick();
          await flushRingSnapshotOnShutdown();
          expect(write).not.toHaveBeenCalled();
          await vi.waitFor(() => expect(addAlert).toHaveBeenCalledTimes(1));
        } else {
          expect(loaded).toBe(1);
          expect(generation).toBe('1');
          expect(load).toHaveBeenCalledExactlyOnceWith([{ ...source, persistedAtMs: 2_000 }]);
          expect(await persistRingSnapshot(4_000)).toMatchObject({
            written: 1, settlements: [{ symbol, outcome: 'confirmed', durableVersion: `1/${boot_id}/1` }],
          });
          expect(addAlert).not.toHaveBeenCalled();
        }
        const { rows } = await witness.query(
          'SELECT spreads, written_at, persisted_at, writer_generation, writer_boot_id, writer_sequence FROM xstock_book_state_rings',
        );
        expect(rows).toEqual(unproved ? [{
          spreads: [0.01], written_at: new Date(1_000), persisted_at: new Date(2_000),
          writer_generation: null, writer_boot_id: null, writer_sequence: null,
        }] : [{
          spreads: [0.02], written_at: new Date(3_000), persisted_at: new Date(4_000),
          writer_generation: '1', writer_boot_id: boot_id, writer_sequence: '1',
        }]);

        if (mode === 'overlap with older write first' || mode === 'overlap with newer write first') {
          const olderFirst = mode === 'overlap with older write first';
          const writers: PoolClient[] = [];
          try {
            for (let i = 0; i < 2; i++) {
              const client = await pool.connect();
              writers.push(client);
              await client.query(`SET search_path TO ${schema}`);
            }
            const older = { ...source, spreads: [0.03], writtenAtMs: 6_000 };
            const newer = { ...source, spreads: [0.04], writtenAtMs: 5_000 };
            const sibling = 'D1-SIBLING/USD';
            capture.mockReturnValueOnce([older, { ...older, symbol: sibling }]).mockReturnValueOnce([newer]);
            let unblock!: () => void;
            const held = new Promise<void>(resolve => { unblock = resolve; });
            write.mockReset().mockImplementation(query => drizzle(witness).execute(query)).mockImplementationOnce(async query => {
              if (!olderFirst) await held;
              return drizzle(writers[0]).execute(query);
            }).mockImplementationOnce(async query => {
              if (olderFirst) await held;
              return drizzle(writers[1]).execute(query);
            });
            // Exercise a wall-clock regression as well as both submission orders.
            // The application captures the older invocation first in both cases.
            const olderWrite = persistRingSnapshot(8_000);
            const newerWrite = persistRingSnapshot(7_000);
            const allResults = Promise.allSettled([olderWrite, newerWrite]);
            const durable = async () => (await witness.query(
              'SELECT spreads, written_at, persisted_at, writer_generation, writer_boot_id, writer_sequence FROM xstock_book_state_rings WHERE symbol = $1',
              [symbol],
            )).rows;
            const expectedNewer = [{
              spreads: [0.04], written_at: new Date(5_000), persisted_at: new Date(7_000),
              writer_generation: '1', writer_boot_id: boot_id, writer_sequence: '3',
            }];
            try {
              expect(await (olderFirst ? olderWrite : newerWrite)).toMatchObject({ written: olderFirst ? 2 : 1 });
              expect(await durable()).toEqual(olderFirst ? [{
                spreads: [0.03], written_at: new Date(6_000), persisted_at: new Date(8_000),
                writer_generation: '1', writer_boot_id: boot_id, writer_sequence: '2',
              }] : expectedNewer);
            } finally {
              unblock();
              await allResults;
            }
            expect(await olderWrite).toMatchObject({
              written: olderFirst ? 2 : 1,
              settlements: [
                { symbol, outcome: olderFirst ? 'confirmed' : 'superseded', durableVersion: `1/${boot_id}/${olderFirst ? '2' : '3'}` },
                { symbol: sibling, outcome: 'confirmed', durableVersion: `1/${boot_id}/2` },
              ],
            });
            expect(await newerWrite).toMatchObject({ written: 1, settlements: [{ symbol, outcome: 'confirmed' }] });
            expect(await durable()).toEqual(expectedNewer);
            expect((await witness.query(
              'SELECT spreads, written_at, persisted_at, writer_sequence FROM xstock_book_state_rings WHERE symbol = $1', [sibling],
            )).rows).toEqual([{
              spreads: [0.03], written_at: new Date(6_000), persisted_at: new Date(8_000), writer_sequence: '2',
            }]);
          } finally {
            for (const writer of writers) writer.release(true);
          }
        }

        if (mode.startsWith('snapshot ')) {
          const committed = mode === 'snapshot reply lost after commit';
          const rejected = mode === 'snapshot fenced by a different boot';
          if (rejected) {
            await witness.query(
              'UPDATE xstock_book_state_ring_writer_guard SET generation = 2, boot_id = $1 WHERE singleton',
              [otherBootId],
            );
          } else {
            write.mockImplementationOnce(async query => {
              if (committed) await drizzle(witness).execute(query);
              throw new Error('injected lost snapshot reply');
            });
          }
          capture.mockReturnValue([{ ...source, spreads: [0.05], writtenAtMs: 7_000 }]);
          const result = await persistRingSnapshot(8_000);
          expect(result).toMatchObject({
            written: rejected ? 0 : null,
            settlements: [committed
              ? { symbol, outcome: 'confirmed', durableVersion: `1/${boot_id}/2` }
              : { symbol, outcome: rejected ? 'rejected' : 'unknown' }],
          });
          expect((await witness.query(
            'SELECT spreads, written_at, persisted_at, writer_sequence FROM xstock_book_state_rings WHERE symbol = $1',
            [symbol],
          )).rows).toEqual(committed ? [{
            spreads: [0.05], written_at: new Date(7_000), persisted_at: new Date(8_000), writer_sequence: '2',
          }] : [{
            spreads: [0.02], written_at: new Date(3_000), persisted_at: new Date(4_000), writer_sequence: '1',
          }]);
        }

        if (mode === 'shutdown deadline with an older periodic write pending') {
          const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
          let releasePeriodic!: () => void;
          let releaseFlush!: () => void;
          const periodicHeld = new Promise<void>(resolve => { releasePeriodic = resolve; });
          const flushHeld = new Promise<void>(resolve => { releaseFlush = resolve; });
          write.mockImplementationOnce(async query => {
            await periodicHeld;
            return drizzle(witness).execute(query);
          }).mockImplementationOnce(async query => {
            await flushHeld;
            return drizzle(witness).execute(query);
          });
          capture.mockReturnValueOnce([{ ...source, spreads: [0.03] }])
            .mockReturnValueOnce([{ ...source, spreads: [0.04] }]);
          const periodic = persistRingSnapshot(8_000);
          try {
            await flushRingSnapshotOnShutdown();
            expect(warnings).toHaveBeenCalledWith(expect.stringMatching(/SNAPSHOT_DEADLINE_UNKNOWN .*"kind":"shutdown"/));
            const latest = async () => (await witness.query(
              'SELECT spreads, writer_sequence FROM xstock_book_state_rings WHERE symbol = $1', [symbol],
            )).rows;
            expect(await latest()).toEqual([{ spreads: [0.02], writer_sequence: '1' }]);
            releaseFlush();
            await expect.poll(() => logs.mock.calls.some(([line]) =>
              /SNAPSHOT_SETTLEMENT .*"kind":"shutdown".*"outcome":"confirmed"/.test(String(line)),
            )).toBe(true);
            expect(await latest()).toEqual([{ spreads: [0.04], writer_sequence: '3' }]);
            releasePeriodic();
            expect(await periodic).toMatchObject({
              written: 0, settlements: [{ symbol, outcome: 'superseded', durableVersion: `1/${boot_id}/3` }],
            });
            expect(await latest()).toEqual([{ spreads: [0.04], writer_sequence: '3' }]);
          } finally {
            releasePeriodic();
            releaseFlush();
            await periodic;
            warnings.mockRestore();
            logs.mockRestore();
          }
        }
      } finally {
        try {
          if (created) await witness.query(`DROP SCHEMA ${schema} CASCADE`);
        } finally {
          witness.release(true);
        }
      }
    }, 15_000,
  );
});
