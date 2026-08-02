/**
 * Rescue sweeper — decides what happens when the grinder finds a funded key, and
 * (only when policy allows) builds, signs, and broadcasts a transaction moving
 * the funds to the configured rescue address.
 *
 * Policy gates, in order — any failure holds the hit and alerts instead:
 *   1. balance > 0 and above the dust floor (fees mustn't exceed value)
 *   2. a rescue destination is configured (else there's nowhere safe to send)
 *   3. the bucket is auto-sweep enabled (default: puzzle only)
 *   4. non-puzzle buckets additionally require the white-hat attestation
 *   5. not in global dry-run (the default) — dry-run builds+signs but never casts
 *
 * Everything that happens is audited BEFORE the broadcast, so provenance can
 * never be lost to a crash mid-sweep.
 */
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { openDb, nowSec } from '../db';
import type { Bucket } from '../config';
import { effectiveRescue, mayAutoSweep } from '../settings';
import { classifyScript, scriptForTarget, hash160, bytesToHex, hexToBytes } from '../script';
import { recommendedFees, broadcastTx, scriptUtxos, getTxHex } from '../mempool';
import { audit } from './audit';

interface TargetInfo {
  id: number;
  address: string;
  script_hex: string | null;
  script_type?: string | null;
  hash160: string | null;
  dataset: string;
}

export interface SweepDecision {
  action: 'swept' | 'dry-run' | 'held';
  reason: string;
  txid?: string;
}

/**
 * Called by the engine for each hit. Enforces policy and updates the hit's
 * status. Returns the decision for logging/UI.
 */
export async function handleHit(
  hitId: number,
  bucket: Bucket,
  balance: number,
  privHex: string,
  target: TargetInfo | null,
  keyStored: boolean
): Promise<SweepDecision> {
  const decision = await decide(bucket, balance, privHex, target);
  const db = openDb();

  const status =
    decision.action === 'swept' ? 'swept' : decision.action === 'dry-run' ? 'dry-run' : 'held';
  db.prepare(`UPDATE hit SET status=? WHERE id=?`).run(status, hitId);
  if (decision.txid) {
    db.prepare(`UPDATE claim SET sweep_txid=?, dest_address=?, resolved_at=? WHERE hit_id=?`).run(
      decision.txid,
      effectiveRescue().destAddress,
      nowSec(),
      hitId
    );
  }

  audit('sweep-decision', {
    hitId,
    bucket,
    balanceSats: balance,
    action: decision.action,
    reason: decision.reason,
    txid: decision.txid ?? null,
    keyStored
  });
  return decision;
}

async function decide(
  bucket: Bucket,
  balance: number,
  privHex: string,
  target: TargetInfo | null
): Promise<SweepDecision> {
  const rescue = effectiveRescue();
  if (balance <= 0) return { action: 'held', reason: 'no balance' };
  if (balance < rescue.dustSats)
    return { action: 'held', reason: `below dust floor (${rescue.dustSats} sats)` };
  if (!rescue.destAddress)
    return { action: 'held', reason: 'no rescue destination configured (fail-safe hold)' };
  if (!mayAutoSweep(bucket)) {
    const why =
      bucket === 'puzzle'
        ? 'puzzle bucket not enabled'
        : `bucket "${bucket}" needs enabling + white-hat attestation`;
    return { action: 'held', reason: `auto-sweep not permitted: ${why}` };
  }

  // Build + sign the rescue tx. In dry-run we stop before broadcasting.
  let signedHex: string;
  let txid: string;
  try {
    const built = await buildSweepTx(privHex, target);
    signedHex = built.hex;
    txid = built.txid;
  } catch (e) {
    return { action: 'held', reason: `tx build failed: ${String(e)}` };
  }

  if (rescue.dryRun) {
    return { action: 'dry-run', reason: 'SWEEP_DRY_RUN is on; signed but not broadcast', txid };
  }

  try {
    const broadcastId = await broadcastTx(signedHex);
    return { action: 'swept', reason: 'broadcast to node', txid: broadcastId };
  } catch (e) {
    return { action: 'held', reason: `broadcast failed: ${String(e)}` };
  }
}

/**
 * Build and sign a transaction sweeping every confirmed UTXO of the matched
 * script to the rescue destination.
 *
 * Supports P2PKH and P2WPKH inputs — which covers every realistic rescue class
 * (all 256 puzzles are P2PKH; richlist/brainwallet/coldcard are P2PKH or segwit).
 * **P2PK is intentionally not auto-swept**: @scure/btc-signer refuses bare P2PK,
 * and P2PK here means Satoshi-era coinbase coins, which must never be moved
 * automatically. Those hits are held with the key in the vault for manual review.
 *
 * Legacy inputs are signed with the previous transaction bytes as nonWitnessUtxo
 * (fetched from the node). The pubkey encoding (compressed/uncompressed) is
 * chosen to match the target's hash160.
 */
async function buildSweepTx(
  privHex: string,
  target: TargetInfo | null
): Promise<{ hex: string; txid: string }> {
  if (!target) throw new Error('no target for matched key');
  const script = scriptForTarget(target);
  if (!script) throw new Error('cannot determine source script');

  const cls = classifyScript(script);
  if (cls.type === 'p2pk') {
    throw new Error('P2PK inputs are not auto-swept (Satoshi-era coins) — held for manual review');
  }
  if (cls.type !== 'p2pkh' && cls.type !== 'p2wpkh') {
    throw new Error(`unsupported input type for auto-sweep: ${cls.type}`);
  }

  const priv = hexToBytes(privHex);
  const point = secp256k1.ProjectivePoint.fromPrivateKey(priv);
  const pubComp = point.toRawBytes(true);
  const pubUncomp = point.toRawBytes(false);
  // Pick the encoding whose hash160 the address actually commits to.
  const targetH160 = (target.hash160 ?? cls.hash160 ?? '').toLowerCase();
  const pub =
    bytesToHex(hash160(pubComp)) === targetH160
      ? pubComp
      : bytesToHex(hash160(pubUncomp)) === targetH160
        ? pubUncomp
        : pubComp; // fall back to compressed if we can't disambiguate

  const utxos = (await scriptUtxos(script)).filter((u) => u.status?.confirmed);
  if (!utxos.length) throw new Error('no confirmed UTXOs to sweep');
  const total = utxos.reduce((a, u) => a + u.value, 0);

  const tx = new btc.Transaction();
  for (const u of utxos) {
    const base = { txid: u.txid, index: u.vout };
    if (cls.type === 'p2pkh') {
      const prevHex = await getTxHex(u.txid);
      tx.addInput({ ...base, ...btc.p2pkh(pub), nonWitnessUtxo: hexToBytes(prevHex) });
    } else {
      // p2wpkh: witnessUtxo is sufficient (script + amount).
      tx.addInput({ ...base, ...btc.p2wpkh(pub), witnessUtxo: { script: hexToBytes(script), amount: BigInt(u.value) } });
    }
  }

  // Fee: fastest rate × estimated vsize. Legacy ~148 vB/in, segwit ~68 vB/in.
  const feeRate = (await recommendedFees().catch(() => ({ fastestFee: 5 }))).fastestFee;
  const perIn = cls.type === 'p2pkh' ? 148 : 68;
  const vbytes = utxos.length * perIn + 34 + 10;
  const fee = Math.max(vbytes * feeRate, 250);
  const sendValue = total - fee;
  if (sendValue <= 0) throw new Error('fee exceeds balance');

  tx.addOutputAddress(effectiveRescue().destAddress, BigInt(sendValue), btc.NETWORK);
  tx.sign(priv);
  tx.finalize();
  return { hex: hex.encode(tx.extract()), txid: tx.id };
}
