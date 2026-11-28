# B-XSTOCK-BID-TRIGGER-RELAND — retained-ring increment 1, Step 4

## Dispatch header

- Declared change-class: `architecture` in `Scope Files/B_XSTOCK_BID_TRIGGER_RELAND_SCOPE.md`.
- Step 2: `Scope Files/B_XSTOCK_BID_TRIGGER_RELAND_INCA_PRE_AUDIT.md` §D at `6ae3f7fb25f1260492c7785445172bced02690f6`, approved Nov 28 10:32:44Z. D1 storage design approved 12:20:38Z at `82bfd4b7c198f3ab7c49ff491c3dbaa2d52897c1`. Warning recurrence control `6633516770e45bb75d5a966586990e897af0e5e1`.
- Diff base: `2b74f5dd2693c5af6ab8b581b59cf1cbc244aed2`. Runtime code checkpoint: `0cbb80bd1cca796ac760c00240b4940437cd8cd3`.
- Step 4 r1: `08005c7ea79356c75f5e3416e80b8e61194b2a97`, CI `46152615109` four jobs green, request `1576245740005490881`. Coltrane returned CHANGES NEEDED at 14:51:04Z on Nov 28.
- Step 4 r2: `b6dc362332a075ef24f6611975651a997bca0467`, CI `46158839390`, request `1576256182782529709`. Coltrane confirmed crossed-book and decision/close-price parity and returned CHANGES NEEDED at 15:25:21Z on the two remaining evidence issues below. The r3 candidate is pinned by its exact SHA in the new dispatch on `review/analyst-xstock-retained-ring-step4`.

| Architecture document | This increment |
|---|---|
| Scope | Present at `Claude Comms and Packages/Scope Files/B_XSTOCK_BID_TRIGGER_RELAND_SCOPE.md` |
| Pre-audit | Present at `Claude Comms and Packages/Scope Files/B_XSTOCK_BID_TRIGGER_RELAND_INCA_PRE_AUDIT.md` §D |
| Completion report | Increment result absent, due at close |
| Batch catalog | Increment result absent, due at Step 10 in `1-system-manual/BATCH_CATALOG.md` |
| Phase history | Increment result absent, due at Step 10 in `1-system-manual/PHASE_HISTORY.md` |
| System Manual | Increment update absent, due at Step 10 in `1-system-manual/SYSTEM_MANUAL.md` |
| System Impact Map | Increment update absent, due at Step 10 in `1-system-manual/SYSTEM_IMPACT_MAP.md` |
| Changes and fixes | Applicable, due at Step 10 in `1-system-manual/CHANGES_AND_FIXES.md` |
| Running issues | Applicable to the pending ring evidence, due at Step 10 in `1-system-manual/RUNNING_ISSUES.md` |
| Post-audit roadmap | Judged N/A, existing batch path and follow-up placement apply |
| Deleted components | Judged N/A, no component retirement |
| Phase 19 plan | Applicable, due at Step 10 under rows 3n.q7 and 3n.q8 in `1-system-manual/PHASE_19_PLAN.md` |
| Adjustment framework | Judged N/A, no calibratable setting added or changed |

## Diff and acceptance

**New database fence and boot claim.** The migration adds writer identity and sequence, a singleton guard, and two triggers. The statement trigger takes the shared lock before any symbol row can lock. The row trigger rejects stale or legacy authority after activation and refuses a changed replay. In the new boot module, activation and restore are distinct statements inside the same READ COMMITTED transaction.

```ts
const generation = (await query(
  `UPDATE xstock_book_state_ring_writer_guard SET generation = generation + 1, boot_id = $2::uuid
   WHERE singleton AND generation = $1::bigint RETURNING generation::text`,
  [expected, bootId],
)).rows[0]?.generation;
if (typeof generation !== 'string') throw new Error('xStock retained-ring boot claim lost to another writer');
const authority = { bootId, generation };
const { rows } = await query(RESTORE_SQL);
return { authority, rows };
```

The return is published after COMMIT. If COMMIT is ambiguous, one new connection and the original deadline cover guarded proof of the exact generation and boot ID plus a fresh read. An unproved claim leaves the old rows intact and that boot does not write.

**Modified snapshot settlement.** A snapshot formerly reported the upsert reply. It now logs the submission before I/O and grades each submitted symbol after a separate primary read. The affected row count stays separate from durable proof.

```sql
WHEN r.writer_generation > ${authority.generation}::bigint
  OR (r.writer_generation = ${authority.generation}::bigint AND r.writer_boot_id = ${authority.bootId}::uuid
      AND r.writer_sequence > ${sequence}::bigint) THEN 'superseded'
WHEN r.writer_generation = ${authority.generation}::bigint AND r.writer_boot_id = ${authority.bootId}::uuid
  AND r.writer_sequence = ${sequence}::bigint
  AND ROW(r.spreads, r.seed_basis, r.source, r.written_at, r.persisted_at)
      IS NOT DISTINCT FROM ROW(x.spreads, x.seed_basis, x.source,
        to_timestamp(x.written_at_ms / 1000.0), to_timestamp(${submittedAt}::double precision / 1000.0))
  THEN 'confirmed'
```

The new warning monitor keeps the original unresolved age for each symbol as new snapshots arrive. Its own timer can trigger while a write is stalled. Only durable evidence for that symbol's current invocation removes it. A prior incident's ledger row does not satisfy the new attempt. Retry preserves elapsed time and appends one new row after evidence-backed resolution releases the existing key.

```ts
for (const result of results) {
  if (!('durableVersion' in result) || this.outstanding.get(result.symbol)?.sequence !== sequence) continue;
  this.outstanding.delete(result.symbol);
  if (incident.attempted) incident.recovery.set(result.symbol, result.durableVersion);
}
if (this.outstanding.size > 0) return;
this.incident = undefined;
if (incident.attempted) this.logRecovery(incident);
```

**Modified restored-ring evidence.** The tracker carries both stored stamps and original source into the seed record. The engine captures the chain that the current exit evaluation actually consumed, before any advance can change it, and reads the refusal tally by position and opened-at time. The release grade stops at the first decided tick in the same episode.

```ts
const rings = t.restoredRing;
const matched = rings?.openUse;
if (rings) rings.openUse = null;
if (rings && matched && evaluation?.chain) {
  const direction = priced ? bid <= stop ? 'atOrBelowStop' : 'aboveStop' : 'unpriced';
  const release: MatchedRingRelease = {
    episode: t.episodes, firstUse: matched.first, lastUse: matched.last, evaluation,
    bid: Number.isFinite(bid) ? bid : null, stop: Number.isFinite(stop) ? stop : null, direction,
  };
  rings.releaseDirections[direction]++;
  rings.firstMatchedRelease ??= release;
  rings.lastMatchedRelease = release;
}
```

**Evidence and limits.** The §D checkpoints record 232 offline tests across seven suites for the episode linkage and price/decision/close controls. The D1 group passed 51 tests across six suites with a disposable PostgreSQL 17.12 database, including both same-process completion orders, mixed symbol settlement, both guard acquisition orders, lost-reply cases, an actual old Node exit followed by a fresh replacement process, and five-minute warning recurrence through the real file ledger. The old database statement survived the Node exit while blocked. The replacement acquired the guard after that statement settled and restored the changed payload and both timestamps. Local timing on 50 pairs of 250 symbols put the production write plus readback p95 at 20.60 ms, and the uncontended boot claim plus ring read p95 at 4.03 ms. The timing excludes live transport, production load and log delivery. The deployed-role checks, rollback permissions and actual Discord delivery need separate staged evidence.

## Step 4 r2 — first release follows the exit evaluation

The r1 exit loop closed an open refusal episode on a validated book before TEC ran. A crossed bid/ask of 383/382.5 passed the book-state predicate, supplied no armed TEC trigger, and took the release as `unpriced`. The crossed-then-priced regression failed on r1 at the open-episode assertion. The r2 loop carries the current guard's pre-advance evidence to TEC and settles the refusal episode only after a decision. A price-level hold that TEC actually evaluates counts. A missing trigger and a TEC discontinuity deferral leave the episode open. The guard-off mark arm can decide and end the episode, but that decision is unmatched because the guard assessed no comparator. The recorded bid-to-stop distance uses the guarded book's bid as D2 specifies. It is separate from the exit trigger on a mark arm.

```ts
if (xsFrame && decision.noDecisionReason === undefined && !decision.priceLevelChecksDeferred) {
  const tally = readPositionExitRefusal(this._exitRefusalTally, position);
  const evaluation = xsFrame.releaseEvaluation;
  const releaseBid = evaluation ? xsFrame.bid : null;
  if (tally && noteRelease(tally, releaseBid, stopLoss, Date.now(), evaluation ?? undefined)) {
    // Flush the same position episode's near-miss evidence and log its matched release.
  }
}
```

TEC exposes the existing discontinuity deferral on its trailing no-exit result. Trigger selection, level checks, state updates and close requests use the same inputs and branches. All 352 offline tests passed across 18 related suites. The checks cover a crossed quote followed by a priced stop or a priced hold, the guard-off mark stop, and actual TEC cold-start and halt-resume deferrals with a steady-state control. The exact candidate changes no storage contract, thresholds or warning delivery. The historical storage and warning checks above remain acceptance conditions.

`REVIEWER: claim-only · which first TEC results can end the restored-ring episode? · HIT: guard-off mark decision, discontinuity deferral, prior distance on an unpriced release · re-derived y`

## Step 4 r3 — venue freeze and latest release distance

The trailing controller now marks its existing venue-freeze return as deferred. TEC carries that fact on its no-exit result, just as it carries the discontinuity deferral. The frozen tick without trailing state leaves the episode open. The eligible reopening tick still requests the original stop. The existing terminal branches take precedence, including when the stop checker returned a terminal decision with previously initialized state. This change reports the controller result without changing the checks it runs.

```ts
return {
  shouldExit: false,
  exitReason: null,
  exitPrice: currentPrice,
  ...(discontinuity.active || update.priceLevelChecksDeferred ? { priceLevelChecksDeferred: true as const } : {}),
  newStopPrice: update.newStopPrice,
  // Other existing trailing evidence follows unchanged.
};
```

`noteRelease` writes null to the latest release distance when there is no eligible bid/stop pair. Only a priced release updates the minimum. The engine log and close metadata therefore read the same latest distance. The retained-ring tests exercise a priced hold followed by a guard-off mark stop on the same position, confirming the mark stop's price, null latest distance, preserved historical minimum, and preserved matched-release evidence. The freeze and stale-distance regressions both failed on r2 before implementation. The related offline set passed 371 tests across 19 suites.

## Review question

Does this exact Step 4 revision carry the venue freeze through to the first eligible release and preserve both the latest and historical release evidence without changing exit decisions or prices? The r1 writer-ordering and warning-recurrence controls and r2 crossed-book controls carry forward. Staged role, rollback, timing and live delivery remain separate acceptance gates. #1191 has its own joint staging return. A14's serving receipt remains unproved.
