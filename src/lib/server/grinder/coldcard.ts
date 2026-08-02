/**
 * ColdCard 2026 weak-RNG source — enumerates **RNG initial states**, not a
 * sequential private-key range.
 *
 * Pipeline:
 *   for each possible RNG state S:
 *     entropy  = stream(S)                 // Yasmarang / libngu-xor
 *     [optional] entropy = sha256d(entropy)
 *     mnemonic = BIP39(entropy)
 *     master   = BIP32(PBKDF2(mnemonic))   // native OpenSSL PBKDF2
 *     derive common paths → match funded set
 *
 * Device-class geometry (Block / Coinkite):
 *   - pad = UID_low32 ⊕ SysTick  → **one 32-bit word**, not uid×systick product
 *   - Mk3 SysTick ≈ 80_000; Mk4 ≈ 120_000
 *   - RTC may be static on cold boot (Mk3 often modeled as TR=0, SSR=0)
 *   - Mk4 reseed only injects ≤2^32 into pad once fallback is fixed
 *
 * Enum modes:
 *   uid-systick — product of listed uids × systick range × TR × SSR (pad=uid⊕st)
 *   pad         — direct pad range × TR × SSR (no double-count of uid/systick)
 *   mk4-reseed  — reseed word range with fixed (n,d) fallback base
 */
import { createHash } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import {
  Yasmarang,
  xorEntropy,
  seedFrom,
  bcdTime,
  SYSTICK_CARDINALITY,
  type YasmarangSeed,
  type DeviceClass
} from './yasmarang';
import { mnemonicToSeedFast } from './bip39-seed';
import type { GrindSource, KeyCandidate } from './sources';

export type { YasmarangSeed, DeviceClass };

/** How candidate states are indexed. */
export type EnumMode = 'uid-systick' | 'pad' | 'mk4-reseed';

/**
 * Entropy stream construction.
 * - micropython: MicroPython Yasmarang only (tests / simple model)
 * - libngu-xor:  MicroPython XOR libngu public Yasmarang (wallet path)
 */
export type EntropyStream = 'micropython' | 'libngu-xor';

export interface ColdcardConfig {
  deviceClass: DeviceClass;
  enumMode: EnumMode;
  /**
   * uid-systick mode: candidate UID_low32 words.
   * Empty / unused in pad and mk4-reseed modes.
   */
  uids: number[];
  /** Inclusive SysTick range [lo, hi] (uid-systick mode). */
  systick: [number, number];
  /**
   * pad mode: inclusive pad range [lo, hi].
   * When unset, derived from uids×systick product (not recommended for large spaces).
   */
  padRange?: [number, number];
  /** RTC->TR BCD samples. Use [0] for cold-boot static clock. */
  trValues: number[];
  /** Inclusive RTC->SSR range [lo, hi]. */
  ssr: [number, number];
  /**
   * mk4-reseed: fixed n,d (and optional pad baseline) after fallback init;
   * enumeration replaces pad with reseed ∈ reseedRange.
   */
  reseedBase?: Pick<YasmarangSeed, 'n' | 'd'>;
  reseedRange?: [number, number];
  /** 16 (12-word) or 32 (24-word) entropy bytes. */
  entropyBytes: 16 | 32;
  entropyStream: EntropyStream;
  /** If true, SHA256d(entropy) before BIP39 (COLDCARD wallet generation). */
  sha256dEntropy: boolean;
  pathTemplates: string[];
  addressGap: number;
}

export const DEFAULT_PATHS = [
  "m/84'/0'/0'/0",
  "m/84'/0'/0'/1",
  "m/44'/0'/0'/0",
  "m/49'/0'/0'/0"
] as const;

export const DEFAULT_COLDCARD_CONFIG: ColdcardConfig = {
  deviceClass: 'generic',
  enumMode: 'uid-systick',
  uids: [0xdeadbeef],
  systick: [0, 4095],
  trValues: [],
  ssr: [0, 15],
  entropyBytes: 16,
  entropyStream: 'micropython',
  sha256dEntropy: false,
  pathTemplates: [...DEFAULT_PATHS],
  addressGap: 5
};

export interface RngSpaceDimension {
  name: string;
  size: number;
  note: string;
}

export interface RngSpaceModel {
  seedStates: bigint;
  keysPerSeed: number;
  totalDerivedKeys: bigint;
  workBits: number;
  dimensions: RngSpaceDimension[];
  isDemoSlice: boolean;
  deviceClass: DeviceClass;
  enumMode: EnumMode;
}

export function log2BigInt(n: bigint): number {
  if (n <= 1n) return 0;
  // Use enough leading hex digits that Math.log2 sees a multi-bit mantissa
  // (a single nibble of 1 would give log2(1)=0 and under-count by almost 4 bits).
  const hex = n.toString(16);
  const take = Math.min(hex.length, 13); // ≤ 52 bits of mantissa
  const top = parseInt(hex.slice(0, take), 16);
  return (hex.length - take) * 4 + Math.log2(top);
}

function dimSizes(cfg: ColdcardConfig): {
  dimensions: RngSpaceDimension[];
  seedStates: bigint;
} {
  const keysNote = '';
  if (cfg.enumMode === 'mk4-reseed') {
    const [lo, hi] = cfg.reseedRange ?? [0, 0xffff];
    const n = Math.max(0, hi - lo + 1);
    return {
      seedStates: BigInt(n),
      dimensions: [
        {
          name: 'reseed',
          size: n,
          note: `Mk4 SE reseed word [${lo}, ${hi}] replaces Yasmarang pad (≤2^32 ceiling). n=${cfg.reseedBase?.n ?? 0} d=${cfg.reseedBase?.d ?? 0} fixed.`
        }
      ]
    };
  }

  if (cfg.enumMode === 'pad') {
    const [lo, hi] = cfg.padRange ?? [0, 0xffff];
    const nPad = Math.max(0, hi - lo + 1);
    const nTr = Math.max(0, cfg.trValues.length);
    const nSsr = Math.max(0, cfg.ssr[1] - cfg.ssr[0] + 1);
    return {
      seedStates: BigInt(nPad) * BigInt(nTr) * BigInt(nSsr),
      dimensions: [
        {
          name: 'pad',
          size: nPad,
          note: `Direct pad enumeration [${lo}, ${hi}] — already uid⊕SysTick (32-bit collapse).`
        },
        { name: 'RTC->TR', size: nTr, note: 'BCD wall-clock samples' },
        {
          name: 'RTC->SSR',
          size: nSsr,
          note: `Inclusive [${cfg.ssr[0]}, ${cfg.ssr[1]}]`
        }
      ]
    };
  }

  // uid-systick
  const nUid = Math.max(0, cfg.uids.length);
  const nSys = Math.max(0, cfg.systick[1] - cfg.systick[0] + 1);
  const nTr = Math.max(0, cfg.trValues.length);
  const nSsr = Math.max(0, cfg.ssr[1] - cfg.ssr[0] + 1);
  return {
    seedStates: BigInt(nUid) * BigInt(nSys) * BigInt(nTr) * BigInt(nSsr),
    dimensions: [
      {
        name: 'uid',
        size: nUid,
        note: 'UID_low32 candidates. Known device → 1. pad=uid⊕SysTick (not independent entropy).'
      },
      {
        name: 'SysTick',
        size: nSys,
        note: `Inclusive [${cfg.systick[0]}, ${cfg.systick[1]}]. ${cfg.deviceClass} max ≈ ${SYSTICK_CARDINALITY[cfg.deviceClass]}.${keysNote}`
      },
      { name: 'RTC->TR', size: nTr, note: 'BCD wall-clock samples' },
      {
        name: 'RTC->SSR',
        size: nSsr,
        note: `Inclusive [${cfg.ssr[0]}, ${cfg.ssr[1]}]`
      }
    ]
  };
}

export function describeRngSpace(cfg: ColdcardConfig): RngSpaceModel {
  const { dimensions, seedStates } = dimSizes(cfg);
  const keysPerSeed = cfg.pathTemplates.length * cfg.addressGap;
  if (seedStates === 0n || keysPerSeed === 0) {
    return {
      seedStates: 0n,
      keysPerSeed,
      totalDerivedKeys: 0n,
      workBits: 0,
      dimensions,
      isDemoSlice: true,
      deviceClass: cfg.deviceClass,
      enumMode: cfg.enumMode
    };
  }

  // Demo if well under one known-uid full SysTick × static RTC for this class.
  const stMax = SYSTICK_CARDINALITY[cfg.deviceClass];
  const ref = BigInt(stMax); // cold-boot static RTC → just SysTick
  const isDemoSlice = seedStates < ref / 4n;

  return {
    seedStates,
    keysPerSeed,
    totalDerivedKeys: seedStates * BigInt(keysPerSeed),
    workBits: log2BigInt(seedStates),
    dimensions,
    isDemoSlice,
    deviceClass: cfg.deviceClass,
    enumMode: cfg.enumMode
  };
}

export function seedSpaceSize(cfg: ColdcardConfig): bigint {
  return describeRngSpace(cfg).seedStates;
}

/** Decode linear cursor → YasmarangSeed. */
export function decodeSeed(cfg: ColdcardConfig, idx: bigint): YasmarangSeed | null {
  if (cfg.enumMode === 'mk4-reseed') {
    const [lo, hi] = cfg.reseedRange ?? [0, 0];
    const n = BigInt(Math.max(0, hi - lo + 1));
    if (idx >= n || n === 0n) return null;
    const reseed = lo + Number(idx);
    const base = cfg.reseedBase ?? { n: 0, d: 0 };
    return { pad: reseed >>> 0, n: base.n >>> 0, d: base.d >>> 0 };
  }

  if (cfg.enumMode === 'pad') {
    const [lo, hi] = cfg.padRange ?? [0, 0];
    const nPad = BigInt(Math.max(0, hi - lo + 1));
    const nTr = BigInt(Math.max(0, cfg.trValues.length));
    const nSsr = BigInt(Math.max(0, cfg.ssr[1] - cfg.ssr[0] + 1));
    const total = nPad * nTr * nSsr;
    if (idx >= total || total === 0n) return null;
    let r = idx;
    const ssrOff = Number(r % nSsr);
    r /= nSsr;
    const trI = Number(r % nTr);
    r /= nTr;
    const padOff = Number(r % nPad);
    return {
      pad: (lo + padOff) >>> 0,
      n: cfg.trValues[trI] >>> 0,
      d: (cfg.ssr[0] + ssrOff) >>> 0
    };
  }

  // uid-systick
  const nUid = BigInt(cfg.uids.length);
  const nSys = BigInt(Math.max(0, cfg.systick[1] - cfg.systick[0] + 1));
  const nTr = BigInt(Math.max(0, cfg.trValues.length));
  const nSsr = BigInt(Math.max(0, cfg.ssr[1] - cfg.ssr[0] + 1));
  const total = nUid * nSys * nTr * nSsr;
  if (idx >= total || total === 0n) return null;

  let r = idx;
  const ssrOff = Number(r % nSsr);
  r /= nSsr;
  const trI = Number(r % nTr);
  r /= nTr;
  const sysOff = Number(r % nSys);
  r /= nSys;
  const uidI = Number(r % nUid);

  return seedFrom(
    cfg.uids[uidI],
    cfg.systick[0] + sysOff,
    cfg.trValues[trI],
    cfg.ssr[0] + ssrOff
  );
}

function sha256d(data: Uint8Array): Uint8Array {
  const h1 = createHash('sha256').update(data).digest();
  return new Uint8Array(createHash('sha256').update(h1).digest());
}

/** Entropy bytes for one RNG state (before BIP39). */
export function entropyForState(cfg: ColdcardConfig, seed: YasmarangSeed): Uint8Array {
  let ent =
    cfg.entropyStream === 'libngu-xor'
      ? xorEntropy(seed, cfg.entropyBytes)
      : new Yasmarang(seed).bytes(cfg.entropyBytes);
  if (cfg.sha256dEntropy) {
    const hashed = sha256d(ent);
    // Wallet uses 32-byte sha256d output; for 12-word take first 16.
    ent = hashed.subarray(0, cfg.entropyBytes);
  }
  return ent;
}

/**
 * One RNG state → BIP39 → master → common-path child keys.
 * PBKDF2 uses Node native crypto (not pure-JS @scure).
 */
export function expandRngState(cfg: ColdcardConfig, seed: YasmarangSeed): KeyCandidate[] {
  const entropy = entropyForState(cfg, seed);
  const mnemonic = entropyToMnemonic(entropy, wordlist);
  const bip39seed = mnemonicToSeedFast(mnemonic);
  const root = HDKey.fromMasterSeed(bip39seed);

  const origin = `coldcard:pad=${seed.pad.toString(16)},n=${seed.n.toString(16)},d=${seed.d.toString(16)}`;
  const out: KeyCandidate[] = [];
  for (const tpl of cfg.pathTemplates) {
    for (let i = 0; i < cfg.addressGap; i++) {
      const child = root.derive(`${tpl}/${i}`);
      if (child.privateKey) out.push({ priv: child.privateKey, origin: `${origin} ${tpl}/${i}` });
    }
  }
  return out;
}

/** @deprecated Prefer expandRngState */
export const keysForSeed = expandRngState;

/** Cheap seed-state enumeration (no PBKDF2). Cursor indexes seed space. */
export function generateColdcardSeeds(
  cfg: ColdcardConfig,
  cursor: bigint,
  limit: number
): { seeds: YasmarangSeed[]; nextCursor: bigint; done: boolean } {
  const seeds: YasmarangSeed[] = [];
  let idx = cursor;
  while (seeds.length < limit) {
    const seed = decodeSeed(cfg, idx);
    if (seed === null) return { seeds, nextCursor: idx, done: true };
    seeds.push(seed);
    idx += 1n;
  }
  return { seeds, nextCursor: idx, done: false };
}

export function coldcardSource(cfg: ColdcardConfig): GrindSource {
  const model = describeRngSpace(cfg);
  return {
    name: cfg.enumMode === 'mk4-reseed' ? 'coldcard-mk4-reseed' : `coldcard-${cfg.deviceClass}`,
    bucket: 'coldcard',
    coldcardConfig: cfg,
    rngSpace: model,
    spaceBits: model.workBits,
    size: model.seedStates,
    spaceKind: 'rng-states',
    spaceUnit: `${cfg.deviceClass}/${cfg.enumMode} RNG states → BIP39 → BIP32`,
    generate(cursor, limit) {
      const items: KeyCandidate[] = [];
      let idx = cursor;
      while (items.length < limit) {
        const seed = decodeSeed(cfg, idx);
        if (seed === null) return { items, nextCursor: idx, done: true };
        items.push(...expandRngState(cfg, seed));
        idx += 1n;
      }
      return { items, nextCursor: idx, done: false };
    }
  };
}

// ---------------------------------------------------------------------------
// Preset builders — preferred entry points for rescues
// ---------------------------------------------------------------------------

export interface Mk3Options {
  /** Known UID_low32. Omit for pad-mode blind upper bound (caller must set padRange). */
  uid?: number;
  /** Override SysTick range; default full Mk3 0..79999. */
  systick?: [number, number];
  /**
   * Cold-boot model: RTC TR=0, SSR=0 (Block: oscillator often disabled on Mk2/Mk3).
   * Default true.
   */
  coldBootRtc?: boolean;
  trValues?: number[];
  ssr?: [number, number];
  entropyStream?: EntropyStream;
  sha256dEntropy?: boolean;
  pathTemplates?: string[];
  addressGap?: number;
}

/** Mk3 / Mk2 v4: known UID, full SysTick, optional cold-boot static RTC. */
export function mk3KnownUidConfig(uid: number, opts: Mk3Options = {}): ColdcardConfig {
  const cold = opts.coldBootRtc !== false;
  return {
    deviceClass: 'mk3',
    enumMode: 'uid-systick',
    uids: [uid >>> 0],
    systick: opts.systick ?? [0, SYSTICK_CARDINALITY.mk3 - 1],
    trValues: cold ? [0] : (opts.trValues ?? [0]),
    ssr: cold ? [0, 0] : (opts.ssr ?? [0, 255]),
    entropyBytes: 16,
    entropyStream: opts.entropyStream ?? 'libngu-xor',
    sha256dEntropy: opts.sha256dEntropy ?? true,
    pathTemplates: opts.pathTemplates ?? [...DEFAULT_PATHS],
    addressGap: opts.addressGap ?? 5
  };
}

/**
 * Mk3 cold-boot known UID: only SysTick free (~2^16.3 work).
 * This is the Block "best-case hidden-timer ceiling" when RTC is static.
 */
export function mk3ColdBootConfig(uid: number, systick?: [number, number]): ColdcardConfig {
  return mk3KnownUidConfig(uid, { coldBootRtc: true, systick });
}

export interface Mk4Options {
  uid?: number;
  systick?: [number, number];
  trValues?: number[];
  ssr?: [number, number];
  /** When set, use mk4-reseed mode over this inclusive reseed range. */
  reseedRange?: [number, number];
  reseedBase?: Pick<YasmarangSeed, 'n' | 'd'>;
  entropyStream?: EntropyStream;
  sha256dEntropy?: boolean;
  pathTemplates?: string[];
  addressGap?: number;
}

/**
 * Mk4/Q/Mk5 known UID: full device SysTick × TR × SSR (loose).
 * Prefer `mk4ReseedConfig` when fallback timers are pinned and only reseed is free.
 */
export function mk4KnownUidConfig(uid: number, opts: Mk4Options = {}): ColdcardConfig {
  return {
    deviceClass: 'mk4',
    enumMode: 'uid-systick',
    uids: [uid >>> 0],
    systick: opts.systick ?? [0, SYSTICK_CARDINALITY.mk4 - 1],
    trValues: opts.trValues ?? [bcdTime(12, 0, 0)],
    ssr: opts.ssr ?? [0, 255],
    entropyBytes: 16,
    entropyStream: opts.entropyStream ?? 'libngu-xor',
    sha256dEntropy: opts.sha256dEntropy ?? true,
    pathTemplates: opts.pathTemplates ?? [...DEFAULT_PATHS],
    addressGap: opts.addressGap ?? 5
  };
}

/**
 * Mk4 path when MicroPython fallback (n,d) is known/fixed and only the 32-bit
 * SE reseed is free. Slice reseedRange for tractable runs (full 2^32 is large).
 */
export function mk4ReseedConfig(
  reseedRange: [number, number],
  reseedBase: Pick<YasmarangSeed, 'n' | 'd'> = { n: 0, d: 0 },
  opts: Pick<Mk4Options, 'entropyStream' | 'sha256dEntropy' | 'pathTemplates' | 'addressGap'> = {}
): ColdcardConfig {
  return {
    deviceClass: 'mk4',
    enumMode: 'mk4-reseed',
    uids: [],
    systick: [0, 0],
    trValues: [reseedBase.n],
    ssr: [0, 0],
    reseedBase,
    reseedRange,
    entropyBytes: 16,
    entropyStream: opts.entropyStream ?? 'libngu-xor',
    sha256dEntropy: opts.sha256dEntropy ?? true,
    pathTemplates: opts.pathTemplates ?? [...DEFAULT_PATHS],
    addressGap: opts.addressGap ?? 5
  };
}

/**
 * Direct pad enumeration (honest 32-bit collapse). Use when UID is unknown:
 * do not multiply by SysTick.
 */
export function padRangeConfig(
  padRange: [number, number],
  opts: {
    deviceClass?: DeviceClass;
    trValues?: number[];
    ssr?: [number, number];
    entropyStream?: EntropyStream;
    sha256dEntropy?: boolean;
    pathTemplates?: string[];
    addressGap?: number;
  } = {}
): ColdcardConfig {
  return {
    deviceClass: opts.deviceClass ?? 'generic',
    enumMode: 'pad',
    uids: [],
    systick: [0, 0],
    padRange,
    trValues: opts.trValues ?? [0],
    ssr: opts.ssr ?? [0, 0],
    entropyBytes: 16,
    entropyStream: opts.entropyStream ?? 'libngu-xor',
    sha256dEntropy: opts.sha256dEntropy ?? true,
    pathTemplates: opts.pathTemplates ?? [...DEFAULT_PATHS],
    addressGap: opts.addressGap ?? 5
  };
}

/**
 * Small runnable demo (UI default): micropython stream, no sha256d, tiny dims —
 * keeps unit tests and the grinder page snappy. Not an attack profile.
 */
export function demoColdcardConfig(): ColdcardConfig {
  const trValues: number[] = [];
  for (let m = 0; m < 60; m++) trValues.push(bcdTime(14, m, 0));
  return {
    ...DEFAULT_COLDCARD_CONFIG,
    deviceClass: 'generic',
    enumMode: 'uid-systick',
    uids: [0xdeadbeef],
    systick: [0, 1023],
    trValues,
    ssr: [0, 15],
    entropyStream: 'micropython',
    sha256dEntropy: false
  };
}
