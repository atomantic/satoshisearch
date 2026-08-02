# Realtime rescue runner

A **process**, not a hero moment. The ColdCard event is over; the goal is a repeatable
path for the *next* weak-key class: grind continuously, match a fresh funded set, vault
keys, notify, and only auto-sweep when policy is deliberately armed.

## Architecture

```
┌─────────────────────┐     ┌──────────────────────┐
│  UI (optional)      │     │  rescue-runner (CLI)  │
│  pm2: satoshisearch │     │  pm2: rescue-runner   │
└─────────┬───────────┘     └──────────┬───────────┘
          │                            │
          │         DATA_DIR           │
          │   ┌──────▼──────┐          │
          └──►│ SQLite      │◄─────────┘
              │ hits/audit  │
              │ match-set   │
              └──────┬──────┘
                     │ hit
              ┌──────▼──────┐
              │ sweeper     │── policy gates ──► dry-run / hold / broadcast
              │ notify      │── webhook / file
              └─────────────┘
```

The runner **owns the grind loop** in its process. The UI can still view hits/audit
against the same database. Do not start the same source in UI *and* runner (two
processes = two cursors fighting).

## Grinder pace (overnight / light)

In **Settings → Grinder pace** (or env `GRIND_PACE` / `GRIND_MAX_WORKERS` / `GRIND_THROTTLE_MS`):

| Pace | Workers | Throttle | Batch size |
|------|---------|----------|------------|
| **light** | 2 (default) | 150 ms between jobs | ~25% |
| **normal** | cores − 1 | none | 100% |
| **full** | all cores | none | 100% |

Light is for gentle overnight exercise without pegging every core. Changes apply on the
**next** grind start (stop/start if already running). The rescue runner reads the same settings.

## Pre-flight

```sh
npm run rescue:check
# or
npx tsx scripts/rescue-runner.ts check --bucket coldcard
```

| Gate | Grind | Dry-run sweep | Live sweep |
|------|-------|---------------|------------|
| Match-set non-empty | required | required | required |
| Audit chain intact | required | required | required |
| Vault key | recommended | recommended | **required** |
| Rescue destination | — | required | required |
| Bucket in auto list + white-hat (non-puzzle) | — | required | required |
| `SWEEP_DRY_RUN=false` | — | — | **required** |

Defaults stay safe: dry-run on, puzzle-only auto-sweep, empty dest → hold.

## Run a race

```sh
# 1. Fresh funded single-key set (own node preferred)
npm run richlist:from-utxo -- --file /path/to/utxo.dat --import
# or bootstrap:
npm run richlist:refresh

# 2. Settings UI or env: vault, dest address, policy
#    For coldcard live: SWEEP_AUTO_BUCKETS includes coldcard + white-hat attestation
#    Keep SWEEP_DRY_RUN=true until you are sure.

# 3. Notifications (optional but recommended)
export RESCUE_WEBHOOK_URL=https://hooks.example/…
export RESCUE_NOTIFY_FILE=./data/rescue-hits.jsonl

# 4. Arm the runner
npm run rescue:run -- --source coldcard --resume --refresh-hours 12

# Require live policy before starting:
npm run rescue:run -- --source coldcard --require-live --resume
```

### PM2

```sh
pm2 start ecosystem.config.cjs --only rescue-runner
# Edit ecosystem env: RESCUE_SOURCE, RESCUE_REFRESH_HOURS, etc.
```

## What “realtime” means here

1. **Always-on grind** for the active weak class (source + resume cursor).  
2. **Fresh match-set** on a timer (richlist refresh) so newly funded weak wallets enter the set.  
3. **Immediate hit path**: encrypt → audit → claim → policy decide → optional broadcast.  
4. **Push notify** so you are not staring at the UI.  
5. **Readiness check** so you do not discover mid-race that the vault or dest was empty.

It does **not** mean you will out-compute a GPU farm on an unpinned 2⁷² slogan. Realtime
rescue wins when:

- the **effective state space is pinned** (device/time/class model), and/or  
- you **started offline prep early**, and  
- your **match-set + sweep path** is already armed when the public scramble starts.

## Notifications

| Env | Behavior |
|-----|----------|
| `RESCUE_WEBHOOK_URL` | POST JSON on hit / runner lifecycle |
| `RESCUE_NOTIFY_FILE` | Append JSONL lines |
| `RESCUE_NOTIFY_CMD` | Shell with `RESCUE_NOTIFY_JSON` |

Payload fields include `event`, `bucket`, `address`, `balanceSats`, `action` (held/dry-run/swept), `txid`.

## Playbook: next weak-key event

1. **Model the space** (like ColdCard: RNG state → BIP39 → paths, not sequential key range).  
2. **Implement / pin** a grinder source with a bounded config.  
3. `npm run rescue:check -- --bucket <name>` until green for your intended mode.  
4. Refresh match-set from **your node** (UTXO dump).  
5. Start runner with `--resume` and notifications.  
6. Keep dry-run until a test hit signs cleanly; then arm live only if policy allows.  
7. After event: stop runner, export audit/claims, rotate ops notes — do not leave live broadcast on.

## Related

- [RESCUE-POLICY.md](./RESCUE-POLICY.md) — legal/ethical gates  
- [RNG-SPACE.md](./RNG-SPACE.md) — ColdCard-shaped spaces  
- Settings UI — vault, dest, dry-run, buckets, attestation  
