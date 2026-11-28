import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddAlertOptions } from '../../services/system-alerts.js';
import { RingSnapshotMonitor } from '../../asset_classes/xstock_spot/book-state-ring-monitor.js';

vi.mock('node:fs', async (importOriginal) => {
  const source = await importOriginal<typeof import('node:fs')>();
  return { ...source, renameSync: vi.fn(source.renameSync) };
});

// The real warning monitor and dispatcher share this key.
const KEY = 'book-state-ring-snapshot-failing';
const RECOVERY_EVIDENCE = 'server/tests/unit/b-xstock-retained-ring-warning-ledger.test.ts:1';
const FIRST_ELIGIBLE_MS = 300_000;
const episode = (ringIncidentId: string, elapsedMs: number): AddAlertOptions => ({
  triggers_at: new Date(0),
  category: 'breakage',
  severity: 'warning',
  title: 'xStock book-state ring snapshots failing',
  body: 'Isolated retained-ring warning test',
  dedupe_key: KEY,
  metadata: { ringIncidentId, elapsedMs },
});

let directory: string;
let ledger: string;
let alerts: typeof import('../../services/system-alerts.js');

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xstock-ring-warning-'));
  ledger = path.join(directory, 'alerts.jsonl');
  vi.stubEnv('SYSTEM_ALERTS_FILE', ledger);
  alerts = await import('../../services/system-alerts.js');
});
beforeEach(() => fs.writeFileSync(ledger, ''));
afterAll(() => {
  vi.unstubAllEnvs();
  for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
  fs.rmdirSync(directory);
});

describe('retained-ring warning ledger controls', () => {
  it('keeps B behind A, then promotes exactly one B after A resolves and B retries', async () => {
    const a = await alerts.addAlert(episode('A', FIRST_ELIGIBLE_MS));
    expect((await alerts.fireDue()).map(row => row.id)).toEqual([a.id]);

    const blocked = await alerts.addAlert(episode('B', FIRST_ELIGIBLE_MS));
    expect(blocked.id).toBe(a.id);
    expect(blocked.metadata.ringIncidentId).toBe('A');
    await alerts.resolveAlert(a.id, 'codex-c', RECOVERY_EVIDENCE, 'cli');
    // Omission control. With no retry, nothing gets promoted for B.
    expect((await alerts.fireDue()).map(row => row.id)).toEqual([]);
    expect(alerts.readAllAlerts().map(row => [row.id, row.state])).toEqual([[a.id, 'resolved']]);

    const stillOutstanding = episode('B', FIRST_ELIGIBLE_MS + 30_000);
    const b = await alerts.addAlert(stillOutstanding);
    expect(b.id).not.toBe(a.id);
    expect((await alerts.addAlert(stillOutstanding)).id).toBe(b.id);
    expect((await alerts.fireDue()).map(row => row.id)).toEqual([b.id]);
    expect(await alerts.fireDue()).toEqual([]);
    const rows = alerts.readAllAlerts();
    expect(rows.map(row => [row.id, row.state])).toEqual([[a.id, 'resolved'], [b.id, 'active']]);
    expect(rows[0].resolution_evidence).toBe(RECOVERY_EVIDENCE);
    expect(rows[1].acknowledged_at).toBeNull();
    expect(rows[1].metadata).toEqual(stillOutstanding.metadata);
  });

  it('can retry a failed atomic rename, and can find a committed rename after a lost reply', async () => {
    const options = episode('rename-incident', FIRST_ELIGIBLE_MS);
    const { renameSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    const fault = vi.mocked(fs.renameSync);
    fault.mockImplementationOnce(() => { throw new Error('rename did not commit'); });
    await expect(alerts.addAlert(options)).rejects.toThrow('rename did not commit');
    expect(alerts.readAllAlerts()).toEqual([]);

    fault.mockImplementationOnce((from, to) => {
      renameSync(from, to);
      throw new Error('reply lost after rename');
    });
    await expect(alerts.addAlert(options)).rejects.toThrow('reply lost after rename');
    const persisted = alerts.readAllAlerts();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ dedupe_key: KEY, state: 'scheduled', metadata: options.metadata });
    expect((await alerts.addAlert(options)).id).toBe(persisted[0].id);
    expect(alerts.readAllAlerts()).toHaveLength(1);
  });
});

describe('retained-ring warning monitor with the real ledger', () => {
  it('warns at five minutes about work still owed for the exact symbol and latest invocation', async () => {
    let now = 0;
    const monitor = new RingSnapshotMonitor(async () => alerts, () => now);
    monitor.begin('1', [], now);
    now = FIRST_ELIGIBLE_MS;
    await monitor.checkWarning();
    expect(alerts.readAllAlerts()).toEqual([]);

    const first = now;
    monitor.begin('2', ['A/USD', 'B/USD'], now);
    now += 1;
    monitor.begin('3', ['A/USD'], now);
    monitor.settle('3', [{ symbol: 'A/USD', outcome: 'rejected' }]);
    monitor.settle('2', [
      { symbol: 'A/USD', outcome: 'confirmed', durableVersion: '1/boot/2' },
      { symbol: 'B/USD', outcome: 'confirmed', durableVersion: '1/boot/2' },
    ]);
    now = first + FIRST_ELIGIBLE_MS - 1;
    await monitor.checkWarning();
    expect(alerts.readAllAlerts()).toEqual([]);
    now++;
    await monitor.checkWarning();
    const [row] = alerts.readAllAlerts();
    expect(row).toMatchObject({ metadata: { elapsedMs: FIRST_ELIGIBLE_MS, symbols: ['A/USD'] } });
    expect((await alerts.fireDue()).map(alert => alert.id)).toEqual([row.id]);

    monitor.begin('4', ['A/USD'], now);
    monitor.settle('4', [{ symbol: 'A/USD', outcome: 'confirmed', durableVersion: '1/boot/4' }]);
    expect(alerts.readAllAlerts()[0].state).toBe('active'); // operator resolves with durable evidence
  });

  it('retries for a new boot behind an existing warning and inserts once after evidence-backed resolution', async () => {
    let now = 0;
    const a = new RingSnapshotMonitor(async () => alerts, () => now);
    a.begin('1', ['A/USD'], now);
    now = FIRST_ELIGIBLE_MS;
    await a.checkWarning();
    const [rowA] = await alerts.fireDue();
    a.settle('1', [{ symbol: 'A/USD', outcome: 'confirmed', durableVersion: '1/boot-a/1' }]);

    const b = new RingSnapshotMonitor(async () => alerts, () => now);
    b.begin('1', ['B/USD'], now);
    now += FIRST_ELIGIBLE_MS + 5_000; // first poll delayed beyond threshold
    await b.checkWarning();
    expect(alerts.readAllAlerts().map(row => row.id)).toEqual([rowA.id]);
    await alerts.resolveAlert(rowA.id, 'codex-c', RECOVERY_EVIDENCE, 'cli');
    now += 29_999;
    await b.checkWarning();
    expect(await alerts.fireDue()).toEqual([]); // omission and minimum retry-interval control
    now++;
    await Promise.all([b.checkWarning(), b.checkWarning()]);
    const [rowB] = await alerts.fireDue();
    expect(rowB.id).not.toBe(rowA.id);
    expect(rowB.metadata).toMatchObject({ elapsedMs: FIRST_ELIGIBLE_MS + 35_000, symbols: ['B/USD'] });
    now += FIRST_ELIGIBLE_MS;
    await b.checkWarning();
    expect(await alerts.fireDue()).toEqual([]);
    expect(alerts.readAllAlerts()).toMatchObject([
      { state: 'resolved', resolution_evidence: RECOVERY_EVIDENCE },
      { state: 'active', acknowledged_at: null },
    ]);
  });

  it('retries a failed rename and reads back a committed rename once when its reply is lost', async () => {
    let now = 0;
    const add = vi.fn(alerts.addAlert);
    const monitor = new RingSnapshotMonitor(async () => ({ ...alerts, addAlert: add }), () => now);
    monitor.begin('1', ['A/USD'], now);
    const { renameSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    const fault = vi.mocked(fs.renameSync);
    fault.mockImplementationOnce(() => { throw new Error('rename did not commit'); });
    now = FIRST_ELIGIBLE_MS;
    await monitor.checkWarning();
    expect(alerts.readAllAlerts()).toEqual([]);
    fault.mockImplementationOnce((from, to) => {
      renameSync(from, to);
      throw new Error('reply lost after rename');
    });
    now += 30_000;
    await monitor.checkWarning();
    expect((await alerts.fireDue()).map(row => row.metadata.elapsedMs)).toEqual([330_000]);
    now += 120_000;
    await monitor.checkWarning();
    expect(add).toHaveBeenCalledTimes(2);
    expect(alerts.readAllAlerts()).toHaveLength(1);
  });

  it('a delayed append can supply evidence for its own recovered incident without stopping a new incident', async () => {
    let now = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const add = vi.fn(alerts.addAlert).mockImplementationOnce(async opts => {
      await held;
      return alerts.addAlert(opts);
    });
    const monitor = new RingSnapshotMonitor(async () => ({ ...alerts, addAlert: add }), () => now);
    monitor.begin('1', ['A/USD'], now);
    now = FIRST_ELIGIBLE_MS;
    const pending = monitor.checkWarning();
    monitor.settle('1', [{ symbol: 'A/USD', outcome: 'superseded', durableVersion: '1/boot/2' }]);
    monitor.begin('2', ['B/USD'], now);
    now += FIRST_ELIGIBLE_MS;
    await monitor.checkWarning();
    release();
    await pending;
    const [rowA] = await alerts.fireDue();
    await alerts.resolveAlert(rowA.id, 'codex-c', RECOVERY_EVIDENCE, 'cli');
    await monitor.checkWarning();
    const [rowB] = await alerts.fireDue();
    expect(rowA.metadata.symbols).toEqual(['A/USD']);
    expect(rowB.metadata.symbols).toEqual(['B/USD']);
    expect(rowB.metadata.ringIncidentId).not.toBe(rowA.metadata.ringIncidentId);
  });
});
