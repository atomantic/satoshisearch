import type { PageServerLoad, Actions } from './$types';
import { openDb } from '$server/db';
import { sweep } from '$server/sweep';
import { addressLink } from '$server/links';

interface Agg {
  total: number;
  funded: number;
  sats: number;
  lastChecked: number | null;
}

function loadState() {
  const db = openDb();
  const agg = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN last_balance > 0 THEN 1 ELSE 0 END) funded,
              COALESCE(SUM(last_balance), 0) sats,
              MAX(last_checked_at) lastChecked
       FROM target WHERE dataset IN ('coinbase','dormant')`
    )
    .get() as unknown as Agg;

  const indexedMax = db
    .prepare(`SELECT MAX(height) h FROM target WHERE dataset='coinbase'`)
    .get() as { h: number | null };

  // Most recent balance movements (a dormant coin waking up).
  const moves = db
    .prepare(
      `SELECT be.ts, be.old_balance old, be.new_balance new, t.address address, t.height height
       FROM balance_event be JOIN target t ON t.id = be.target_id
       WHERE be.old_balance IS NOT NULL AND be.new_balance < be.old_balance
       ORDER BY be.ts DESC LIMIT 25`
    )
    .all() as Array<{ ts: number; old: number; new: number; address: string; height: number }>;

  // A window of the largest still-untouched coinbase holdings.
  const topFunded = db
    .prepare(
      `SELECT address, height, last_balance bal, script_type type
       FROM target WHERE dataset IN ('coinbase','dormant') AND last_balance > 0
       ORDER BY height ASC LIMIT 40`
    )
    .all() as Array<{ address: string; height: number; bal: number; type: string }>;

  return {
    agg,
    indexedMaxHeight: indexedMax.h ?? -1,
    moves: moves.map((m) => ({ ...m, link: addressLink(m.address) })),
    topFunded: topFunded.map((t) => ({ ...t, link: addressLink(t.address) }))
  };
}

export const load: PageServerLoad = async () => {
  return loadState();
};

export const actions: Actions = {
  // On-demand re-check of currently-funded targets (fast).
  recheck: async () => {
    const res = await sweep({ onlyFunded: true });
    return { swept: res.scanned, changed: res.changed, moved: res.moved.length, elapsedMs: res.elapsedMs };
  }
};
