import { randomUUID } from 'node:crypto';
import type { AddAlertOptions, SystemAlert } from '../../services/system-alerts.js';

export const RING_SNAPSHOT_ALERT_KEY = 'book-state-ring-snapshot-failing';
export const RING_WARNING_AFTER_MS = 300_000;
const WARNING_RETRY_MS = 30_000;
const MAX_WARNING_RETRY_MS = 120_000;

export type RingSymbolSettlement =
  | { symbol: string; outcome: 'confirmed' | 'superseded'; durableVersion: string }
  | { symbol: string; outcome: 'rejected' | 'unknown' };

interface WarningLedger {
  addAlert(opts: AddAlertOptions): Promise<SystemAlert>;
  readAllAlerts(): SystemAlert[];
}

interface Incident {
  id: string;
  rowId?: string;
  retryAt: number;
  retryDelay: number;
  attempted: boolean;
  recovery: Map<string, string>;
}

/** Latest unsaved invocation per symbol, plus one warning per unresolved incident. */
export class RingSnapshotMonitor {
  private readonly outstanding = new Map<string, { sequence: string; since: number }>();
  private incident: Incident | undefined;
  private appendInFlight = false;

  constructor(
    private readonly ledger: () => Promise<WarningLedger> = () => import('../../services/system-alerts.js'),
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}

  begin(sequence: string, symbols: readonly string[], startedAt: number): void {
    if (symbols.length === 0) return;
    this.incident ??= { id: randomUUID(), retryAt: 0, retryDelay: WARNING_RETRY_MS, attempted: false, recovery: new Map() };
    for (const symbol of symbols) {
      this.outstanding.set(symbol, { sequence, since: this.outstanding.get(symbol)?.since ?? startedAt });
    }
  }

  settle(sequence: string, results: readonly RingSymbolSettlement[]): void {
    const incident = this.incident;
    if (!incident) return;
    for (const result of results) {
      if (!('durableVersion' in result) || this.outstanding.get(result.symbol)?.sequence !== sequence) continue;
      this.outstanding.delete(result.symbol);
      if (incident.attempted) incident.recovery.set(result.symbol, result.durableVersion);
    }
    if (this.outstanding.size > 0) return;
    this.incident = undefined;
    if (incident.attempted) this.logRecovery(incident);
  }

  private logRecovery(incident: Incident): void {
    console.warn(`[3n.q8][RING_STORE] SNAPSHOT_RECOVERED ${JSON.stringify({
      incidentId: incident.id, warningId: incident.rowId ?? null,
      durable: Object.fromEntries(incident.recovery),
    })}`);
  }

  /** Called independently of snapshots, including while a database write hangs. */
  async checkWarning(): Promise<void> {
    const incident = this.incident;
    const now = this.monotonicNow();
    if (!incident || incident.rowId || this.appendInFlight || now < incident.retryAt) return;
    const oldest = Math.min(...Array.from(this.outstanding.values(), item => item.since));
    const elapsedMs = Math.floor(now - oldest);
    if (elapsedMs < RING_WARNING_AFTER_MS) return;

    const symbols = Array.from(this.outstanding.keys()).sort();
    incident.attempted = true;
    this.appendInFlight = true;
    try {
      const ledger = await this.ledger();
      let row: SystemAlert | undefined;
      try {
        row = await ledger.addAlert({
          triggers_at: new Date(),
          category: 'breakage',
          severity: 'warning',
          title: 'xStock book-state ring snapshots failing',
          body: `Snapshots for ${symbols.length} xStock symbols have unconfirmed saves. The oldest has waited ${elapsedMs} ms. ` +
            'Use verified durable recovery for these symbols to RESOLVE this row. Do not ACK this dedupe key.',
          dedupe_key: RING_SNAPSHOT_ALERT_KEY,
          metadata: { ringIncidentId: incident.id, elapsedMs, symbols },
        });
      } catch {
        // A failed return can follow a successful atomic rename.
        row = ledger.readAllAlerts().find(alert =>
          alert.dedupe_key === RING_SNAPSHOT_ALERT_KEY && alert.metadata?.ringIncidentId === incident.id);
      }
      if (row?.metadata?.ringIncidentId === incident.id) {
        incident.rowId = row.id;
        if (this.incident !== incident) this.logRecovery(incident);
      } else {
        console.warn(`[3n.q8][RING_STORE] SNAPSHOT_WARNING_RETRY incident=${incident.id} existing=${row?.id ?? 'none'} elapsedMs=${elapsedMs}`);
      }
    } catch (error) {
      console.warn('[3n.q8][RING_STORE] snapshot warning ledger unavailable:', error);
    } finally {
      incident.retryAt = this.monotonicNow() + incident.retryDelay;
      incident.retryDelay = Math.min(incident.retryDelay * 2, MAX_WARNING_RETRY_MS);
      this.appendInFlight = false;
    }
  }
}
