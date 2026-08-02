# Weak-RNG space (ColdCard / Yasmarang)

## Mental model

Derived private keys are still **uniform-looking 256-bit secp256k1 scalars**. The flaw is not
“keys live in `[1, 2^72)`”. The flaw is that the **BIP39 entropy** was produced by a weak PRNG
whose **initial state** has far less than 128 bits of uncertainty.

Rescue work therefore looks like:

```
for each possible RNG state S:
    entropy  = generate_rng(S)          # Yasmarang stream → 16 or 32 bytes
    mnemonic = BIP39(entropy)
    master   = BIP32(BIP39_seed(mnemonic))
    for each common derivation path:
        priv → script/address
        if funded in local match-set: hit
```

SatoshiSearch implements exactly that pipeline in `src/lib/server/grinder/coldcard.ts`
(`expandRngState` / worker `coldcard-batch`). Progress is counted in **seed states**, not in
sequential private-key integers.

## State dimensions (Yasmarang)

On first call, MicroPython’s fallback seeds three words (see `yasmarang.ts`):

| Word | Source | Notes |
|------|--------|--------|
| `pad` | `UID_low32 ⊕ SysTick->VAL` | **One 32-bit word** — not independent uid×SysTick entropy |
| `n` | `RTC->TR` | BCD wall-clock; often static `0` on Mk2/Mk3 cold boot |
| `d` | `RTC->SSR` | Sub-second; may also be static on cold boot |

COLDCARD’s wallet path then XORs each word with a **second** Yasmarang that has **public**
libngu constants (`entropyStream: 'libngu-xor'`), and may `sha256d` the 32-byte buffer before
BIP39 (`sha256dEntropy: true` on Mk3/Mk4 presets).

### Device-class presets (`coldcard.ts`)

| Preset | Geometry | Work scale (order of) |
|--------|----------|------------------------|
| `mk3ColdBootConfig(uid)` | known UID, SysTick 0..79 999, RTC=0 | **~2^16.3** |
| `mk3KnownUidConfig(uid, {coldBootRtc:false, trValues, ssr})` | known UID + timers | up to **~2^40** loose |
| `padRangeConfig([lo,hi], …)` | direct pad (UID unknown) | pad width × TR × SSR |
| `mk4ReseedConfig([lo,hi], {n,d})` | fixed fallback timers, free SE reseed | **≤2^32** (slice it) |
| `demoColdcardConfig()` | tiny UI demo, micropython-only | not an attack profile |

**Do not** treat unknown-UID search as `2^32 × 2^24` SysTick — that double-counts. Use **pad** mode.

Searchable **work units** = product of the ranges in the chosen enum mode. Pinning UID and/or
creation-time window is what makes a rescue tractable.

## What “~72 bits” means

Public writeups often summarize Mk4 as “72-bit entropy”. That is a **loose upper band** if you
treat timers as independent; Block notes it is **not** 72-bit cryptographic security. Mk3 is closer
to **~40 bits** (or ~2^16 with known UID + cold-boot RTC). Geometry:

| | Puzzle 72 | ColdCard |
|---|-----------|----------|
| Work unit | private key `k` | RNG state `S` (pad/n/d or reseed) |
| Key location | `k ∈ [2^71, 2^72)` | full 256-bit after BIP32 |
| Acceleration | native `RANGE` + tweak_add | workers + **native OpenSSL PBKDF2** |
| Progress | keys tried / 2^71 | states tried / model size |

## Open items

1. Confirm on-device call packing and whether every production path always applies sha256d +
   libngu XOR (Mk3/Mk4 presets assume yes; UI demo does not).
2. UI to pin uid / reseed range / TR window without editing code.
3. Optional GPU PBKDF2 if multi-core OpenSSL still loses a real race.

## Related code

- `src/lib/server/grinder/yasmarang.ts` — PRNG + libngu XOR
- `src/lib/server/grinder/bip39-seed.ts` — native OpenSSL PBKDF2
- `src/lib/server/grinder/coldcard.ts` — device-class models + expand
- `src/lib/server/grinder/worker.mjs` — `coldcard-batch`
- `src/lib/server/grinder/engine.ts` — seed-state progress metrics
