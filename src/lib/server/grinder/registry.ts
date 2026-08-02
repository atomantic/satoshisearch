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
import { coldcardSource, DEFAULT_COLDCARD_CONFIG, type ColdcardConfig } from './coldcard';
import { bcdTime } from './yasmarang';

/**
 * Demo ColdCard config: one candidate uid, a small SysTick window, a one-hour
 * creation window at minute resolution, and a small SSR range. Runnable out of
 * the box; a real rescue narrows uid + time to the target device. The seed-state
 * enumeration is exact — only the rng_get() consumption pattern is still assumed.
 */
function demoColdcardConfig(): ColdcardConfig {
  const trValues: number[] = [];
  for (let m = 0; m < 60; m++) trValues.push(bcdTime(14, m, 0));
  return { ...DEFAULT_COLDCARD_CONFIG, uids: [0xdeadbeef], systick: [0, 1023], trValues, ssr: [0, 15] };
}

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
    default:
      return null;
  }
}

export function listSources(): SourceInfo[] {
  const phrases = loadPhrases();
  return [
    {
      id: 'puzzle-71',
      label: 'Puzzle 71 range',
      bucket: 'puzzle',
      spaceBits: 70,
      description: 'Enumerate [2^70, 2^71) — the live sealed frontier. Infeasible to exhaust; runs as a demonstration and to target the ColdCard-adjacent depth.',
      available: true
    },
    {
      id: 'puzzle-72',
      label: 'Puzzle 72 range',
      bucket: 'puzzle',
      spaceBits: 71,
      description: 'Enumerate [2^71, 2^72) — exactly the ColdCard entropy depth.',
      available: true
    },
    {
      id: 'brainwallet',
      label: 'Brainwallets',
      bucket: 'brainwallet',
      spaceBits: Math.log2(Math.max(phrases.length, 1)),
      description: `SHA256 of ${phrases.length} known passphrases. The genuinely realistic rescue class — real people lost coins this way.`,
      available: phrases.length > 0
    },
    {
      id: 'constants-pi',
      label: 'Digits of π',
      bucket: 'constants',
      spaceBits: 8,
      description: 'Sliding windows over the digits of π, hashed to keys.',
      available: true
    },
    {
      id: 'constants-e',
      label: 'Digits of e',
      bucket: 'constants',
      spaceBits: 8,
      description: 'Sliding windows over the digits of e, hashed to keys.',
      available: true
    },
    {
      id: 'lowentropy',
      label: 'Low-entropy keys',
      bucket: 'lowentropy',
      spaceBits: 21,
      description: 'Small integers and simple patterns (key = 1, 2, 3, …). Catches trivially weak keys.',
      available: true
    },
    {
      id: 'coldcard',
      label: 'ColdCard 2026 (Yasmarang)',
      bucket: 'coldcard',
      spaceBits: Math.log2(1 * 1024 * 60 * 16), // demo slice: uid × SysTick × TR × SSR
      description:
        'Enumerate the MicroPython Yasmarang fallback-RNG seed-state space (uid × SysTick × RTC->TR × RTC->SSR), reproduce the BIP39 entropy stream, and derive standard paths. Demo config runs out of the box; a real rescue pins the target uid + creation-time window. Entropy stream assumes 4-byte-per-call consumption (pending device confirmation).',
      available: true,
      note: 'demo config — set target uid/time for a real device'
    }
  ];
}
