# satoshisearch

> The Bitcoin keyspace observatory & white-hat rescue tool. Runs entirely on your own node.

satoshisearch does three things, all backed by your own mempool/electrs node (no third-party
balance APIs, no scraping):

1. **Satoshi Watch** — monitors the Satoshi-era coinbase outputs and reports whether they are still
   untouched, alerting the moment one moves.
2. **Puzzle Tracker + Keyspace** — tracks the [Bitcoin puzzle series](https://btcpuzzle.info/puzzle)
   as an empirical gauge of how much of the keyspace the world has demonstrably searched, and
   visualizes that frontier against known weak-key depths.
3. **Rescue** — a grinder for provably-weak key classes (e.g. the July 2026 ColdCard weak-RNG seed
   states → BIP39/BIP32, not sequential 72-bit keys) that races attackers to recover funds, with a
   tamper-evident audit trail so rightful owners can be identified and reimbursed.

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
- **`@noble/*` / `@scure/*`** for wallet crypto (hashes, base58, BIP32/39, tx signing).
- **Native grinder + kangaroo** (`native/grinder`, C + [libsecp256k1](https://github.com/bitcoin-core/secp256k1)):
  sequential key matching (`satoshi-grind`) and Pollard's kangaroo for exposed-puzzle ECDLP
  (`satoshi-kangaroo`). Falls back to JS workers for sequential grind if the binary is missing.
- Talks to any mempool.space-compatible REST API — your local Umbrel node or the public instance.

## Development

```sh
cp .env.example .env          # point MEMPOOL_API_URL at your node
npm install
npm run grind:build           # optional but recommended: satoshi-grind + satoshi-kangaroo
npm run kangaroo:selftest     # Pollard's kangaroo self-check
npm run index:puzzles         # derive & classify all 256 puzzles from the chain
npm run richlist:refresh      # fetch ≥1 BTC single-key richlist (loyce) + import
npm run rescue:check          # pre-flight for a realtime weak-key race
npm run dev                   # http://localhost:3117
npm test                      # unit tests (script/P2PK primitives)
```

Native tools need `cc`, `cmake`, `make`, and `git` once (clones libsecp256k1). Without them the
app still runs sequential grind via JS workers (`SATOSHI_GRIND_JS=1` forces that path); kangaroo
requires a backend (CPU binary and/or CUDA). See `native/grinder/README.md`, `docs/KEYSPACE.md`,
and **`docs/KANGAROO-GPU.md`** for a remote RTX 3090 / JeanLucPons setup (including SSH runner).

For an always-on weak-key race (separate from the UI process):

```sh
npm run rescue:check
npm run rescue:run -- --source coldcard --resume --refresh-hours 12
# or: pm2 start ecosystem.config.cjs --only rescue-runner
```

See `docs/RESCUE-RUNNER.md` and `docs/RESCUE-POLICY.md`.

### Richlist / grinder match-set

The grinder matches candidates against a **local** set of funded single-key scripts
(P2PK / P2PKH / P2WPKH), not by querying the node per address.

**Production (own node, preferred):** parse a Bitcoin Core `dumptxoutset` file
(Core ≥28 snapshot format). The dump is written on the Core host — copy it here, then:

```sh
# On Umbrel / Core host (path is on that machine):
bitcoin-cli dumptxoutset /data/utxo-$(date +%F).dat
# Or configure RPC in the Settings UI (saved to data/settings.json), then:
#   npm run richlist:from-utxo -- --rpc-dump satoshisearch-utxo.dat

# After copying the .dat file to this machine:
npm run richlist:from-utxo -- --file /path/to/utxo.dat --import
```

**Bootstrap (third-party daily dump):**

```sh
npm run richlist:refresh                  # loyce ≥1 BTC single-key + import
# or:
npm run richlist:fetch -- --min-btc 1
npm run index:richlist -- --replace datasets/balances-latest.tsv.gz --source loyce
```

On a hit, snapshot balance is audited and live Esplora is preferred for truth.
See `plans/richlist-refresh.md` and `datasets/PROVENANCE.md`.

## Access over Tailscale

The app binds to all interfaces, so it's reachable at your machine's MagicDNS name on port 3117.

**Dev** (`npm run dev`) — works out of the box; any `*.ts.net` host is allowed:

```
http://<machine>.<tailnet>.ts.net:3117
```

**Production** (`npm run build && npm start`) — form submissions are CSRF-checked against the request
origin, and over plain HTTP the server can't infer the scheme, so tell it the URL you browse to:

```sh
ORIGIN=http://<machine>.<tailnet>.ts.net:3117 npm start
```

**Nicer: HTTPS via Tailscale Serve** — get a real cert and drop the port, no `ORIGIN` needed if you
forward the scheme header:

```sh
tailscale serve --bg 3117                    # proxies https://<machine>.<tailnet>.ts.net → :3117
PROTOCOL_HEADER=x-forwarded-proto npm start  # Tailscale sets x-forwarded-proto: https
```

Then browse to `https://<machine>.<tailnet>.ts.net`. On Umbrel, the app's built-in proxy already
handles this — access it the way you reach any other Umbrel app.

## Safety posture

- Auto-sweep is **off by default** except for the puzzle bucket (the one class explicitly designed
  to be swept). Sweeping any other class requires a per-hit human approval, and enabling automatic
  sweeping of non-puzzle buckets requires an explicit white-hat attestation.
- Recovered keys are encrypted at rest; the audit log is hash-chained and tamper-evident; a global
  dry-run kill switch defaults to on. See [`docs/RESCUE-POLICY.md`](docs/RESCUE-POLICY.md).

## License

ISC © Zap-O-Matic
