import { once } from 'node:events';
import { BOOK_STATE_KNOBS, BOOK_STATE_MODULE } from '../../../asset_classes/xstock_spot/book-state.js';
import { _seedModuleCacheForTests } from '../../../services/module-constants-service.js';
import {
  _peekRetainedRingForTest, _resetBookStateComparatorsForTest, restoreRetainedRings, snapshotRetainableRings,
} from '../../../asset_classes/xstock_spot/book-state-tracker.js';
import { flushRingSnapshotOnShutdown, restoreRingsAtBoot } from '../../../asset_classes/xstock_spot/book-state-ring-store.js';
import { pool } from '../../../db.js';

const symbol = 'D1-PROCESS/USD';
const database = new URL((pool as { options?: { connectionString?: string } }).options?.connectionString ?? '');
if (!['127.0.0.1', 'localhost', 'postgres'].includes(database.hostname) || database.pathname !== '/test' ||
    !/^-c search_path=b_ring_process_[0-9a-f]{16}$/.test(process.env.PGOPTIONS ?? '')) {
  throw new Error('The retained-ring process fixture requires a local test database');
}
const { rows: [target] } = await pool.query('SELECT current_database() AS name, current_schema() AS schema');
if (target.name !== 'test' || `-c search_path=${target.schema}` !== process.env.PGOPTIONS) {
  throw new Error('The retained-ring process fixture missed its private schema');
}
_seedModuleCacheForTests(BOOK_STATE_MODULE, BOOK_STATE_KNOBS.map(constantName => ({
  moduleName: BOOK_STATE_MODULE, constantName, exchange: '*', assetClass: 'xstock_spot',
  strategy: '*', regime: '*', value: 10, updatedAt: new Date(), updatedBy: null,
})));

if (await restoreRingsAtBoot() !== 1) throw new Error('Expected one ring to restore');
if (process.argv[2] === 'writer') {
  const [restored] = snapshotRetainableRings();
  _resetBookStateComparatorsForTest();
  restoreRetainedRings([{ ...restored, spreads: [0.04], writtenAtMs: 3_000, persistedAtMs: 2_000 }]);
  const shutdown = once(process.stdin, 'data');
  console.log('D1_PROCESS_READY');
  await shutdown;
  await flushRingSnapshotOnShutdown();
} else {
  const ring = _peekRetainedRingForTest(symbol);
  if (!ring?.restored) throw new Error('Expected symbol absent from restored rings');
  const { spreads, writtenAtMs, persistedAtMs } = ring;
  console.log(`D1_PROCESS_RESTORED ${JSON.stringify({ spreads, writtenAtMs, persistedAtMs })}`);
}
process.exit(0);
