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
import type { Bucket } from '../config';
import type { ColdcardConfig, RngSpaceModel } from './coldcard';
import { CURVE_N, puzzleBounds } from './range-window';

export interface KeyCandidate {
  /** 32-byte big-endian private key. */
  priv: Uint8Array;
  /** Human-readable provenance for audit/claim records (e.g. the key index). */
  origin: string;
}

/**
 * Sequential scalar range for native/JS range mode — the grinder generates
 * priv = start + i for i in [0, count) inside the hot loop (no per-key IPC).
 */
export interface RangeBatch {
  /** Absolute private-key scalar for index 0 (big-endian as bigint). */
  start: bigint;
  count: number;
  /** Origin for index i: `${originPrefix}:0x${(start+i).toString(16)}` or custom. */
  originPrefix: string;
  /** If set, origin is `${originPrefix}:${start+i}` (decimal) — lowentropy style. */
  originDecimal?: boolean;
}

/**
 * What `size` / `spaceBits` measure for this source.
 * - sequential-keys: cursor walks private-key integers (puzzle, lowentropy)
 * - rng-states: cursor walks weak-RNG initial states; keys are derived and scattered
 */
export type SpaceKind = 'sequential-keys' | 'rng-states';

export interface GrindSource {
  name: string;
  bucket: Bucket;
  /**
   * log2 of the searchable *work units* (may be an estimate).
   * For rng-states this is log2(seed states), NOT "keys live in [0,2^b)".
   */
  spaceBits: number;
  /** Total work units if finite, else null. (Seed states for coldcard; keys for puzzle.) */
  size: bigint | null;
  /** How to interpret size / spaceBits. Default sequential-keys. */
  spaceKind?: SpaceKind;
  /** Human label for what spaceBits/size count, shown in the source picker. */
  spaceUnit?: string;
  /** Yield candidates starting at `cursor` (a source-defined position). */
  generate(cursor: bigint, limit: number): { items: KeyCandidate[]; nextCursor: bigint; done: boolean };
  /**
   * Optional sequential-range producer. When present and the pool supports
   * range mode, the engine uses this instead of materializing KeyCandidates.
   */
  rangeBatch?(
    cursor: bigint,
    limit: number
  ): { range: RangeBatch | null; nextCursor: bigint; done: boolean };
  /**
   * Weak-RNG sources expand a seed state into many keys, which is too expensive
   * to do on the engine thread — the engine ships the config to the workers
   * instead. Present iff `spaceKind === 'rng-states'`.
   */
  coldcardConfig?: ColdcardConfig;
  /** Dimension breakdown for the UI, derived from `coldcardConfig`. */
  rngSpace?: RngSpaceModel;
}

export function bigToPriv(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function privToBig(priv: Uint8Array): bigint {
  let n = 0n;
  for (const b of priv) n = (n << 8n) | BigInt(b);
  return n;
}

export function originForRange(range: RangeBatch, index: number): string {
  const n = range.start + BigInt(index);
  if (range.originDecimal) return `${range.originPrefix}:${n}`;
  return `${range.originPrefix}:0x${n.toString(16)}`;
}

/** Valid secp256k1 keys are in [1, n-1]. */
function inRange(n: bigint): boolean {
  return n > 0n && n < CURVE_N;
}

/**
 * puzzle-range: sequentially enumerate a window inside [2^(n-1), 2^n).
 * Default window is the full puzzle range. Pass `window` to claim a sub-range
 * (start offset + multi-machine shard) — see range-window.ts.
 *
 * Full 2^(n-1) spaces are infeasible to exhaust for n≥71; the source exists so
 * the UI can show progress, farm shards across hosts, and multi-match free lottery.
 */
export function puzzleRangeSource(
  n: number,
  window?: { start: bigint; end: bigint; label?: string }
): GrindSource {
  const { lo: fullLo, hi: fullHi } = puzzleBounds(n);
  const lo = window?.start ?? fullLo;
  const hi = window?.end ?? fullHi;
  if (hi <= lo) throw new Error(`puzzle-range-${n}: empty window`);
  if (lo < fullLo || hi > fullHi) {
    throw new Error(`puzzle-range-${n}: window outside [2^${n - 1}, 2^${n})`);
  }
  const size = hi - lo;
  const prefix = `puzzle${n}`;
  const winLabel = window?.label?.trim() || '';
  const name = winLabel ? `puzzle-range-${n}:${winLabel}` : `puzzle-range-${n}`;
  // Effective work bits for the claimed window (not always n-1).
  const spaceBits = size > 0n ? Number(size.toString(2).length - 1) : 0;
  return {
    name,
    bucket: 'puzzle',
    spaceBits: Math.max(0, spaceBits),
    size,
    spaceKind: 'sequential-keys',
    spaceUnit:
      lo === fullLo && hi === fullHi
        ? `keys in [2^${n - 1}, 2^${n})`
        : `keys in [0x${lo.toString(16)}, 0x${hi.toString(16)})`,
    generate(cursor, limit) {
      const start = lo + cursor;
      const items: KeyCandidate[] = [];
      let k = start;
      for (let i = 0; i < limit && k < hi; i++, k++) {
        if (inRange(k)) items.push({ priv: bigToPriv(k), origin: `${prefix}:0x${k.toString(16)}` });
      }
      return { items, nextCursor: k - lo, done: k >= hi };
    },
    rangeBatch(cursor, limit) {
      const start = lo + cursor;
      if (start >= hi) return { range: null, nextCursor: cursor, done: true };
      const remaining = hi - start;
      const count = remaining < BigInt(limit) ? Number(remaining) : limit;
      return {
        range: { start, count, originPrefix: prefix },
        nextCursor: cursor + BigInt(count),
        done: start + BigInt(count) >= hi
      };
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
    spaceKind: 'sequential-keys',
    spaceUnit: 'small-integer keys',
    generate(cursor, limit) {
      const items: KeyCandidate[] = [];
      let k = cursor === 0n ? 1n : cursor;
      const end = BigInt(max);
      for (; k <= end && items.length < limit; k++) {
        if (inRange(k)) items.push({ priv: bigToPriv(k), origin: `lowentropy:${k}` });
      }
      return { items, nextCursor: k, done: k > end };
    },
    rangeBatch(cursor, limit) {
      // Cursor semantics match generate: 0 means start at 1; otherwise cursor is next k.
      let k = cursor === 0n ? 1n : cursor;
      const end = BigInt(max);
      if (k > end) return { range: null, nextCursor: k, done: true };
      const remaining = end - k + 1n;
      const count = remaining < BigInt(limit) ? Number(remaining) : limit;
      return {
        range: { start: k, count, originPrefix: 'lowentropy', originDecimal: true },
        nextCursor: k + BigInt(count),
        done: k + BigInt(count) > end
      };
    }
  };
}
