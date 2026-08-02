# Dataset provenance

These files are vendored inputs, carried over from the predecessor projects. They are *source
material*, not runtime state — the app decodes/indexes them into the SQLite DB under `data/`.

| File | Rows | Origin | Use |
|---|---|---|---|
| `richlist.txt.gz` | 415,529 | `bitfinder/data/addresses.txt` — a historical top-balance address list assembled from public rich-list sources circa 2021. | Legacy P2PKH addresses decoded to hash160 as grinder match-set material. Not balance-swept on a schedule; a grinder hit is balance-checked on demand. |
| `dormant-coinbase.txt.gz` | 22,274 | `satoshifinder/data/dormant.txt` — early coinbase addresses that held an untouched 50 BTC as of 2021 (address + sats). | Reference/fallback only. The authoritative Satoshi-era set is rebuilt from the chain by `index:coinbase` (P2PK-correct), since these are *derived* P2PKH addresses that under-report P2PK value. |
| `phrases/*.txt` | ~160 | `bitfinderlite/data/*.txt` — brainwallet phrase lists. | Seed material for the grinder's `brainwallet` source (SHA256 of each phrase → candidate key). |

## Why the coinbase set is rebuilt, not imported

`dormant-coinbase.txt` stores *derived P2PKH addresses* for coins that live in **P2PK** outputs.
electrs will not return P2PK balances by that address, so importing these directly reproduces the
original ~99.99% under-reporting bug. The rebuild (`npm run index:coinbase`) reads the real coinbase
`scriptPubKey` from each block and keys balances on `sha256(scriptPubKey)`. The vendored file is kept
only for cross-checking address coverage.
