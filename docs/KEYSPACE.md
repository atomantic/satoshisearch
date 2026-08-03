# The keyspace frontier

Bitcoin private keys live in a 256-bit space. Nothing brute-forces that. But not every key is drawn
uniformly from it — weak randomness, human-chosen phrases, and buggy RNGs pull keys into a much
smaller *effective* space. SatoshiSearch measures where the searchable edge actually is.

## The puzzle series as a natural experiment

In 2015 someone funded 256 addresses whose private keys are known to lie in `[2^(n-1), 2^n)` for
n = 1..256. Solving one is a public proof that someone traversed that range. SatoshiSearch derives
all 256 from the funding transaction on your node and classifies each:

- **sealed** — funded, never spent from. Only the address (hash160) is public, so solving it needs a
  full brute force of its n-bit range.
- **exposed** — funded, but spent from at least once, so its public key is on-chain. That falls to
  Pollard's kangaroo at ~2^(n/2) work — a very different threat.
- **solved** — emptied.

## Two frontiers

- **Brute-force frontier** — the largest n such that every *sealed* puzzle ≤ n is solved. This is the
  honest "how deep can the public actually brute-force" number. As of writing it sits at **70 bits**:
  puzzles 71 and 72 are the smallest sealed-and-unsolved ranges.
- **ECDLP frontier** — the deepest *exposed* puzzle solved via kangaroo. Far higher, because n/2 work
  is so much cheaper — but it only applies once a public key is exposed.

## Pollard's kangaroo (CPU + GPU backends)

Exposed puzzles ship with a stored pubkey (`target.pubkey`). Searching them by walking private-key
integers and hashing is the sealed-path algorithm — for exposed keys the right tool is **interval
ECDLP** (Pollard's kangaroo / λ-method): expected ~`2 · √(hi−lo+1)` group operations.

| Backend | Binary / cmd | Hardware |
|---------|----------------|----------|
| **`cpu`** (default) | `satoshi-kangaroo` | Multi-core CPU (libsecp256k1) |
| **`jlp`** | JeanLucPons/Kangaroo CUDA build | NVIDIA GPU on the **same** host |
| **`external`** | Command → JSONL | Remote GPU (SSH), forks, RCKangaroo, … |

```sh
npm run grind:build
npm run kangaroo -- --puzzle 40
```

**Full setup for a remote RTX 3090 (or any CUDA box), topologies, SSH wrapper, workfiles, and
security:** see **[`KANGAROO-GPU.md`](./KANGAROO-GPU.md)**.

Short local-GPU env sketch: [`scripts/kangaroo-jlp-example.env`](../scripts/kangaroo-jlp-example.env).

UI: **Grinder** (pick an exposed target → Start uses kangaroo automatically) and
**Settings → Compute devices**. Hits use the same vault / audit / rescue pipeline as sequential
grinds. Honest math: deep exposed puzzles remain multi-GPU / pool-scale work — a 3090 is a large
upgrade over a laptop, not a skip of the \(\sqrt{\cdot}\) barrier.

## Why this maps onto real threats

The frontier is a yardstick for weak-key classes:

| Depth | What lives there |
|---|---|
| ~40 bits | Brainwallets (human-chosen phrases). Trivially searchable. |
| **~72 bits work** | **The 2026 ColdCard entropy flaw** — weak Yasmarang RNG *seed state*, not keys in `[1, 2^72)`. Each state expands BIP39→BIP32 into ordinary 256-bit keys scattered across the full space. ~1,082 BTC swept from 1,196 wallets in 41 minutes. |
| 128 bits | BIP39 12-word floor; the ECDLP security of Satoshi's exposed P2PK keys. |
| 256 bits | BIP39 24-word. |

### ColdCard ≠ puzzle-72

Puzzle N means: private keys are sequential integers in `[2^(N-1), 2^N)`. ColdCard means:

```
for each RNG state S:          # uid × SysTick × RTC→TR × RTC→SSR
  entropy = Yasmarang(S)
  seed    = BIP39(entropy)
  master  = BIP32(seed)
  derive common paths → match funded scripts
```

The ~72-bit figure is **effective entropy of the RNG seed** (and collapses further when
device uid / creation time are known). It is *not* a claim that the resulting private keys are
small integers. Plotting it next to puzzle-70 is a **work-budget yardstick**, not the same search
geometry. See `docs/RNG-SPACE.md`.

The ColdCard work depth (~72) sits just **2 bits** above the demonstrated public brute-force
frontier (70). That proximity is the whole story: the flaw put real coins within a hair of
reachable *compute*, even though the keys themselves are full-size. The `/keyspace` page renders
this as a reference band on the 0→256 axis.

## Honest math

A linear bit axis is the correct scale because bits are already `log2(keyspace)` — each +1 bit
doubles the work. Doubling your hardware buys exactly one more bit. At ~3×10^4 keys/s (JS) or
~5×10^6 keys/s (native libsecp256k1) on a typical machine, 2^72 alone is still ~10^7–10^8 years.
Unbounded grinding never succeeds; the value is entirely in *bounded* weak-key classes and in
watching the frontier move.

## Multi-machine range farming (personal “collider”)

Sequential puzzle ranges can be **sharded** across hosts so each machine owns a contiguous slab
of \([2^{n-1}, 2^n)\):

```sh
# Host A
npm run rescue:run -- --source puzzle-71 --shard 0/4 --resume
# Host B
npm run rescue:run -- --source puzzle-71 --shard 1/4 --resume
# … 2/4, 3/4
```

Optional **start % / start hex** skips the bottom of the range (or a custom window). Within a
single UI process, selected grind devices already split each batch; use `--shard` when each
host runs its own process.

**Do not assume LBC already scanned half of puzzle 71.** The historical Large Bitcoin Collider
covered much smaller bit depths. Public puzzle-71 pools (e.g. btcpuzzle.info) have reported on
the order of **~1%** class coverage in 2026 — check a live dashboard before skipping. Skipping
is operator policy, not a guarantee those keys are empty.
