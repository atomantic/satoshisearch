/**
 * Registry of grinder sources the UI can start. Keeps source construction in one
 * place so the route handlers stay thin.
 *
 * Deliberately absent: brainwallets and the digits of pi/e/phi. Both classes are
 * small, public, and long since swept by everyone — they are not puzzles, and
 * grinding them again buys nothing.
 */
import {
  puzzleRangeSource,
  lowEntropySource,
  type GrindSource
} from './sources';
import {
  coldcardSource,
  demoColdcardConfig,
  mk3ColdBootConfig,
  mk4ReseedConfig
} from './coldcard';
import { resolvePuzzleWindow, isWindowSpecified, type WindowSpec } from './range-window';

export interface SourceInfo {
  id: string;
  label: string;
  bucket: string;
  spaceBits: number;
  /** sequential-keys | rng-states */
  spaceKind: string;
  /** Human label for what spaceBits measures. */
  spaceUnit: string;
  description: string;
  available: boolean;
  note?: string;
}

/**
 * Build a source by id, or null if unavailable.
 * For puzzle-* ids, optional `window` claims a sub-range / multi-host shard.
 */
export function makeSource(id: string, window?: WindowSpec | null): GrindSource | null {
  if (id.startsWith('puzzle-')) {
    const n = Number(id.slice('puzzle-'.length));
    if (n < 1 || n > 160 || !Number.isInteger(n)) return null;
    if (isWindowSpecified(window)) {
      const w = resolvePuzzleWindow(n, window!);
      return puzzleRangeSource(n, { start: w.start, end: w.end, label: w.label });
    }
    return puzzleRangeSource(n);
  }
  switch (id) {
    case 'lowentropy':
      return lowEntropySource(2_000_000);
    case 'coldcard':
      return coldcardSource(demoColdcardConfig());
    case 'coldcard-mk3-demo':
      // Known fake UID, full Mk3 SysTick, cold-boot static RTC (~80k states).
      return coldcardSource(mk3ColdBootConfig(0xdeadbeef, [0, 2047]));
    case 'coldcard-mk4-reseed-demo':
      // Tiny reseed slice for UI; real rescue widens reseedRange.
      return coldcardSource(mk4ReseedConfig([0, 4095], { n: 0, d: 0 }));
    default:
      return null;
  }
}

/**
 * Presentation-only fields. Everything about the *space* (bits, kind, unit) is
 * read off the real source via makeSource() — restating it here is how the
 * picker drifted from what the grinder actually searches.
 */
const SOURCE_PRESENTATION: Array<{
  id: string;
  label: string;
  description: string | ((src: GrindSource) => string);
  note?: string;
}> = [
  {
    id: 'puzzle-71',
    label: 'Puzzle 71 range',
    description:
      'Sequential private keys in [2^70, 2^71) — the sealed puzzle frontier. Farm shards across hosts (shard i/n) or skip a start %/hex. Every key also hits the match-set (not only #71). Public pools are ~1% class coverage, not halfway — check a live dashboard before skipping.'
  },
  {
    id: 'puzzle-72',
    label: 'Puzzle 72 range',
    description:
      'Sequential private keys in [2^71, 2^72). Same multi-target match-set and shard/start-window controls as #71. Depth is a yardstick vs ColdCard effective entropy only — search geometry differs (range vs RNG-state expand).'
  },
  {
    id: 'lowentropy',
    label: 'Low-entropy keys',
    description: 'Small integers and simple patterns (key = 1, 2, 3, …). Catches trivially weak keys.'
  },
  {
    id: 'coldcard',
    label: 'ColdCard demo (tiny)',
    description: (src) => {
      const m = src.rngSpace!;
      return `UI demo slice only (~2^${m.workBits.toFixed(1)} states). Use mk3/mk4 profiles for real geometry. Expand: state→entropy→BIP39→BIP32 paths.`;
    },
    note: 'not an attack profile'
  },
  {
    id: 'coldcard-mk3-demo',
    label: 'ColdCard Mk3 cold-boot (demo SysTick)',
    description: (src) => {
      const m = src.rngSpace!;
      return `Mk3 model: known UID, pad=uid⊕SysTick, cold-boot RTC static (TR=SSR=0). Demo uses 2048 SysTick of 80k. Full known-UID cold-boot ≈2^16.3. libngu-xor + sha256d. States=${m.seedStates}.`;
    },
    note: 'set real UID + full SysTick for rescue'
  },
  {
    id: 'coldcard-mk4-reseed-demo',
    label: 'ColdCard Mk4 reseed slice (demo)',
    description: (src) => {
      const m = src.rngSpace!;
      return `Mk4 model when fallback timers fixed: enumerate SE reseed word only (≤2^32). Demo 4096 of 2^32. States=${m.seedStates}.`;
    },
    note: 'slice reseedRange; full 2^32 needs serious compute'
  }
];

export function listSources(): SourceInfo[] {
  return SOURCE_PRESENTATION.map((p) => {
    const src = makeSource(p.id);
    if (!src) {
      return {
        id: p.id,
        label: p.label,
        bucket: 'unknown',
        spaceBits: 0,
        spaceKind: 'sequential-keys',
        spaceUnit: '',
        description: typeof p.description === 'string' ? p.description : '',
        available: false,
        note: p.note
      };
    }
    return {
      id: p.id,
      label: p.label,
      bucket: src.bucket,
      spaceBits: src.spaceBits,
      spaceKind: src.spaceKind ?? 'sequential-keys',
      spaceUnit: src.spaceUnit ?? '',
      description: typeof p.description === 'string' ? p.description : p.description(src),
      // A source with an empty space can't be run.
      available: src.size == null || src.size > 0n,
      note: p.note
    };
  });
}
