/**
 * The grinder match-set and the per-candidate matcher hot loop.
 *
 * Fixes the original bitfinder bug: it derived only *compressed* pubkeys, so it
 * could never have matched Satoshi's uncompressed P2PK keys. Here every candidate
 * is checked as:
 *   - compressed pubkey  → hash160 → hash160 set   (modern P2PKH / richlist)
 *   - uncompressed pubkey → hash160 → hash160 set   (early P2PKH)
 *   - raw pubkey hex (both forms) → pubkey set      (P2PK outputs directly)
 *
 * Base58 encoding is skipped entirely except on a hit — the hot loop only does
 * EC point-mul + hashes + Set lookups.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { hash160, bytesToHex } from '../script';
import type { KeyCandidate } from './sources';

export interface MatchSet {
  /** hash160 hex → true, covering coinbase/richlist/puzzle P2PKH targets. */
  hash160s: Set<string>;
  /** raw pubkey hex (compressed and/or uncompressed) → true, for P2PK targets. */
  pubkeys: Set<string>;
  size: number;
}

export interface Match {
  privHex: string;
  origin: string;
  kind: 'hash160-compressed' | 'hash160-uncompressed' | 'pubkey';
  matched: string; // the hash160 or pubkey hex that matched
}

export function emptyMatchSet(): MatchSet {
  return { hash160s: new Set(), pubkeys: new Set(), size: 0 };
}

/** Check one candidate against the set. Returns a Match or null. */
export function matchCandidate(cand: KeyCandidate, set: MatchSet): Match | null {
  // Derive the public point once, then read both encodings from it.
  let pub;
  try {
    pub = secp256k1.ProjectivePoint.fromPrivateKey(cand.priv);
  } catch {
    return null; // invalid scalar (0 or >= n) — skip
  }
  const compressed = pub.toRawBytes(true);
  const uncompressed = pub.toRawBytes(false);

  // P2PK: match the raw pubkey directly (both forms).
  if (set.pubkeys.size) {
    const cHex = bytesToHex(compressed);
    if (set.pubkeys.has(cHex)) return hit(cand, 'pubkey', cHex);
    const uHex = bytesToHex(uncompressed);
    if (set.pubkeys.has(uHex)) return hit(cand, 'pubkey', uHex);
  }

  // P2PKH: hash160 of each encoding.
  const cH = bytesToHex(hash160(compressed));
  if (set.hash160s.has(cH)) return hit(cand, 'hash160-compressed', cH);
  const uH = bytesToHex(hash160(uncompressed));
  if (set.hash160s.has(uH)) return hit(cand, 'hash160-uncompressed', uH);

  return null;
}

function hit(cand: KeyCandidate, kind: Match['kind'], matched: string): Match {
  return { privHex: bytesToHex(cand.priv), origin: cand.origin, kind, matched };
}
