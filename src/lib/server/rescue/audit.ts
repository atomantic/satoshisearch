/**
 * Tamper-evident audit log. Every security-relevant event (a hit found, a sweep
 * built/broadcast, config changes, attestations) is appended as a hash-chained
 * record: hash = sha256(prev_hash || seq || ts || event || payload). Any edit or
 * deletion of a past row breaks the chain, which `verifyAudit` detects.
 *
 * This is the backbone of the "so owners can prove ownership and be reimbursed"
 * requirement — the record of what was found and what was done with it must be
 * incorruptible.
 */
import { sha256 } from '@noble/hashes/sha256';
import { openDb, nowSec } from '../db';
import { bytesToHex } from '../script';

const GENESIS = '0'.repeat(64);

function chainHash(prev: string, seq: number, ts: number, event: string, payloadJson: string): string {
  const data = new TextEncoder().encode(`${prev}|${seq}|${ts}|${event}|${payloadJson}`);
  return bytesToHex(sha256(data));
}

/** Append an event; returns the new record's hash. */
export function audit(event: string, payload: Record<string, unknown>): string {
  const db = openDb();
  const ts = nowSec();
  const payloadJson = JSON.stringify(payload);

  // Serialize appends so concurrent writers can't fork the chain.
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    const last = db.prepare('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1').get() as
      | { seq: number; hash: string }
      | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prev = last?.hash ?? GENESIS;
    const hash = chainHash(prev, seq, ts, event, payloadJson);
    db.prepare('INSERT INTO audit (seq, ts, event, payload_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)').run(
      seq,
      ts,
      event,
      payloadJson,
      prev,
      hash
    );
    db.prepare('COMMIT').run();
    return hash;
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
}

export interface AuditVerification {
  ok: boolean;
  count: number;
  brokenAtSeq: number | null;
  reason: string | null;
}

/** Recompute the whole chain and confirm every link. */
export function verifyAudit(): AuditVerification {
  const db = openDb();
  const rows = db
    .prepare('SELECT seq, ts, event, payload_json, prev_hash, hash FROM audit ORDER BY seq')
    .all() as Array<{ seq: number; ts: number; event: string; payload_json: string; prev_hash: string; hash: string }>;

  let prev = GENESIS;
  let expectedSeq = 1;
  for (const r of rows) {
    if (r.seq !== expectedSeq) {
      return { ok: false, count: rows.length, brokenAtSeq: r.seq, reason: `sequence gap: expected ${expectedSeq}, got ${r.seq}` };
    }
    if (r.prev_hash !== prev) {
      return { ok: false, count: rows.length, brokenAtSeq: r.seq, reason: 'prev_hash mismatch (a prior record was altered or removed)' };
    }
    const recomputed = chainHash(r.prev_hash, r.seq, r.ts, r.event, r.payload_json);
    if (recomputed !== r.hash) {
      return { ok: false, count: rows.length, brokenAtSeq: r.seq, reason: 'record hash mismatch (this record was altered)' };
    }
    prev = r.hash;
    expectedSeq++;
  }
  return { ok: true, count: rows.length, brokenAtSeq: null, reason: null };
}

export interface AuditEntry {
  seq: number;
  ts: number;
  event: string;
  payload: Record<string, unknown>;
  hash: string;
}

export function recentAudit(limit = 100): AuditEntry[] {
  const db = openDb();
  const rows = db
    .prepare('SELECT seq, ts, event, payload_json, hash FROM audit ORDER BY seq DESC LIMIT ?')
    .all(limit) as Array<{ seq: number; ts: number; event: string; payload_json: string; hash: string }>;
  return rows.map((r) => ({
    seq: r.seq,
    ts: r.ts,
    event: r.event,
    payload: JSON.parse(r.payload_json),
    hash: r.hash
  }));
}
