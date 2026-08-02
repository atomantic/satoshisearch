# Dataset provenance

These files are vendored inputs or locally fetched snapshots. Runtime state lives in
SQLite under `data/` after indexing.

| File | Rows | Origin | Use |
|---|---|---|---|
| `richlist.txt.gz` | 415,529 | `bitfinder/data/addresses.txt` — historical top-balance address list circa **2021** (addresses only, no balances). | **Deprecated** for grinding. Kept for reference; prefer `balances-latest.tsv.gz`. |
| `balances-latest.tsv.gz` | varies | Local fetch via `npm run richlist:fetch` from [addresses.loyce.club](http://addresses.loyce.club/) (Blockchair-derived daily dump), filtered to **single-key** scripts (P2PKH + P2WPKH) above `RICHLIST_MIN_SATS` (default 1 BTC). **Not committed** (see `.gitignore`). | Primary richlist match-set + snapshot balances. |
| `fixtures/richlist-sample.tsv` | 2 | Hand-built test fixture (genesis P2PKH + BIP-173 P2WPKH). | Unit/manual import smoke tests. |
| `dormant-coinbase.txt.gz` | 22,274 | `satoshifinder/data/dormant.txt` — early coinbase addresses that held an untouched 50 BTC as of 2021 (address + sats). | Reference/fallback only. The authoritative Satoshi-era set is rebuilt from the chain by `index:coinbase` (P2PK-correct). |
| `phrases/*.txt` | ~160 | `bitfinderlite/data/*.txt` — brainwallet phrase lists. | Seed material for the grinder's `brainwallet` source (SHA256 of each phrase → candidate key). |

## Refreshing the richlist

### From your Bitcoin Core node (preferred)

```sh
# On the Core/Umbrel host — multi‑GB file, several minutes:
bitcoin-cli dumptxoutset /data/utxo-$(date +%F).dat

# Copy to the satoshisearch machine, then parse + import (default ≥ 1 BTC, single-key only):
npm run richlist:from-utxo -- --file /path/to/utxo.dat --import
```

RPC-triggered dump (file still lands on the Core host's datadir):

```sh
export BITCOIN_RPC_URL=http://100.104.209.94:8332
export BITCOIN_RPC_USER=…
export BITCOIN_RPC_PASSWORD=…   # or BITCOIN_RPC_COOKIE=/path/to/.cookie
npm run richlist:from-utxo -- --rpc-dump satoshisearch-utxo.dat
```

### Bootstrap from loyce.club

```sh
npm run richlist:refresh
# or
npm run richlist:fetch -- --min-btc 1 --out datasets/balances-latest.tsv.gz
npm run index:richlist -- --replace datasets/balances-latest.tsv.gz --source loyce
```

See `plans/richlist-refresh.md`.

Script policy drops P2SH / P2WSH / bare multisig (not single-key grindable). P2TR
is deferred. On a grinder hit, snapshot `last_balance` is audited first; live
Esplora balance is preferred when the node answers.

## Why the coinbase set is rebuilt, not imported

`dormant-coinbase.txt` stores *derived P2PKH addresses* for coins that live in **P2PK**
outputs. electrs will not return P2PK balances by that address, so importing these
directly reproduces the original ~99.99% under-reporting bug. The rebuild
(`npm run index:coinbase`) reads the real coinbase `scriptPubKey` from each block
and keys balances on `sha256(scriptPubKey)`. The vendored file is kept only for
cross-checking address coverage.
