/**
 * Build the in-memory match-set from the indexed targets. hash160s come from
 * every dataset that has one (coinbase, richlist, puzzle P2PKH/P2WPKH); pubkeys
 * come from P2PK targets (early coinbase, exposed puzzles) so the grinder can
 * match a bare public key directly.
 */
import { openDb } from '../db';
import { emptyMatchSet, type MatchSet } from './matchset';

export type MatchSetCounts = { hash160s: number; pubkeys: number; size: number };

/**
 * Cached because the grinder page re-runs its whole load every 1.5s while a
 * grind or kangaroo is running — for hours. The COUNT(DISTINCT pubkey) is a
 * full scan of ~800k rows (~140ms, and node:sqlite is synchronous, so that is
 * event-loop time), while the counts only change when the indexer writes.
 */
let countsCache: { at: number; value: MatchSetCounts } | null = null;
const COUNTS_TTL_MS = 30_000;

/** Drop the cached counts — call after any write to `target`. */
export function invalidateMatchSetCounts(): void {
  countsCache = null;
}

/**
 * Count distinct match keys without materializing them. The grinder page only
 * renders sizes; building two ~1M-entry Sets to read `.size` is pure waste.
 */
export function matchSetCounts(): MatchSetCounts {
  if (countsCache && Date.now() - countsCache.at < COUNTS_TTL_MS) return countsCache.value;
  const db = openDb();
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const hash160s = one(`SELECT COUNT(DISTINCT hash160) n FROM target WHERE hash160 IS NOT NULL`);
  const pubkeys = one(`SELECT COUNT(DISTINCT pubkey) n FROM target WHERE pubkey IS NOT NULL`);
  const value = { hash160s, pubkeys, size: hash160s + pubkeys };
  countsCache = { at: Date.now(), value };
  return value;
}

export function loadMatchSet(): MatchSet {
  const db = openDb();
  const set = emptyMatchSet();

  for (const r of db.prepare(`SELECT DISTINCT hash160 h FROM target WHERE hash160 IS NOT NULL`).iterate() as Iterable<{ h: string }>) {
    set.hash160s.add(r.h.toLowerCase());
  }
  for (const r of db.prepare(`SELECT DISTINCT pubkey p FROM target WHERE pubkey IS NOT NULL`).iterate() as Iterable<{ p: string }>) {
    set.pubkeys.add(r.p.toLowerCase());
  }
  set.size = set.hash160s.size + set.pubkeys.size;
  return set;
}

export type TargetMatch = {
  id: number;
  address: string;
  script_hex: string | null;
  script_type: string | null;
  hash160: string | null;
  dataset: string;
  last_balance: number | null;
};

/** Resolve a match back to its target row (for balance + address + claim). */
export function findTargetByMatch(matched: string, kind: string): TargetMatch | null {
  const db = openDb();
  const col = kind === 'pubkey' ? 'pubkey' : 'hash160';
  const row = db
    .prepare(
      `SELECT id, address, script_hex, script_type, hash160, dataset, last_balance
       FROM target WHERE ${col} = ? COLLATE NOCASE LIMIT 1`
    )
    .get(matched) as TargetMatch | undefined;
  return row ?? null;
}

export type RichlistSnapshot = {
  id: number;
  source: string;
  created_at: number;
  tip_height: number | null;
  min_sats: number;
  script_policy: string;
  row_count: number | null;
  note: string | null;
};

/** Latest richlist snapshot metadata, if any. */
export function latestRichlistSnapshot(): RichlistSnapshot | null {
  const db = openDb();
  const row = db
    .prepare(
      `SELECT id, source, created_at, tip_height, min_sats, script_policy, row_count, note
       FROM richlist_snapshot ORDER BY id DESC LIMIT 1`
    )
    .get() as RichlistSnapshot | undefined;
  return row ?? null;
}
