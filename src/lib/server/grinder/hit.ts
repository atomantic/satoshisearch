/**
 * The one path a recovered private key takes, whatever found it.
 *
 * Encrypt to the vault (never persist plaintext), write the audit record, file
 * the owner-claim so funds can be returned, hand off to the sweeper for policy,
 * then notify. Every discovery engine — sequential grinder, kangaroo — calls
 * this; a second copy is how the two drift apart on the details that matter.
 */
import { openDb, nowSec } from '../db';
import type { Bucket } from '../config';
import { scriptForTarget } from '../script';
import { scriptBalance } from '../mempool';
import { encryptKey } from '../rescue/vault';
import { audit } from '../rescue/audit';
import { handleHit } from '../rescue/sweeper';
import { notifyRescue } from '../rescue/notify';
import type { TargetMatch } from './loadset';
import type { SweepDecision } from '../rescue/sweeper';

export type Discovery = {
  /** Names the engine + source, e.g. 'coldcard-2026' or 'kangaroo-puzzle-135'. */
  sourceName: string;
  bucket: Bucket;
  /** Reproduces the find, e.g. 'kangaroo:#135:ops=1234'. */
  origin: string;
  matchKind: string;
  matched: string;
  privHex: string;
  /** Merged into the hit-found audit record (engine-specific context). */
  extra?: Record<string, unknown>;
  /** Used only when the target row has no balance of its own. */
  fallbackBalance?: number;
};

export async function recordHit(
  d: Discovery,
  target: TargetMatch | null
): Promise<SweepDecision> {
  const db = openDb();

  // Snapshot balance from the richlist/index (may be a day old); live node is truth.
  const snapshotBalance = target?.last_balance ?? null;
  const script = target ? scriptForTarget(target) : null;
  let liveBalance: number | null = null;
  if (script) {
    try {
      liveBalance = await scriptBalance(script);
    } catch (e) {
      // Sweep policy is about to run on a stale number — say so in the log.
      liveBalance = null;
      audit('hit-balance-stale', { origin: d.origin, reason: String(e) });
    }
  }
  // Prefer live when available; fall back to snapshot for audit/context only.
  // Sweeper still re-fetches UTXOs before any broadcast.
  const balance = liveBalance ?? snapshotBalance ?? d.fallbackBalance ?? 0;

  audit('hit-found', {
    source: d.sourceName,
    bucket: d.bucket,
    origin: d.origin,
    matchKind: d.matchKind,
    matched: d.matched,
    address: target?.address ?? null,
    dataset: target?.dataset ?? null,
    balanceSats: balance,
    snapshotBalanceSats: snapshotBalance,
    liveBalanceSats: liveBalance,
    balanceSource: liveBalance !== null ? 'live' : snapshotBalance !== null ? 'snapshot' : 'none',
    ...d.extra
  });

  // Encrypt and store the key. If the vault isn't configured we still record
  // the hit's existence in the audit log, but never persist plaintext.
  let privEnc = '';
  try {
    privEnc = encryptKey(d.privHex);
  } catch (e) {
    audit('hit-store-failed', { origin: d.origin, reason: String(e) });
  }

  const hitId = (
    db
      .prepare(
        `INSERT INTO hit (target_id, source_name, bucket, found_at, address, privkey_enc, balance_at_find, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'held') RETURNING id`
      )
      .get(
        target?.id ?? null,
        d.sourceName,
        d.bucket,
        nowSec(),
        target?.address ?? null,
        privEnc || 'UNSTORED',
        balance
      ) as { id: number }
  ).id;

  // File the owner-claim record so funds can be returned later.
  db.prepare(
    `INSERT INTO claim (hit_id, original_address, original_script, balance, discovery_method, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(hitId, target?.address ?? null, script, balance, d.origin, nowSec());

  // Hand off to the sweeper, which enforces policy (bucket, attestation,
  // dust, dry-run, destination) and updates the hit status.
  const decision = await handleHit(hitId, d.bucket, balance, d.privHex, target, privEnc !== '');

  // Realtime ops: webhook / notify file / shell hook (best-effort).
  void notifyRescue({
    event: 'hit-found',
    ts: nowSec(),
    source: d.sourceName,
    bucket: d.bucket,
    origin: d.origin,
    address: target?.address ?? null,
    balanceSats: balance,
    matchKind: d.matchKind,
    status: decision.action,
    action: decision.action,
    reason: decision.reason,
    txid: decision.txid ?? null
  });

  return decision;
}
