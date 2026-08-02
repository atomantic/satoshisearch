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

## Why this maps onto real threats

The frontier is a yardstick for weak-key classes:

| Depth | What lives there |
|---|---|
| ~40 bits | Brainwallets (human-chosen phrases). Trivially searchable. |
| **72 bits** | **The 2026 ColdCard entropy flaw** — a firmware bug dropped seed entropy from 128 to 72 bits. ~1,082 BTC swept from 1,196 wallets in 41 minutes. |
| 128 bits | BIP39 12-word floor; the ECDLP security of Satoshi's exposed P2PK keys. |
| 256 bits | BIP39 24-word. |

The ColdCard depth (72) sits just **2 bits** above the demonstrated public brute-force frontier (70).
That proximity is the whole story: the flaw put real coins within a hair of reachable space. The
`/keyspace` page renders this directly — the searched region, the exposed-and-funded set still at
risk, and the reference bands on a single 0→256-bit axis.

## Honest math

A linear bit axis is the correct scale because bits are already `log2(keyspace)` — each +1 bit
doubles the work. Doubling your hardware buys exactly one more bit. At ~10^5 keys/s across a typical
machine, 2^72 alone is ~10^8 years. Unbounded grinding never succeeds; the value is entirely in
*bounded* weak-key classes and in watching the frontier move.
