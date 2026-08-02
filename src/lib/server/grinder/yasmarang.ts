/**
 * MicroPython's `pyb_rng_yasmarang` fallback PRNG (Yasmarang by Ilya Levin),
 * used whenever `MICROPY_HW_ENABLE_RNG` is compiled out — the generator behind
 * the July 2026 ColdCard entropy flaw. Faithful pure-JS reimplementation of the
 * C source (exact uint32 wrap-around arithmetic):
 *
 *   pad += dat + d * n;
 *   pad = (pad << 3) + (pad >> 29);
 *   n = pad | 2;
 *   d ^= (pad << 31) + (pad >> 1);
 *   dat ^= (char)pad ^ (d >> 8) ^ 1;
 *   return pad ^ (d << 5) ^ (pad >> 18) ^ (dat << 1);
 *
 * The entire output stream is a pure function of the three seed words captured
 * at first call (dat starts at 0):
 *   pad = *MP_HAL_UNIQUE_ID_ADDRESS ^ SysTick->VAL   // 32-bit uid XOR SysTick(<=24b)
 *   n   = RTC->TR                                    // BCD wall-clock hh:mm:ss
 *   d   = RTC->SSR                                   // sub-second counter
 *
 * So the searchable space is uid × SysTick × TR × SSR — far smaller than the
 * nominal 72 uniform bits, and it collapses further if the seed time is known.
 */

export interface YasmarangSeed {
  pad: number; // uid ^ systick
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
    // pad += dat + d * n;   (d*n is a 32-bit multiply → Math.imul)
    this.pad = (this.pad + this.dat + Math.imul(this.d, this.n)) >>> 0;
    // pad = (pad << 3) + (pad >> 29);   (rotate-left 3)
    this.pad = (((this.pad << 3) >>> 0) + (this.pad >>> 29)) >>> 0;
    // n = pad | 2;
    this.n = (this.pad | 2) >>> 0;
    // d ^= (pad << 31) + (pad >> 1);
    this.d = (this.d ^ ((((this.pad << 31) >>> 0) + (this.pad >>> 1)) >>> 0)) >>> 0;
    // dat ^= (char)pad ^ (d >> 8) ^ 1;   (dat is uint8)
    this.dat = (this.dat ^ (this.pad & 0xff) ^ ((this.d >>> 8) & 0xff) ^ 1) & 0xff;
    // return pad ^ (d << 5) ^ (pad >> 18) ^ (dat << 1);
    return (this.pad ^ ((this.d << 5) >>> 0) ^ (this.pad >>> 18) ^ ((this.dat << 1) >>> 0)) >>> 0;
  }

  /** Fill `n` bytes from the stream, taking 4 little-endian bytes per call. */
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

/** Build the seed from the raw device words. */
export function seedFrom(uid: number, systick: number, rtcTr: number, rtcSsr: number): YasmarangSeed {
  return { pad: (uid ^ systick) >>> 0, n: rtcTr >>> 0, d: rtcSsr >>> 0 };
}

/** Encode wall-clock h/m/s as the STM32 RTC->TR BCD register value. */
export function bcdTime(hours: number, minutes: number, seconds: number): number {
  const bcd = (v: number) => ((Math.floor(v / 10) << 4) | v % 10) >>> 0;
  return ((bcd(hours) << 16) | (bcd(minutes) << 8) | bcd(seconds)) >>> 0;
}
