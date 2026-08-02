/**
 * Build the in-memory match-set from the indexed targets. hash160s come from
 * every dataset that has one (coinbase, richlist, puzzle P2PKH); pubkeys come
 * from P2PK targets (early coinbase, exposed puzzles) so the grinder can match a
 * bare public key directly.
 */
import { openDb } from '../db';
import { emptyMatchSet, type MatchSet } from './matchset';

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

/** Resolve a match back to its target row (for balance + address + claim). */
export function findTargetByMatch(
  matched: string,
  kind: string
): { id: number; address: string; script_hex: string | null; hash160: string | null; dataset: string } | null {
  const db = openDb();
  const col = kind === 'pubkey' ? 'pubkey' : 'hash160';
  const row = db
    .prepare(
      `SELECT id, address, script_hex, hash160, dataset FROM target WHERE ${col} = ? COLLATE NOCASE LIMIT 1`
    )
    .get(matched) as
    | { id: number; address: string; script_hex: string | null; hash160: string | null; dataset: string }
    | undefined;
  return row ?? null;
}
