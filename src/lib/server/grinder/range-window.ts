/**
 * Sub-ranges of a puzzle (or any sequential key window) for multi-machine farming.
 *
 * Contiguous slabs keep RANGE mode efficient (the native walk advances by +G).
 * Each host claims shard i of n, and/or skips a start offset into the full range.
 *
 * Honest note on public progress (as of 2026):
 * - Historical LBC systematically covered *much* smaller bit depths (~40s), not 2^70.
 * - Public puzzle-71 pools (e.g. btcpuzzle.info) report on the order of ~1% scanned,
 *   not ~50%. Do not assume "halfway" without checking a live pool dashboard.
 * - Skipping is operator policy; this module never invents coverage claims.
 */
export type PuzzleBounds = {
  /** Inclusive: 2^(n-1) */
  lo: bigint;
  /** Exclusive: 2^n */
  hi: bigint;
  size: bigint;
};

export type RangeWindow = {
  /** Inclusive absolute private-key scalar */
  start: bigint;
  /** Exclusive absolute private-key scalar */
  end: bigint;
  size: bigint;
  /** Full puzzle bounds (for progress denominators / UI). */
  full: PuzzleBounds;
  /** Short label for source name / audit (empty if full range, no shard). */
  label: string;
  shardIndex: number | null;
  shardCount: number | null;
};

export type WindowSpec = {
  /** Absolute start key (hex, optional 0x). Clamped into the puzzle range. */
  startHex?: string | null;
  /** Absolute end key (hex, exclusive). Clamped. */
  endHex?: string | null;
  /** Start at this percent of the *full* puzzle range [0, 100]. */
  startPct?: number | null;
  /** End at this percent of the *full* puzzle range (0, 100]. */
  endPct?: number | null;
  /**
   * Contiguous shard of the window after start/end/pct are applied.
   * Machine i of n gets slab i (0-based).
   */
  shardIndex?: number | null;
  shardCount?: number | null;
};

/** secp256k1 group order — the exclusive upper bound for any valid scalar. */
export const CURVE_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cc8502f15'
);

/**
 * True when a spec actually narrows the range, rather than meaning "grind the
 * whole thing". This is the guard that decides whether a farm host claims one
 * shard or silently re-grinds the entire range, so it lives in exactly one
 * place — the CLI, the start form, and makeSource() all call this.
 */
export function isWindowSpecified(spec: WindowSpec | null | undefined): boolean {
  if (!spec) return false;
  const hasText = (v: string | null | undefined) => v != null && String(v).trim() !== '';
  const num = (v: number | null | undefined) =>
    v != null && Number.isFinite(Number(v)) ? Number(v) : null;
  const startPct = num(spec.startPct);
  const endPct = num(spec.endPct);
  const shardCount = num(spec.shardCount);
  return (
    hasText(spec.startHex) ||
    hasText(spec.endHex) ||
    (startPct != null && startPct > 0) ||
    (endPct != null && endPct < 100) ||
    (shardCount != null && shardCount > 1)
  );
}

export function puzzleBounds(n: number): PuzzleBounds {
  if (!Number.isInteger(n) || n < 1 || n > 256) {
    throw new Error(`puzzle n must be 1..256, got ${n}`);
  }
  const lo = 1n << BigInt(n - 1);
  const hi = 1n << BigInt(n);
  return { lo, hi, size: hi - lo };
}

/** Parse a hex scalar; returns null if empty/invalid. */
export function parseHexScalar(raw: string | null | undefined): bigint | null {
  if (raw == null) return null;
  const t = String(raw).trim().replace(/^0x/i, '');
  if (!t) return null;
  if (!/^[0-9a-fA-F]+$/.test(t)) return null;
  return BigInt('0x' + t);
}

export function formatHexScalar(n: bigint): string {
  return n.toString(16);
}

/** pct in [0, 100] → offset into size (0 .. size). */
export function pctOfSize(size: bigint, pct: number): bigint {
  if (!Number.isFinite(pct) || size <= 0n) return 0n;
  const p = Math.min(100, Math.max(0, pct));
  // size * p / 100 with micro-percent integer math
  const micros = BigInt(Math.round(p * 1_000_000));
  return (size * micros) / 100_000_000n;
}

function clampKey(k: bigint, full: PuzzleBounds): bigint {
  if (k < full.lo) return full.lo;
  if (k > full.hi) return full.hi;
  if (k >= CURVE_N) return full.hi;
  return k;
}

/**
 * Resolve a working window inside puzzle n.
 * Order: full range → start/end hex or pct → contiguous shard.
 */
export function resolvePuzzleWindow(n: number, spec: WindowSpec = {}): RangeWindow {
  const full = puzzleBounds(n);

  /** Absolute hex wins over percent; neither given → `fallback`. */
  const resolveEdge = (
    edge: 'start' | 'end',
    hex: string | null | undefined,
    pct: number | null | undefined,
    fallback: bigint
  ): bigint => {
    if (hex != null && String(hex).trim() !== '') {
      const v = parseHexScalar(hex);
      if (v == null) throw new Error(`invalid ${edge} hex: ${hex}`);
      return clampKey(v, full);
    }
    if (pct != null) return full.lo + pctOfSize(full.size, Number(pct));
    return fallback;
  };

  let start = resolveEdge('start', spec.startHex, spec.startPct, full.lo);
  let end = resolveEdge('end', spec.endHex, spec.endPct, full.hi);

  if (end <= start) {
    throw new Error(
      `empty range window: start=0x${formatHexScalar(start)} end=0x${formatHexScalar(end)}`
    );
  }

  let shardIndex: number | null = null;
  let shardCount: number | null = null;
  const sc = spec.shardCount != null ? Number(spec.shardCount) : 0;
  const si = spec.shardIndex != null ? Number(spec.shardIndex) : 0;
  if (Number.isInteger(sc) && sc > 1) {
    if (!Number.isInteger(si) || si < 0 || si >= sc) {
      throw new Error(`shard index must be 0..${sc - 1}, got ${spec.shardIndex}`);
    }
    shardCount = sc;
    shardIndex = si;
    const span = end - start;
    const base = span / BigInt(sc);
    const rem = span % BigInt(sc);
    // Distribute remainder to first `rem` shards so slabs stay contiguous and cover all.
    let off = 0n;
    for (let i = 0; i < si; i++) {
      off += base + (BigInt(i) < rem ? 1n : 0n);
    }
    const len = base + (BigInt(si) < rem ? 1n : 0n);
    end = start + off + len;
    start = start + off;
  }

  if (end <= start) {
    throw new Error(`empty shard window for shard ${si}/${sc}`);
  }

  const parts: string[] = [];
  if (start !== full.lo || end !== full.hi) {
    parts.push(`${formatHexScalar(start)}-${formatHexScalar(end - 1n)}`);
  }
  if (shardCount != null && shardIndex != null) {
    parts.push(`s${shardIndex}of${shardCount}`);
  }

  return {
    start,
    end,
    size: end - start,
    full,
    label: parts.join('@') || '',
    shardIndex,
    shardCount
  };
}

/** Parse "0/4" or "1 of 4" into { index, count }. */
export function parseShardToken(raw: string | null | undefined): {
  shardIndex: number;
  shardCount: number;
} | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (!t) return null;
  const m = t.match(/^(\d+)\s*(?:\/|of)\s*(\d+)$/i);
  if (!m) return null;
  return { shardIndex: Number(m[1]), shardCount: Number(m[2]) };
}

/**
 * Public-scan guidance for UI defaults (operator may override).
 * Not a claim that those keys are *gone* — only that pools have been dense there.
 */
export const PUBLIC_SCAN_NOTES: Record<number, string> = {
  // btcpuzzle.info-style public pools have been well under a few percent, not 50%.
  // We suggest no default skip; operators should check a live dashboard first.
  71:
    'Puzzle 71 public pools (e.g. btcpuzzle.info) report ~1% class coverage as of 2026 — not ~50%. ' +
    'Historical LBC covered much smaller bit depths. Prefer live pool stats over folklore; ' +
    'use start % / hex only when you have a reason to skip.',
  72: 'Puzzle 72 is largely untouched relative to #71. Default start is the range floor (2^71).'
};
