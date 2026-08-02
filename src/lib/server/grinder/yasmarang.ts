/**
 * MicroPython's `pyb_rng_yasmarang` fallback PRNG (Yasmarang by Ilya Levin),
 * used whenever `MICROPY_HW_ENABLE_RNG` is compiled out — the generator behind
 * the July 2026 ColdCard entropy flaw. Faithful pure-JS reimplementation of the
 * C source (exact uint32 wrap-around arithmetic).
 *
 * MicroPython seeds on first call:
 *   pad = UID_low32 ^ SysTick->VAL   // collapses to one 32-bit word
 *   n   = RTC->TR
 *   d   = RTC->SSR
 *   dat = 0
 *
 * libngu (COLDCARD wallet path) maintains a *second* Yasmarang with public
 * constants and XORs the two streams. See `LibnguYasmarang` / `xorEntropy`.
 *
 * Search geometry notes (Block / Coinkite analysis):
 * - pad is 32 bits total, NOT independent uid × SysTick product
 * - Mk2/Mk3 SysTick: ~80_000 values; Mk4/Q/Mk5: ~120_000
 * - RTC fields correlate and may be static on cold boot (esp. Mk2/Mk3)
 * - Mk4 reseed only replaces a 32-bit pad word (≤2^32 streams once fallback fixed)
 */

export interface YasmarangSeed {
  pad: number; // uid ^ systick  (or reseed value on Mk4 after reseed)
  n: number; // RTC->TR
  d: number; // RTC->SSR
}

export class Yasmarang {
  private pad: number;
  private n: number;
  private d: number;
  private dat: number;

  constructor(seed: YasmarangSeed) {
    this.pad = seed.pad >>> 0;
    this.n = seed.n >>> 0;
    this.d = seed.d >>> 0;
    this.dat = 0;
  }

  /** One 32-bit output, mutating state exactly as the C generator does. */
  next(): number {
    this.pad = (this.pad + this.dat + Math.imul(this.d, this.n)) >>> 0;
    this.pad = (((this.pad << 3) >>> 0) + (this.pad >>> 29)) >>> 0;
    this.n = (this.pad | 2) >>> 0;
    this.d = (this.d ^ ((((this.pad << 31) >>> 0) + (this.pad >>> 1)) >>> 0)) >>> 0;
    this.dat = (this.dat ^ (this.pad & 0xff) ^ ((this.d >>> 8) & 0xff) ^ 1) & 0xff;
    return (this.pad ^ ((this.d << 5) >>> 0) ^ (this.pad >>> 18) ^ ((this.dat << 1) >>> 0)) >>> 0;
  }

  /** Fill `n` bytes, 4 little-endian bytes per `next()` call. */
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let i = 0;
    while (i < n) {
      const w = this.next();
      out[i++] = w & 0xff;
      if (i < n) out[i++] = (w >>> 8) & 0xff;
      if (i < n) out[i++] = (w >>> 16) & 0xff;
      if (i < n) out[i++] = (w >>> 24) & 0xff;
    }
    return out;
  }
}

/**
 * libngu's second Yasmarang, initialized with public constants
 * (see Block advisory / libngu random.c).
 */
export const LIBNGU_YASMARANG_INIT: YasmarangSeed = {
  pad: 0x0a8ce26f,
  n: 69,
  d: 233
};

/** Fresh libngu stream (public fixed seed; dat starts at 0). */
export function createLibnguYasmarang(): Yasmarang {
  return new Yasmarang(LIBNGU_YASMARANG_INIT);
}

/**
 * COLDCARD `ngu.random` style: each word is
 *   MicroPython_rng_get() XOR libngu_yasmarang()
 * for `n` bytes (LE packing same as MicroPython).
 */
export function xorEntropy(mpSeed: YasmarangSeed, n: number): Uint8Array {
  const mp = new Yasmarang(mpSeed);
  const lg = createLibnguYasmarang();
  const out = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    const w = (mp.next() ^ lg.next()) >>> 0;
    out[i++] = w & 0xff;
    if (i < n) out[i++] = (w >>> 8) & 0xff;
    if (i < n) out[i++] = (w >>> 16) & 0xff;
    if (i < n) out[i++] = (w >>> 24) & 0xff;
  }
  return out;
}

/** Build seed from raw device words: pad = uid ⊕ systick. */
export function seedFrom(uid: number, systick: number, rtcTr: number, rtcSsr: number): YasmarangSeed {
  return { pad: (uid ^ systick) >>> 0, n: rtcTr >>> 0, d: rtcSsr >>> 0 };
}

/** Encode wall-clock h/m/s as the STM32 RTC->TR BCD register value. */
export function bcdTime(hours: number, minutes: number, seconds: number): number {
  const bcd = (v: number) => ((Math.floor(v / 10) << 4) | (v % 10)) >>> 0;
  return ((bcd(hours) << 16) | (bcd(minutes) << 8) | bcd(seconds)) >>> 0;
}

/** Inclusive range of BCD TR values for a wall-clock window at 1-second steps. */
export function bcdTimeRange(
  h0: number,
  m0: number,
  s0: number,
  h1: number,
  m1: number,
  s1: number
): number[] {
  const toSec = (h: number, m: number, s: number) => h * 3600 + m * 60 + s;
  const a = toSec(h0, m0, s0);
  const b = toSec(h1, m1, s1);
  const out: number[] = [];
  for (let t = a; t <= b; t++) {
    const h = Math.floor(t / 3600) % 24;
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    out.push(bcdTime(h, m, s));
  }
  return out;
}

/** Device-class SysTick cardinalities (Block advisory). */
export const SYSTICK_CARDINALITY = {
  /** Mk2/Mk3 ~80 MHz / 1 ms reload → 80_000 values. */
  mk3: 80_000,
  /** Mk4/Q/Mk5 ~120_000 values. */
  mk4: 120_000,
  /** Loose upper bound if class unknown. */
  generic: 1 << 24
} as const;

export type DeviceClass = keyof typeof SYSTICK_CARDINALITY;
