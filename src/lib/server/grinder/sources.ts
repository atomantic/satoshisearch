/**
 * Candidate-key sources for the grinder.
 *
 * Every source is a bounded key space with a resumable cursor, so the UI can
 * show honest "% of this space exhausted" progress and feed it into the keyspace
 * view. A source yields 32-byte private keys; the worker derives pubkeys and
 * matches. The honest framing (stated in the UI): unbounded grinding never
 * succeeds — 2^72 alone is ~10^8 years at 10^6 keys/s — so value comes only from
 * sources whose *effective* space is small (weak-key classes), plus monitoring.
 */
import { sha256 } from '@noble/hashes/sha256';
import type { Bucket } from '../config';

export interface KeyCandidate {
  /** 32-byte big-endian private key. */
  priv: Uint8Array;
  /** Human-readable provenance for audit/claim records (e.g. the phrase, the index). */
  origin: string;
}

export interface GrindSource {
  name: string;
  bucket: Bucket;
  /** log2 of the searchable space (may be an estimate). */
  spaceBits: number;
  /** Total candidates if finite and small enough to count, else null. */
  size: bigint | null;
  /** Yield candidates starting at `cursor` (a source-defined position). */
  generate(cursor: bigint, limit: number): { items: KeyCandidate[]; nextCursor: bigint; done: boolean };
}

const CURVE_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cc8502f15');

function bigToPriv(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Valid secp256k1 keys are in [1, n-1]. */
function inRange(n: bigint): boolean {
  return n > 0n && n < CURVE_N;
}

/**
 * puzzle-range: sequentially enumerate [2^(n-1), 2^n) for a target puzzle. This
 * is a genuine 2^(n-1)-wide space — infeasible to exhaust for n>=71, but exposed
 * so the UI can show progress and target the frontier (71/72).
 */
export function puzzleRangeSource(n: number): GrindSource {
  const lo = 1n << BigInt(n - 1);
  const hi = 1n << BigInt(n);
  return {
    name: `puzzle-range-${n}`,
    bucket: 'puzzle',
    spaceBits: n - 1,
    size: hi - lo,
    generate(cursor, limit) {
      const start = lo + cursor;
      const items: KeyCandidate[] = [];
      let k = start;
      for (let i = 0; i < limit && k < hi; i++, k++) {
        if (inRange(k)) items.push({ priv: bigToPriv(k), origin: `puzzle${n}:0x${k.toString(16)}` });
      }
      return { items, nextCursor: k - lo, done: k >= hi };
    }
  };
}

/**
 * brainwallet: SHA256 of each passphrase is the private key (the classic
 * brainwallet construction). The genuinely realistic rescue class — real people
 * lost real coins this way. Cursor indexes into the phrase list.
 */
export function brainwalletSource(phrases: string[]): GrindSource {
  return {
    name: 'brainwallet',
    bucket: 'brainwallet',
    spaceBits: Math.log2(Math.max(phrases.length, 1)),
    size: BigInt(phrases.length),
    generate(cursor, limit) {
      const items: KeyCandidate[] = [];
      let i = Number(cursor);
      for (; i < phrases.length && items.length < limit; i++) {
        const priv = sha256(new TextEncoder().encode(phrases[i]));
        const n = BigInt('0x' + Buffer.from(priv).toString('hex'));
        if (inRange(n)) items.push({ priv, origin: `brain:${JSON.stringify(phrases[i]).slice(0, 60)}` });
      }
      return { items, nextCursor: BigInt(i), done: i >= phrases.length };
    }
  };
}

/**
 * constants: walk the digits of a mathematical constant, taking successive
 * substrings as the private key (the bitfinderlite construction — people have
 * used "the first N digits of pi" as a key). Cursor = digit offset.
 */
export function constantsSource(name: string, digits: string, windowLen = 64): GrindSource {
  const enc = new TextEncoder();
  return {
    name: `constants-${name}`,
    bucket: 'constants',
    spaceBits: Math.log2(Math.max(digits.length, 1)),
    size: BigInt(Math.max(digits.length - windowLen, 0)),
    generate(cursor, limit) {
      const items: KeyCandidate[] = [];
      let i = Number(cursor);
      for (; i + 1 <= digits.length && items.length < limit; i++) {
        // Two interpretations people actually used: decimal-substring and its
        // hash. Use the SHA256 of the digit substring for a valid 32-byte key.
        const sub = digits.slice(i, i + windowLen);
        const priv = sha256(enc.encode(sub));
        const n = BigInt('0x' + Buffer.from(priv).toString('hex'));
        if (inRange(n)) items.push({ priv, origin: `const:${name}@${i}` });
      }
      return { items, nextCursor: BigInt(i), done: i + 1 > digits.length };
    }
  };
}

/**
 * lowentropy: small integer keys and simple patterns (1, 2, 3, … repeated
 * bytes, byte-fills). Trivially exhaustible; catches the "private key = 1" class.
 */
export function lowEntropySource(max = 1_000_000): GrindSource {
  return {
    name: 'lowentropy',
    bucket: 'lowentropy',
    spaceBits: Math.log2(max),
    size: BigInt(max),
    generate(cursor, limit) {
      const items: KeyCandidate[] = [];
      let k = cursor === 0n ? 1n : cursor;
      const end = BigInt(max);
      for (; k <= end && items.length < limit; k++) {
        if (inRange(k)) items.push({ priv: bigToPriv(k), origin: `lowentropy:${k}` });
      }
      return { items, nextCursor: k, done: k > end };
    }
  };
}
