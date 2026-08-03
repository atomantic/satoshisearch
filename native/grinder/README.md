# satoshi-grind

Native hot loop for the SatoshiSearch grinder: **libsecp256k1** + pthreads.

Replaces the pure-JS `@noble/curves` worker for the per-key path
(priv → pub → hash160 ×2 → match). Node still owns sources, policy, vault, and UI.

## Build

Requires `cc`, `cmake`, `make`, `git` (first build clones libsecp256k1).

```sh
# from repo root
npm run grind:build
npm run grind:selftest
npm run grind:bench
```

Or:

```sh
make -C native/grinder
./native/grinder/satoshi-grind --selftest
./native/grinder/satoshi-grind --bench 500000
```

## Runtime

`GrinderPool` auto-detects `native/grinder/satoshi-grind` (dev) or
`build/satoshi-grind` (Docker). Force the JS fallback with:

```sh
SATOSHI_GRIND_JS=1 npm run dev
```

Override binary path:

```sh
SATOSHI_GRIND_BIN=/path/to/satoshi-grind
```

## Protocol

Length-prefixed little-endian frames on stdin/stdout. See
`src/lib/server/grinder/native.ts` and `main.c` for the wire format.

## Modes

| Message | Use |
|---------|-----|
| `BATCH` | Arbitrary privkeys from Node (brainwallet, constants, …) |
| `RANGE` | Sequential scalars `[start, start+count)` generated in C: one `pubkey_create` seeds the walk, then `walk.c` advances `+G` per step |

Puzzle-range and low-entropy sources use `RANGE` automatically when the binary is present.

## satoshi-kangaroo

Second binary in this directory: **Pollard's kangaroo** for interval ECDLP when a puzzle pubkey is
known. Same libsecp256k1 build; multi-threaded tame/wild herds + distinguished points.

```sh
make -C native/grinder                    # both binaries
./native/grinder/satoshi-kangaroo --selftest
./native/grinder/satoshi-kangaroo --pubkey 02… --lo <hex> --hi <hex> --threads 8
```

JSON-line events on stdout (`progress` / `found` / `exhausted` / `cancelled`). Node wraps this via
`src/lib/server/grinder/kangaroo-backends.ts` and the Grinder UI.

For **CUDA / remote GPU** (JeanLucPons, SSH runner, JSONL external backends), see
[`docs/KANGAROO-GPU.md`](../../docs/KANGAROO-GPU.md).

## The RANGE walk

`ec_pubkey_tweak_add(+1)` looks like a cheap "next point" but is not: internally
it runs a full generic `secp256k1_ecmult` plus a modular inversion, so the walk
cost about as much per key as re-deriving it from scratch. `walk.c` replaces it
with what the operation actually is — one `gej_add_ge_var` per key, staying in
Jacobian coordinates — and converts a block of `WALK_BLOCK` points to affine
with a single `fe_inv_var` (Montgomery's trick). That took RANGE from ~165k to
~640k keys/s per core, at which point the loop is bound by HASH160, not secp.

It is the only file that includes libsecp256k1's internal headers; the Makefile
scopes `-I$(SECP)/src` to `walk.o` alone so secp256k1's `hash.h` can't shadow
ours. Those headers are not a stable API, so a libsecp256k1 bump can break this
file — `--selftest` covers the RANGE path and will catch it.

## Expected speed

Measured on an 18-core Apple Silicon Mac (6P + 12E, 17 worker threads):

| Backend | keys/s |
|--------|--------|
| JS `@noble` workers | ~3×10⁴ |
| **satoshi-grind BATCH** | ~4.5×10⁵ |
| **satoshi-grind RANGE** | ~5×10⁶ |

Unbounded 2⁷² search remains infeasible either way — use bounded weak-key sources.

Coldcard expand (Yasmarang → BIP39 PBKDF2 → BIP32) stays in JS workers; that path is PBKDF2-bound, not secp-bound.
