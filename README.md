# satoshisearch

> The Bitcoin keyspace observatory & white-hat rescue tool. Runs entirely on your own node.

satoshisearch does three things, all backed by your own mempool/electrs node (no third-party
balance APIs, no scraping):

1. **Satoshi Watch** — monitors the Satoshi-era coinbase outputs and reports whether they are still
   untouched, alerting the moment one moves.
2. **Puzzle Tracker + Keyspace** — tracks the [Bitcoin puzzle series](https://btcpuzzle.info/puzzle)
   as an empirical gauge of how much of the keyspace the world has demonstrably searched, and
   visualizes that frontier against known weak-key depths.
3. **Rescue** — a grinder for provably-weak key classes (e.g. the July 2026 ColdCard 72-bit entropy
   flaw) that races attackers to recover funds, with a tamper-evident audit trail so rightful owners
   can be identified and reimbursed.

It is the successor to `satoshifinder` / `bitfinder` / `bitfinderlite`, rebuilt as a self-hosted
Umbrel app.

## Why rebuild — the P2PK correctness fix

The original tools stored *derived P2PKH addresses* for early coinbase coins that actually live in
**P2PK** outputs. electrs does not index P2PK under a derived address, so an address-based balance
query under-reports Satoshi-era coins by ~99.99%. satoshisearch keeps the real `scriptPubKey` and
always queries by **script hash** = `sha256(scriptPubKey)`. Verified: block-1000's coinbase reports
50 BTC by script hash vs 0.00011398 BTC by address.

## Stack

- **SvelteKit + TypeScript**, single Node container (adapter-node).
- **`node:sqlite`** for storage — zero native database deps.
- **`@noble/*` / `@scure/*`** for all crypto (secp256k1, hashes, base58, BIP32/39, tx signing).
- Talks to any mempool.space-compatible REST API — your local Umbrel node or the public instance.

## Development

```sh
cp .env.example .env          # point MEMPOOL_API_URL at your node
npm install
npm run index:puzzles         # derive & classify all 256 puzzles from the chain
npm run dev                   # http://localhost:3117
npm test                      # unit tests (script/P2PK primitives)
```

## Safety posture

- Auto-sweep is **off by default** except for the puzzle bucket (the one class explicitly designed
  to be swept). Sweeping any other class requires a per-hit human approval, and enabling automatic
  sweeping of non-puzzle buckets requires an explicit white-hat attestation.
- Recovered keys are encrypted at rest; the audit log is hash-chained and tamper-evident; a global
  dry-run kill switch defaults to on. See [`docs/RESCUE-POLICY.md`](docs/RESCUE-POLICY.md).

## License

ISC © Zap-O-Matic
