/**
 * Keyspace frontier analysis — the centerpiece.
 *
 * The Bitcoin puzzle series is a natural experiment in how much of the 256-bit
 * private-key space the world has demonstrably searched. Each solved puzzle N is
 * a public proof that someone traversed a 2^(N-1)-wide range. We turn the
 * indexed puzzle table into:
 *
 *   - bruteForceFrontier: the largest N such that every *sealed* puzzle <= N is
 *     solved. Sealed puzzles expose only a hash160, so solving one requires a
 *     genuine brute force of its N-bit range. This is the honest "how deep can
 *     the public brute-force" number.
 *
 *   - ecdlpFrontier: the largest N solved among *exposed* puzzles (pubkey
 *     public). These fall to Pollard's kangaroo at ~2^(N/2) work, so they say
 *     nothing about brute-force reach but a lot about ECDLP reach.
 *
 *   - atRisk: exposed + still-funded puzzles — coins whose pubkey is public and
 *     are therefore attackable *right now* at ~N/2 bits.
 *
 *   - projection: a regression over solve dates vs. bits, giving bits/year and a
 *     naive ETA for the next sealed frontier bit.
 *
 * Reference bands (ColdCard 72-bit, BIP39 128/256, brainwallet, ECDLP-128 for
 * Satoshi's P2PK) are overlaid so the frontier can be read against real threats.
 */
import { openDb } from './db';

export interface ReferenceBand {
  label: string;
  bits: number;
  kind: 'threat' | 'safe' | 'satoshi';
  note: string;
}

export interface KeyspaceAnalysis {
  bruteForceFrontier: number;
  ecdlpFrontier: number;
  totalSolved: number;
  sealedUnsolved: number[];
  atRisk: Array<{ n: number; bits: number; balanceSats: number; halfBits: number }>;
  atRiskSats: number;
  projection: {
    bitsPerYear: number | null;
    nextBit: number;
    etaYear: number | null;
    points: Array<{ n: number; year: number }>;
  };
  bands: ReferenceBand[];
}

export const REFERENCE_BANDS: ReferenceBand[] = [
  { label: 'Brainwallet', bits: 40, kind: 'threat', note: 'Human-chosen passphrases; effectively tiny.' },
  {
    label: 'ColdCard 2026',
    bits: 72,
    kind: 'threat',
    note: 'MicroPython Yasmarang fallback RNG: 128→72 effective bits. ~1,082 BTC swept in 41 min.'
  },
  { label: 'BIP39 128-bit', bits: 128, kind: 'safe', note: '12-word mnemonic entropy floor.' },
  {
    label: 'Satoshi P2PK (ECDLP)',
    bits: 128,
    kind: 'satoshi',
    note: "Early coinbase pubkeys are public, so protected by ~2^128 ECDLP work, not hash160."
  },
  { label: 'BIP39 256-bit', bits: 256, kind: 'safe', note: '24-word mnemonic entropy.' }
];

interface PuzzleRec {
  n: number;
  status: 'sealed' | 'exposed' | 'solved';
  balance: number;
  solve_height: number | null;
}

/** Rough block-height → fractional year, good enough for a trend line. */
function heightToYear(height: number): number {
  // Genesis 2009-01-03; ~144 blocks/day, 365.25 days/yr.
  return 2009 + height / (144 * 365.25);
}

export function analyzeKeyspace(): KeyspaceAnalysis {
  const db = openDb();
  const rows = db
    .prepare(`SELECT n, status, balance, solve_height FROM puzzle ORDER BY n`)
    .all() as PuzzleRec[];

  const solved = rows.filter((r) => r.status === 'solved');

  const sealedUnsolved = rows
    .filter((r) => r.status === 'sealed' && r.balance > 0)
    .map((r) => r.n)
    .sort((a, b) => a - b);

  // Brute-force frontier: the largest N with every sealed puzzle <= N solved,
  // i.e. one below the smallest still-sealed-and-funded range. If nothing sealed
  // remains, the frontier is the deepest sealed puzzle we know about.
  const maxSealedN = rows.filter((r) => r.status !== 'exposed').reduce((mx, r) => Math.max(mx, r.n), 0);
  const bruteForceFrontier = sealedUnsolved.length ? sealedUnsolved[0] - 1 : maxSealedN;

  const ecdlpFrontier = solved.reduce((mx, r) => Math.max(mx, r.n), 0);

  const atRiskRows = rows.filter((r) => r.status === 'exposed' && r.balance > 0);
  const atRisk = atRiskRows.map((r) => ({
    n: r.n,
    bits: r.n,
    balanceSats: r.balance,
    halfBits: Math.ceil(r.n / 2)
  }));
  const atRiskSats = atRiskRows.reduce((a, r) => a + r.balance, 0);

  // Trend: sealed solves (brute-force proofs) with a known solve height.
  const points = solved
    .filter((r) => r.solve_height != null)
    .map((r) => ({ n: r.n, year: heightToYear(r.solve_height as number) }))
    .sort((a, b) => a.year - b.year);

  const projection = regress(points, bruteForceFrontier);

  return {
    bruteForceFrontier,
    ecdlpFrontier,
    totalSolved: solved.length,
    sealedUnsolved,
    atRisk,
    atRiskSats,
    projection,
    bands: REFERENCE_BANDS
  };
}

/** Least-squares bits-vs-year over solve points; extrapolate the next frontier bit. */
function regress(
  points: Array<{ n: number; year: number }>,
  frontier: number
): KeyspaceAnalysis['projection'] {
  const nextBit = frontier + 1;
  if (points.length < 3) return { bitsPerYear: null, nextBit, etaYear: null, points };

  const N = points.length;
  const sx = points.reduce((a, p) => a + p.year, 0);
  const sy = points.reduce((a, p) => a + p.n, 0);
  const sxy = points.reduce((a, p) => a + p.year * p.n, 0);
  const sxx = points.reduce((a, p) => a + p.year * p.year, 0);
  const denom = N * sxx - sx * sx;
  if (denom === 0) return { bitsPerYear: null, nextBit, etaYear: null, points };

  const slope = (N * sxy - sx * sy) / denom; // bits per year
  const intercept = (sy - slope * sx) / N;
  const etaYear = slope > 0 ? (nextBit - intercept) / slope : null;

  return { bitsPerYear: slope, nextBit, etaYear, points };
}
