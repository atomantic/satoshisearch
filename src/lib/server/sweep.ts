/**
 * Balance sweep scanner (read-only monitoring — not to be confused with the
 * rescue *sweeper* that moves funds). Walks a set of targets, reads each net
 * balance by script hash, records changes as balance_events, and updates the
 * target's status. This is what powers "a Satoshi-era coin just moved" alerts.
 *
 * Measured throughput on the dev node: ~3.6 ms/address at concurrency 8, so a
 * full 22K dormant sweep completes in ~1.3 minutes.
 */
import { openDb, nowSec } from './db';
import { scriptBalance, tipHeight, mapPool } from './mempool';

export interface SweepResult {
  scanned: number;
  changed: number;
  moved: Array<{ id: number; address: string; oldBalance: number; newBalance: number }>;
  elapsedMs: number;
}

type Dataset = 'coinbase' | 'dormant' | 'puzzle';

interface TargetRow {
  id: number;
  address: string;
  script_hex: string;
  last_balance: number | null;
  status: string;
}

/**
 * Sweep every target in the given datasets (default: the Satoshi-era coinbase
 * set). `onlyFunded` restarts from known-funded targets for a fast re-check.
 */
export async function sweep(opts?: {
  datasets?: Dataset[];
  onlyFunded?: boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<SweepResult> {
  const db = openDb();
  const datasets = opts?.datasets ?? ['coinbase', 'dormant'];
  const started = Date.now();

  const placeholders = datasets.map(() => '?').join(',');
  const fundedClause = opts?.onlyFunded ? 'AND last_balance > 0' : '';
  const rows = db
    .prepare(
      `SELECT id, address, script_hex, last_balance, status
       FROM target
       WHERE dataset IN (${placeholders}) AND script_hex IS NOT NULL ${fundedClause}
       ORDER BY id`
    )
    .all(...datasets) as unknown as TargetRow[];

  const height = await tipHeight().catch(() => null);

  const recordEvent = db.prepare(
    `INSERT INTO balance_event (target_id, ts, height, old_balance, new_balance, txid)
     VALUES (?, ?, ?, ?, ?, NULL)`
  );
  const updateTarget = db.prepare(
    `UPDATE target SET last_balance = ?, first_balance = COALESCE(first_balance, ?), last_checked_at = ?, status = ? WHERE id = ?`
  );

  const moved: SweepResult['moved'] = [];
  let scanned = 0;
  let changed = 0;

  // Fetch balances concurrently; collect deltas, then commit DB writes in one tx.
  const now = nowSec();
  const results = await mapPool(
    rows,
    async (r) => {
      const bal = await scriptBalance(r.script_hex).catch(() => null);
      scanned++;
      opts?.onProgress?.(scanned, rows.length);
      return { r, bal };
    },
    // sweep can push a bit harder than indexing; balances are single-request.
    12
  );

  const tx = db.prepare('BEGIN');
  tx.run();
  try {
    for (const { r, bal } of results) {
      if (bal === null) continue; // transient error; leave prior value intact
      const prev = r.last_balance;
      const status = bal === 0 ? (prev && prev > 0 ? 'moved' : 'empty') : 'untouched';
      if (prev === null || prev !== bal) {
        changed++;
        recordEvent.run(r.id, now, height, prev, bal);
        if (prev !== null && prev > 0 && bal < prev) {
          moved.push({ id: r.id, address: r.address, oldBalance: prev, newBalance: bal });
        }
      }
      updateTarget.run(bal, bal, now, status, r.id);
    }
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }

  return { scanned, changed, moved, elapsedMs: Date.now() - started };
}
