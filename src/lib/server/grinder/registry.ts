/**
 * Registry of grinder sources the UI can start. Keeps source construction (some
 * need vendored data files) in one place so the route handlers stay thin.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  puzzleRangeSource,
  brainwalletSource,
  constantsSource,
  lowEntropySource,
  type GrindSource
} from './sources';
import {
  coldcardSource,
  demoColdcardConfig,
  mk3ColdBootConfig,
  mk4ReseedConfig
} from './coldcard';

const datasetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'datasets');

// Mathematical constants people have used as key material (from bitfinderlite).
const CONSTANTS: Record<string, string> = {
  pi: '314159265358979323846264338327950288419716939937510582097494459230781640628620899862803482534211706798',
  e: '271828182845904523536028747135266249775724709369995957496696762772407663035354759457138217852516642743',
  phi: '161803398874989484820458683436563811772030917980576286213544862270526046281890244970720720418939113748'
};

function loadPhrases(): string[] {
  const files = ['btc1', 'btc2', 'god', 'god2', 'phraselist'];
  const out: string[] = [];
  for (const f of files) {
    const p = join(datasetsDir, 'phrases', `${f}.txt`);
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const t = line.trim();
        if (t) out.push(t);
      }
    }
  }
  return [...new Set(out)];
}

export interface SourceInfo {
  id: string;
  label: string;
  bucket: string;
  spaceBits: number;
  /** sequential-keys | rng-states | phrase-list | digit-windows */
  spaceKind: string;
  /** Human label for what spaceBits measures. */
  spaceUnit: string;
  description: string;
  available: boolean;
  note?: string;
}

/** Build a source by id, or null if unavailable (e.g. coldcard pending model). */
export function makeSource(id: string): GrindSource | null {
  if (id.startsWith('puzzle-')) {
    const n = Number(id.slice('puzzle-'.length));
    if (n >= 1 && n <= 160) return puzzleRangeSource(n);
    return null;
  }
  switch (id) {
    case 'brainwallet':
      return brainwalletSource(loadPhrases());
    case 'constants-pi':
      return constantsSource('pi', CONSTANTS.pi);
    case 'constants-e':
      return constantsSource('e', CONSTANTS.e);
    case 'constants-phi':
      return constantsSource('phi', CONSTANTS.phi);
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
      'Sequential private keys in [2^70, 2^71) — the live sealed puzzle frontier. Different from ColdCard: those keys are not low integers; they come from a weak RNG seed state.'
  },
  {
    id: 'puzzle-72',
    label: 'Puzzle 72 range',
    description:
      'Sequential private keys in [2^71, 2^72). Depth is comparable to ColdCard *effective entropy* only as a yardstick — the search structures are different (range vs RNG-state expand).'
  },
  {
    id: 'brainwallet',
    label: 'Brainwallets',
    description: (src) =>
      `SHA256 of ${src.size} known passphrases. The genuinely realistic rescue class — real people lost coins this way.`
  },
  {
    id: 'constants-pi',
    label: 'Digits of π',
    description: 'Sliding windows over the digits of π, hashed to keys.'
  },
  {
    id: 'constants-e',
    label: 'Digits of e',
    description: 'Sliding windows over the digits of e, hashed to keys.'
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
      // A source with an empty space (e.g. no phrase list loaded) can't be run.
      available: src.size == null || src.size > 0n,
      note: p.note
    };
  });
}
