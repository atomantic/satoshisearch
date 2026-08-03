/**
 * Build the in-memory match-set from the indexed targets. hash160s come from
 * every dataset that has one (coinbase, richlist, puzzle P2PKH/P2WPKH); pubkeys
 * come from P2PK targets (early coinbase, exposed puzzles) so the grinder can
 * match a bare public key directly.
 *
 * Operators can scope the set via MatchSetFilter (see settings matchSet profile):
 * e.g. Satoshi-era coinbase only, puzzles only, or a custom mix — without
 * re-indexing. Sequential grind checks every generated key against this set;
 * kangaroo ignores it (single ECDLP target).
 */
import { openDb } from '../db';
import type { DatabaseSync } from 'node:sqlite';
import { emptyMatchSet, type MatchSet } from './matchset';

/** Datasets that contribute grinder match material (not hit buckets like coldcard). */
export const MATCH_DATASETS = ['coinbase', 'dormant', 'puzzle', 'richlist'] as const;
export type MatchDataset = (typeof MATCH_DATASETS)[number];

export type MatchSetFilter = {
  /** Which target datasets to include. Empty → no targets (empty set). */
  datasets: MatchDataset[];
  /**
   * When `puzzle` is in datasets: limit to these puzzle numbers.
   * Empty → all indexed puzzles.
   */
  puzzleNs: number[];
};

/** Full historical default: every indexed matchable target. */
export function allMatchSetFilter(): MatchSetFilter {
  return { datasets: [...MATCH_DATASETS], puzzleNs: [] };
}

export function isMatchDataset(v: string): v is MatchDataset {
  return (MATCH_DATASETS as readonly string[]).includes(v);
}

export function normalizeMatchDatasets(raw: unknown): MatchDataset[] {
  if (!Array.isArray(raw)) return [];
  const out: MatchDataset[] = [];
  for (const x of raw) {
    const s = String(x).trim().toLowerCase();
    if (isMatchDataset(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

export function normalizePuzzleNs(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const x of raw) {
    const n = typeof x === 'number' ? x : Number(String(x).trim());
    if (!Number.isInteger(n) || n < 1 || n > 256) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** Stable key for counts cache and audit. */
export function matchSetFilterKey(filter: MatchSetFilter): string {
  const ds = [...filter.datasets].sort().join(',');
  const ns = [...filter.puzzleNs].sort((a, b) => a - b).join(',');
  return `${ds}|${ns}`;
}

/** Human-readable one-liner for UI / readiness. */
export function describeMatchSetFilter(filter: MatchSetFilter): string {
  if (filter.datasets.length === 0) return 'none (empty)';
  const parts = filter.datasets.map((d) => {
    if (d === 'puzzle' && filter.puzzleNs.length) {
      return `puzzle #${filter.puzzleNs.join(',#')}`;
    }
    return d;
  });
  return parts.join(' + ');
}

/**
 * SQL fragment + bound params for `WHERE <fragment>` on `target` (alias `t` optional).
 * Table alias defaults to bare columns (no alias).
 */
export function matchSetSqlWhere(
  filter: MatchSetFilter,
  tableAlias = ''
): { sql: string; params: (string | number)[] } {
  const col = (name: string) => (tableAlias ? `${tableAlias}.${name}` : name);
  if (filter.datasets.length === 0) {
    return { sql: '0', params: [] };
  }
  // An all-datasets, no-puzzle-N filter is true for every row, but spelling it
  // out as `dataset IN (…)` makes SQLite pick idx_target_dataset and build a
  // temp b-tree instead of using the covering index on hash160 — ~15x slower
  // on the counts path, which the grinder page polls every 1.5s.
  if (MATCH_DATASETS.every((d) => filter.datasets.includes(d)) && filter.puzzleNs.length === 0) {
    return { sql: '1', params: [] };
  }
  const ph = filter.datasets.map(() => '?').join(',');
  let sql = `${col('dataset')} IN (${ph})`;
  const params: (string | number)[] = [...filter.datasets];

  if (filter.datasets.includes('puzzle') && filter.puzzleNs.length > 0) {
    const nPh = filter.puzzleNs.map(() => '?').join(',');
    sql += ` AND (${col('dataset')} != 'puzzle' OR ${col('id')} IN (SELECT target_id FROM puzzle WHERE n IN (${nPh})))`;
    params.push(...filter.puzzleNs);
  }
  return { sql, params };
}

export type MatchSetCounts = { hash160s: number; pubkeys: number; size: number };

/**
 * Cached because the grinder page re-runs its whole load every 1.5s while a
 * grind or kangaroo is running — for hours. The COUNT(DISTINCT pubkey) is a
 * full scan of ~800k rows (~140ms, and node:sqlite is synchronous, so that is
 * event-loop time), while the counts only change when the indexer writes.
 * Keyed by filter so profile switches don't show stale sizes.
 */
let countsCache: { at: number; key: string; value: MatchSetCounts } | null = null;
const COUNTS_TTL_MS = 30_000;

/** Drop the cached counts — call after any write to `target`. */
export function invalidateMatchSetCounts(): void {
  countsCache = null;
}

/**
 * Count distinct match keys without materializing them. The grinder page only
 * renders sizes; building two ~1M-entry Sets to read `.size` is pure waste.
 */
export function matchSetCounts(
  filter: MatchSetFilter = allMatchSetFilter(),
  db?: DatabaseSync
): MatchSetCounts {
  const handle = db ?? openDb();
  const key = matchSetFilterKey(filter);
  // Cache only for the process default DB (grinder page poll path).
  const useCache = db === undefined;
  if (
    useCache &&
    countsCache &&
    countsCache.key === key &&
    Date.now() - countsCache.at < COUNTS_TTL_MS
  ) {
    return countsCache.value;
  }
  const { sql, params } = matchSetSqlWhere(filter);
  const one = (col: string) =>
    (
      handle
        .prepare(
          `SELECT COUNT(DISTINCT ${col}) n FROM target WHERE ${col} IS NOT NULL AND (${sql})`
        )
        .get(...params) as { n: number }
    ).n;
  const hash160s = one('hash160');
  const pubkeys = one('pubkey');
  const value = { hash160s, pubkeys, size: hash160s + pubkeys };
  if (useCache) countsCache = { at: Date.now(), key, value };
  return value;
}

export function loadMatchSet(
  filter: MatchSetFilter = allMatchSetFilter(),
  db?: DatabaseSync
): MatchSet {
  const handle = db ?? openDb();
  const set = emptyMatchSet();
  const { sql, params } = matchSetSqlWhere(filter);

  for (const r of handle
    .prepare(`SELECT DISTINCT hash160 h FROM target WHERE hash160 IS NOT NULL AND (${sql})`)
    .iterate(...params) as Iterable<{ h: string }>) {
    set.hash160s.add(r.h.toLowerCase());
  }
  for (const r of handle
    .prepare(`SELECT DISTINCT pubkey p FROM target WHERE pubkey IS NOT NULL AND (${sql})`)
    .iterate(...params) as Iterable<{ p: string }>) {
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

/**
 * Resolve a match back to its target row (for balance + address + claim).
 * When `filter` is set, prefer a row in that match profile; fall back to any
 * matching target so hits still vault if the profile was later narrowed.
 */
export function findTargetByMatch(
  matched: string,
  kind: string,
  filter?: MatchSetFilter | null
): TargetMatch | null {
  const db = openDb();
  const col = kind === 'pubkey' ? 'pubkey' : 'hash160';
  const select = `SELECT id, address, script_hex, script_type, hash160, dataset, last_balance
       FROM target WHERE ${col} = ? COLLATE NOCASE`;

  if (filter && filter.datasets.length > 0) {
    const { sql, params } = matchSetSqlWhere(filter);
    const scoped = db
      .prepare(`${select} AND (${sql}) LIMIT 1`)
      .get(matched, ...params) as TargetMatch | undefined;
    if (scoped) return scoped;
  }

  const row = db.prepare(`${select} LIMIT 1`).get(matched) as TargetMatch | undefined;
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
