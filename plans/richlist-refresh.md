# Plan: Recent single-key richlist for the grinder

**Status:** Phase 1 + Phase 2 implemented (2026-08-02) — loyce bootstrap; Core `dumptxoutset` parse + import; Fulcrum hit-verify still optional Phase 3  
**Date:** 2026-08-02  
**Goal:** Replace the stale ~415k address-only richlist (2021, bitfinder) with a fresh, balance-aware, **single-key-spendable** match-set built from our own stack where possible, with a practical bootstrap path and live verification on hits.

### Phase 1 results (loyce bootstrap)

| Metric | Value |
|--------|--------|
| Source | loyce LATEST stream-filter |
| Min balance | 1 BTC (`100_000_000` sats) |
| Kept (P2PKH+P2WPKH) | **741,185** |
| of which P2WPKH | 480,421 |
| of which P2PKH | 260,764 |
| Dropped P2SH / P2WSH / P2TR | 191,289 / 29,966 / 13,418 |
| Commands | `npm run richlist:refresh` |

### Phase 2 (Core UTXO)

| Piece | Location |
|-------|----------|
| RPC client | `src/lib/server/bitcoin/rpc.ts` |
| Dump parser (v2 + compression) | `src/lib/server/bitcoin/utxo-dump.ts` |
| CLI | `npm run richlist:from-utxo -- --file utxo.dat --import` |
| RPC dump trigger | `npm run richlist:from-utxo -- --rpc-dump name.dat` |

---

## 1. Problem

### Current state

| Piece | Today |
|-------|--------|
| Match-set material | `datasets/richlist.txt.gz` — ~415,529 legacy **P2PKH addresses only**, no balances, **~2021** provenance (`bitfinder/data/addresses.txt`) |
| Importer | `src/lib/server/indexer/richlist.ts` — decodes Base58 P2PKH → `hash160`; skips everything else; leaves `last_balance` null |
| Grinder hot path | Local `Set` of hash160s + pubkeys; **no network** per candidate (correct) |
| Hit path | Always `scriptBalance()` against Esplora (`MEMPOOL_API_URL`, currently `http://100.104.209.94:3006`) |
| Coinbase / puzzles | Indexed separately from the chain; stay authoritative for those datasets |

### Why it is wrong for rescue

1. **Stale** — five-year-old address list; many balances moved; many new funded keys missing.  
2. **P2PKH-only** — modern wallets are heavily **P2WPKH** (`bc1q…`); coldcard/brainwallet hits often land there.  
3. **No balances in the set** — cannot prioritize or show snapshot value without a live node call.  
4. **Wrong tool for refresh** — re-querying millions of addresses via Esplora/Fulcrum is too slow for a nightly rebuild.

### What the grinder already does right

- Candidates are matched **locally** against an in-memory set (EC + hash160 + `Set` lookup).  
- Network is only for **hits** (and separate indexers/sweeps).  
- P2PK is handled via raw pubkey matching (coinbase/exposed puzzles), not address derivation.

This plan **keeps** that architecture. It only upgrades **what goes into the match-set** and **how hit balances are resolved**.

---

## 2. Goals

1. **Fresh richlist** of funded, **single-key-spendable** outputs, with balances and tip/snapshot metadata.  
2. **Skip multisig / multi-party scripts** by script type (not a denylist of famous addresses).  
3. **Primary production path:** nightly dump from **our Bitcoin Core** UTXO set.  
4. **Bootstrap / fallback path:** stream-filter [addresses.loyce.club](http://addresses.loyce.club/) (Blockchair-derived daily TSV) when RPC dump is not yet wired.  
5. **Hit balance:** use snapshot balance first; **double-check live** via Esplora and/or Fulcrum before any rescue action.  
6. **Stay honest:** grinder never queries the network per candidate; match-set size stays in a practical range (default threshold **≥ 0.1 BTC** or **≥ 1 BTC** — decide in §10).  
7. **Do not regress** coinbase P2PK correctness or puzzle indexing.

### Non-goals (this plan)

- Moving coldcard PBKDF2 into workers (separate perf plan).  
- WASM secp / binary match-set keys (optional later if set size hurts keys/s).  
- Auto-sweep policy changes for the `richlist` bucket (still held + human review per `docs/RESCUE-POLICY.md`).  
- Full UTXO history or spent-address archives.  
- Using Fulcrum/Esplora as the bulk richlist source.

---

## 3. Node inventory (this environment)

Probed 2026-08-02 against `100.104.209.94`:

| Endpoint | Role | Use in this plan |
|----------|------|------------------|
| `http://…:2100/` | Umbrel **Bitcoin app UI** | Human only — not an API |
| `http://…:8332/` | **Bitcoin Core 31** JSON-RPC | **Primary** `dumptxoutset` + chain tip metadata |
| `http://…:2109/` | Umbrel **Fulcrum app UI** | Human only |
| `tcp://…:50002` | **Fulcrum 2.1.1** Electrum protocol | Optional live balance verify on hits |
| `tcp://…:50001` | **electrs 0.11.1** Electrum protocol | Alternate index; Mempool may use electrum backend |
| `http://…:3006/` | Mempool/Esplora REST | Existing live verify; already in `.env` |

**Constraint:** Core RPC requires Umbrel credentials (cookie or `rpcuser`/`rpcpassword`). The UI ports are not substitutes.

---

## 4. Architecture

### 4.1 High-level flow

```
                    ┌─────────────────────────────────────┐
                    │  Source A (production): Core        │
                    │  dumptxoutset → parse UTXOs         │
                    │  → aggregate by script              │
                    │  → filter type + min balance        │
                    └─────────────────┬───────────────────┘
                                      │
                    ┌─────────────────▼───────────────────┐
                    │  Source B (bootstrap): loyce TSV    │
                    │  stream sorted dump → stop at min   │
                    │  → decode addresses → same filters  │
                    └─────────────────┬───────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │  datasets/balances-YYYY-MM-DD.tsv.gz│
                    │  + snapshot meta (height, source)   │
                    └─────────────────┬───────────────────┘
                                      │  npm run index:richlist
                                      ▼
                    ┌─────────────────────────────────────┐
                    │  SQLite target (dataset=richlist)   │
                    │  hash160 / pubkey / last_balance    │
                    └─────────────────┬───────────────────┘
                                      │  grinder start → loadMatchSet()
                                      ▼
                    ┌─────────────────────────────────────┐
                    │  Worker match-set (hash160 + pubkey)│
                    │  NO network on hot path             │
                    └─────────────────┬───────────────────┘
                                      │  on hit
                                      ▼
                    ┌─────────────────────────────────────┐
                    │  balance = snapshot last_balance    │
                    │  live = Esplora and/or Fulcrum      │
                    │  rescue only if live confirms       │
                    └─────────────────────────────────────┘
```

### 4.2 Script-type policy (skip multisig)

A single private key from the grinder can only spend these forms. Everything else is excluded from the richlist match-set.

| Keep | Match key in grinder | Rationale |
|------|----------------------|-----------|
| **P2PK** | raw `pubkey` | Satoshi-era / exposed keys; already supported |
| **P2PKH** | `hash160` | Classic `1…` |
| **P2WPKH** | `hash160` (same as compressed pubkey hash) | Modern default; **must add** |
| **P2TR** (keypath only) | x-only pubkey (32 bytes) — **optional phase 2** | Requires worker change to derive x-only and match |

| Drop | Why |
|------|-----|
| Bare **multisig** (`OP_m … OP_n CHECKMULTISIG`) | Multi-key; not grindable as single priv |
| **P2WSH** | Almost always multi/complex; single key cannot spend |
| **P2SH** (default) | Hash of redeem script — cannot distinguish nested-P2WPKH from multisig without redeem data; **exclude by default** |
| Unknown / nonstandard | Cannot spend safely |

**Note:** Many exchange “multisig” wallets are P2SH/P2WSH; excluding those script types drops them without a denylist. Nested single-key P2SH-P2WPKH is excluded under default P2SH policy (acceptable tradeoff; can revisit later if redeem data is available from the UTXO path — it is not on standard P2SH outputs alone).

### 4.3 Balance threshold

Measured on loyce LATEST (2026-08-01), **all address types**, sorted high→low:

| Min balance | Approx. address count |
|-------------|------------------------|
| ≥ 100 BTC | ~20k |
| ≥ 10 BTC | ~150k |
| ≥ **1 BTC** | ~**977k** |
| ≥ **0.1 BTC** | ~**4.51M** |

Single-key-only counts will be **lower** (drop P2SH/P2WSH-heavy custodial mass). Still plan memory for up to ~5M hash160s.

**Default recommendation:** start with **≥ 1 BTC** for first import (closer to old 415k scale, high signal); make threshold a CLI/env flag so 0.1 BTC is one switch away.

### 4.4 Snapshot vs live balance

| Stage | Source | Role |
|-------|--------|------|
| Import | Dump / loyce | `first_balance` / `last_balance`, `last_checked_at` = snapshot time |
| Hit record | Snapshot first | Fast, no node load; `balance_at_find` may note source |
| Before sweep / claim seriousness | Live Esplora (`scriptBalance` / UTXO sum) and optionally Fulcrum `blockchain.scripthash.get_balance` | Truth; refuse or hold if live is 0 / dust |

Snapshot may lag up to ~1 day; live check is mandatory for any automated or UI-approved sweep.

---

## 5. Data model & provenance

### 5.1 Schema (mostly already present)

`target` already has `last_balance`, `first_balance`, `last_checked_at`, `script_type`, `hash160`, `pubkey`, `script_hex`. Needed additions:

**Migration — richlist snapshot metadata** (new table preferred over overloading `scan_run` only):

```sql
CREATE TABLE IF NOT EXISTS richlist_snapshot (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,     -- core-utxo | loyce
  created_at    INTEGER NOT NULL,
  tip_height    INTEGER,
  tip_hash      TEXT,
  min_sats      INTEGER NOT NULL,
  script_policy TEXT NOT NULL,   -- e.g. 'p2pk,p2pkh,p2wpkh'
  row_count     INTEGER,
  file_path     TEXT,
  note          TEXT
);
```

Optionally add columns on `target` if useful later:

- `snapshot_id INTEGER` — which import last wrote this row  
- Not required for v1 if `scan_run.note` + `last_checked_at` are enough

**Import semantics for `dataset = 'richlist'`:**

1. Begin transaction (or staged table).  
2. **Replace strategy (recommended):** delete existing `dataset='richlist'` rows, then bulk insert from new dump (simple; match-set is fully rebuilt on next grind start).  
3. Alternative: upsert by address and zero-out balances not in new file (more complex; only if we need history continuity).  

**Recommendation:** full replace of richlist targets per successful import; keep coinbase/puzzle/dormant untouched.

### 5.2 File formats

**Export artifact** (both sources normalize to the same shape):

```text
# datasets/balances-YYYY-MM-DD.tsv.gz  (or .jsonl.gz)
# header optional
address_or_empty \t script_type \t match_kind \t match_hex \t balance_sats \t script_hex_optional
```

| Field | Meaning |
|-------|---------|
| `match_kind` | `hash160` \| `pubkey` \| `xonly` (later) |
| `match_hex` | hex payload for the match-set |
| `script_type` | `p2pk` \| `p2pkh` \| `p2wpkh` \| … |
| `balance_sats` | sum of UTXOs for that script |
| `script_hex` | optional; for P2PK balance verify without address |

**Provenance:** update `datasets/PROVENANCE.md` with source URL/command, tip height, min sats, script policy, row counts, date.

### 5.3 Git / disk policy

- Do **not** commit multi‑GB dumps.  
- Commit small filtered slices only if useful for CI fixtures (e.g. top 100 lines test fixture).  
- Store full filtered dumps under `datasets/` (gitignored) or `DATA_DIR/richlist/`.  
- Keep legacy `richlist.txt.gz` as historical reference until first successful new import; then mark deprecated in PROVENANCE.

---

## 6. Implementation workstreams

### Workstream A — Address / script decoding for import

**Files:** `src/lib/server/script.ts`, new helpers if needed.

- [ ] Decode **bech32 P2WPKH** (`bc1q` + 20-byte program) → hash160.  
- [ ] Keep P2PKH Base58.  
- [ ] Decode P2PK from `script_hex` when present (Core dump path).  
- [ ] Explicitly reject P2SH, P2WSH, bare multisig, invalid.  
- [ ] (Phase 2) bech32m P2TR x-only extraction + worker match.  
- [ ] Unit tests for each type (golden vectors).

### Workstream B — Bootstrap importer: loyce stream filter

**Files:** `scripts/fetch-loyce-richlist.ts` (or shell + `scripts/index-richlist.ts` flags).

- [ ] Download `blockchair_bitcoin_addresses_and_balance_LATEST.tsv.gz` with streaming `curl` \| `gzip -dc`.  
- [ ] File is **sorted by balance descending** — stop when `balance < MIN_SATS` (no need to read entire ~1.7 GB decompressed if we only need the head; compressed stream still reads until threshold).  
- [ ] Apply address decode + script-type policy (loyce is address-based: keep `1…` P2PKH and `bc1q` P2WPKH; drop `3…` P2SH and `bc1p` until phase 2; drop `m-…` P2PK-style if present unless we can map to pubkey — usually skip).  
- [ ] Write normalized `balances-*.tsv.gz` + meta JSON.  
- [ ] Document runtime (~minutes on good link; we previously streamed to 0.1 BTC cut in ~35s for count-only).

**Limitation:** loyce cannot supply true P2PK scriptPubKeys; Core dump remains required for P2PK-rich completeness (already covered by `index:coinbase` for early coinbase).

### Workstream C — Production dump: Bitcoin Core UTXO set

**Files:** `scripts/dump-utxo-richlist.ts` or external tool invoked from npm script; config in `config.ts` / `.env.example`.

1. **RPC config**  
   - `BITCOIN_RPC_URL` (e.g. `http://100.104.209.94:8332`)  
   - `BITCOIN_RPC_COOKIE` path or `BITCOIN_RPC_USER` / `BITCOIN_RPC_PASSWORD`  
   - Never log secrets.

2. **Dump**  
   - Call `dumptxoutset` to a path on the node (or stream if API allows file on server only — typically file lands **on the Core host**).  
   - Capture `getblockchaininfo` tip height/hash before/after for meta.  
   - Ops note: on Umbrel, prefer running the dump **on the host** (disk + docker volume) and copying the filtered TSV to the satoshisearch machine; shipping multi‑GB `utxo.dat` over Tailscale is optional but heavy.

3. **Parse**  
   - Prefer a small dedicated parser (Node stream or existing community tool for Core UTXO dump format for v31).  
   - For each UTXO: classify `scriptPubKey` via existing `classifyScript` (+ strengthen multisig detect).  
   - Aggregate value by script (or by match key).  
   - Filter: keep policy types; `sum >= MIN_SATS`.  
   - Emit normalized TSV.gz.

4. **Cron / Umbrel**  
   - Nightly job off-peak: dump → parse → `npm run index:richlist -- --replace path`.  
   - On failure: leave previous DB richlist intact; audit log `richlist-import-failed`.

**Feasibility:** Reasonable. Unreasonable alternative: N million Electrum/Esplora getbalance calls.

### Workstream D — Richlist indexer rewrite

**Files:** `src/lib/server/indexer/richlist.ts`, `scripts/index-richlist.ts`.

- [ ] Accept normalized TSV (and legacy address-per-line for one release).  
- [ ] Store `script_type`, `hash160` or `pubkey`, `last_balance`, `first_balance`, `last_checked_at`.  
- [ ] Prefer storing reconstructed `script_hex` for P2PKH/P2WPKH when possible (enables `scriptBalance` without address ambiguity).  
- [ ] `--replace` default for richlist dataset.  
- [ ] Record `scan_run` + `richlist_snapshot` row.  
- [ ] Progress logging for multi-million row imports (batched transactions, already pattern in current importer).

### Workstream E — Match-set load & grinder hit path

**Files:** `loadset.ts`, `matchset.ts`, `worker.mjs`, `engine.ts`, optionally new `fulcrum.ts`.

**Match-set load (v1):**

- Unchanged shape: `hash160s: Set`, `pubkeys: Set`.  
- P2WPKH entries already work if hash160 is loaded (worker hashes compressed + uncompressed pubkeys).  
- Ensure import lowercases hex consistently (already).

**Hit path:**

```text
on match:
  target = findTargetByMatch(...)
  snapshotBal = target.last_balance ?? 0
  liveBal = await scriptBalance(script)   // Esplora
  // optional: fulcrumBal = await fulcrumScripthashBalance(...)
  balance = liveBal if live succeeded else snapshotBal
  audit both values
  handleHit(... balance ...)  // existing policy
```

- [ ] If live returns 0 and snapshot was high → treat as moved/empty; hold; do not sweep.  
- [ ] If live fails (node down) → hold with snapshot note; never broadcast without live UTXOs (sweeper already needs UTXOs).  
- [ ] Optional Fulcrum client (Electrum NDJSON over TCP `:50002`) as second live source; not required if Esplora is healthy.

**UI:**

- Grinder page: show match-set size, snapshot source, tip height, min sats, age.  
- Settings: richlist row counts by script_type if cheap.

### Workstream F — Performance guardrails (if set grows to multi‑million)

Not blocking v1, but plan for:

| Risk | Mitigation |
|------|------------|
| Worker init copies multi‑MB string arrays × N cores | Shared binary table or one matcher process |
| Hex `Set` keys | Binary / latin1 keys later |
| SQLite progress every batch | Already separate issue; amortize writes |
| Import time | Batched TX; WAL; large `page_size` if needed |

Measure keys/s before/after with same source (e.g. lowentropy) at 415k vs 1M vs 4M set sizes.

### Workstream G — Tests & docs

- [ ] Unit: decode P2WPKH, reject P2SH/P2WSH/multisig.  
- [ ] Unit: importer dry-run on a tiny fixture TSV.  
- [ ] Integration (optional, node-gated): live balance for a known faucet/dust address.  
- [ ] Update `datasets/PROVENANCE.md`, `README.md` (CLI section), `.env.example` (RPC + min sats + optional Fulcrum).  
- [ ] Note in `docs/RESCUE-POLICY.md` that richlist hits remain held.

---

## 7. Phased delivery

### Phase 0 — Prep (½ day)

- [ ] Obtain Core RPC auth from Umbrel Bitcoin app (cookie or user/pass); verify `getblockchaininfo` from the machine that will dump.  
- [ ] Confirm disk headroom on node for `dumptxoutset` (several GB).  
- [ ] Decide default `MIN_SATS` (recommend **1e8** = 1 BTC).  
- [ ] Add `plans/` reference link from README only if desired (optional).

### Phase 1 — Bootstrap richlist (1–2 days) — **value first**

Ship without waiting on dumptxoutset ops:

1. Script to stream-filter loyce → normalized TSV (P2PKH + P2WPKH, min balance).  
2. Rewrite importer for balances + P2WPKH.  
3. Replace richlist in DB; restart grinder; confirm match-set counts in UI.  
4. Hit path: record snapshot balance; keep live Esplora verify.  
5. PROVENANCE + fixtures.

**Exit criteria:**

- Match-set includes modern bech32 single-key addresses.  
- `last_balance` populated for richlist rows.  
- Grinder keys/s not collapsed (within ~20% of baseline at chosen set size).  
- No Esplora traffic during grind (only on synthetic/test hit).

### Phase 2 — Core UTXO nightly (2–4 days)

1. RPC client + `dumptxoutset` orchestration.  
2. UTXO parse + script filter (include P2PK from scripts).  
3. Same normalized TSV → same importer.  
4. Cron/docs for Umbrel.  
5. Prefer Core dump as default source when available; loyce remains fallback.

**Exit criteria:**

- Successful dump at a known tip height.  
- Import replaces richlist; snapshot meta stored.  
- P2PK single-key funded outputs above threshold appear if any exist outside coinbase index (or document that coinbase index remains the P2PK authority).

### Phase 3 — Hardening (1–2 days)

1. Optional Fulcrum live verify.  
2. UI snapshot age / staleness warning if dump > 36h.  
3. Perf pass if multi‑million set hurts workers.  
4. Optional P2TR keypath matching.

---

## 8. CLI / config sketch

```bash
# Bootstrap (loyce)
npm run richlist:fetch -- --min-btc 1 --out datasets/balances-latest.tsv.gz
npm run index:richlist -- --replace datasets/balances-latest.tsv.gz

# Production (Core) — often run on Umbrel host
npm run richlist:dump-utxo -- --min-btc 1 --out /data/balances-latest.tsv.gz
npm run index:richlist -- --replace /data/balances-latest.tsv.gz
```

```env
# .env.example additions
BITCOIN_RPC_URL=http://100.104.209.94:8332
BITCOIN_RPC_USER=
BITCOIN_RPC_PASSWORD=
# or BITCOIN_RPC_COOKIE=/path/to/.cookie

RICHLIST_MIN_SATS=100000000
RICHLIST_SCRIPT_POLICY=p2pk,p2pkh,p2wpkh

# Optional live verify
FULCRUM_HOST=100.104.209.94
FULCRUM_PORT=50002
```

---

## 9. Risk register

| Risk | Impact | Mitigation |
|------|--------|------------|
| RPC auth / dump only on Umbrel host | Blocks phase 2 | Phase 1 loyce bootstrap; document host-side dump |
| `dumptxoutset` I/O load | Node lag | Nightly off-peak; monitor |
| 4.5M-row match-set memory | OOM / slow init | Default 1 BTC; measure; binary set later |
| Loyce third-party trust | Wrong/stale balances | Live verify on hit; prefer Core soon |
| Excluding all P2SH | Miss nested-P2WPKH single-key | Accept; document; rare for “rich” modern wallets vs native bech32 |
| P2TR not matched in v1 | Miss taproot-only funds | Phase 3 |
| Full replace deletes richlist mid-grind | Empty set race | Refuse import while grinder running, or loadset snapshot isolation |
| Legal/ethics of richlist grinding | Policy | Unchanged: `richlist` bucket held; white-hat attestation for auto-sweep |

---

## 10. Open decisions (resolve before/during phase 1)

1. **Default min balance:** `1 BTC` vs `0.1 BTC`?  
   - **Recommend:** `1 BTC` first; flag for `0.1`.  
2. **P2TR in v1?**  
   - **Recommend:** no — phase 3 (worker + match-set change).  
3. **P2SH nested-P2WPKH:** exclude always, or attempt heuristics?  
   - **Recommend:** exclude always for v1.  
4. **Where nightly job runs:** Umbrel host cron vs satoshisearch container?  
   - **Recommend:** dump/parse on host; import on app host.  
5. **Keep legacy 2021 file in repo?**  
   - **Recommend:** yes until phase 1 proven; then gitignore large replacements and keep fixture only.

---

## 11. Success metrics

| Metric | Target |
|--------|--------|
| Snapshot age in production | ≤ 36 hours when Core cron is live |
| Richlist rows with `last_balance > 0` | 100% of imported richlist |
| Script types in set | Only policy types (assert in import summary) |
| Live verify before sweep | Always (existing sweeper UTXO fetch + explicit balance check) |
| Grind network I/O | Zero except hits |
| Match-set covers P2WPKH | Yes (phase 1 exit) |

---

## 12. Suggested PR breakdown

1. **PR1:** script decode (P2WPKH) + tests + importer accepts `address + balance` TSV; legacy file still works.  
2. **PR2:** `richlist:fetch` loyce stream filter + PROVENANCE + fixture; docs.  
3. **PR3:** hit path snapshot + live dual logging; grinder UI snapshot meta.  
4. **PR4:** Core RPC + dumptxoutset pipeline + cron docs.  
5. **PR5 (optional):** Fulcrum client; P2TR; perf.

---

## 13. Appendix — quick commands (reference)

```bash
# Count-only stream of loyce until under 0.1 BTC (already validated ~4.51M rows)
curl -sL "http://addresses.loyce.club/blockchair_bitcoin_addresses_and_balance_LATEST.tsv.gz" \
  | gzip -dc \
  | awk -F'\t' '$2+0 < 10000000 { exit } { c++ } END { print c }'

# Electrum version probes (this network)
# :50001 → electrs/0.11.1
# :50002 → Fulcrum 2.1.1
```

```text
Umbrel UI ≠ API
  :2100  → Bitcoin app UI
  :2109  → Fulcrum app UI
  :8332  → Core RPC
  :50002 → Fulcrum Electrum
  :3006  → Esplora (satoshisearch default)
```

---

## 14. Summary

The grinder should keep **local match-set** semantics. Upgrade the **inputs**: a recent, balance-tagged, **single-key-only** richlist from **Core UTXO dumps** (production) with **loyce stream-filter** as bootstrap; **skip multisig by script type**; use **snapshot balances** for hit context and **Esplora/Fulcrum** only as live truth before rescue. That is reasonable on our node stack and far better than the 2021 P2PKH-only list or bulk address polling.
