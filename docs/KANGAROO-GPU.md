# Remote GPU kangaroo runner

How to run Pollard's kangaroo on a **CUDA box** (e.g. RTX 3090) while SatoshiSearch keeps
indexing puzzles, vaulting hits, and driving rescue policy.

For *why* kangaroo vs sequential grind, and the sealed / exposed frontier, see
[`KEYSPACE.md`](./KEYSPACE.md).

---

## Mental model

| Role | Machine | Job |
|------|---------|-----|
| **Observatory** | Always-on host (laptop, Umbrel, Tailscale box) | Node / mempool API, puzzle index, UI, vault, sweep policy |
| **GPU runner** | Linux PC with NVIDIA GPU + CUDA | Heavy ECDLP walk only |

SatoshiSearch never embeds CUDA. It **spawns** one of:

| Backend | What runs | Best when |
|---------|-----------|-----------|
| `cpu` | `satoshi-kangaroo` (libsecp256k1) | Dev, demos, small ranges |
| `jlp` | [JeanLucPons/Kangaroo](https://github.com/JeanLucPons/Kangaroo) (or compatible) | GPU on the **same** host as the app |
| `external` | Your command → JSONL on stdout | **Remote** GPU via SSH, forks, RCKangaroo, custom pools |

Configure in **Settings → Kangaroo runner** (CPU / Local CUDA / Remote GPU / Custom) or env
(`KANGAROO_*`). Env wins over file settings when both are set.

The Settings page can **save & enable** a mode, store SSH host / remote binary / extra args, and
**Test SSH + GPU** (runs `nvidia-smi -L` and `kangaroo -l` on the remote host without starting a
solve).

---

## Topology options

### A — App on the GPU box (simplest)

Run `npm run dev` / production **on the 3090 machine**. Point `MEMPOOL_API_URL` at your node
(over Tailscale is fine). Set:

```bash
export KANGAROO_BACKEND=jlp
export KANGAROO_JLP_BIN=/opt/Kangaroo/kangaroo
export KANGAROO_JLP_GPU=1
export KANGAROO_JLP_GPU_ID=0
```

Then:

```bash
npm run kangaroo -- --puzzle 125
# or Grinder UI → Pollard's kangaroo
```

**Pros:** No SSH plumbing; progress and hits stay local.  
**Cons:** App and GPU share one box; not ideal if the GPU PC is flaky or multi-tenant.

Copy-paste env: [`scripts/kangaroo-jlp-example.env`](../scripts/kangaroo-jlp-example.env).

### B — Observatory + remote GPU over SSH (recommended split)

Observatory keeps the UI/DB/vault. The GPU box only has the CUDA binary (and `ssh`).

```
┌─────────────────────┐         SSH          ┌──────────────────────┐
│  Observatory        │ ──────────────────►  │  GPU runner          │
│  satoshisearch      │  in.txt + kangaroo   │  JeanLucPons/CUDA    │
│  KANGAROO_BACKEND=  │ ◄──────────────────  │  RTX 3090            │
│    external         │  stdout/stderr parse │                      │
└─────────────────────┘                      └──────────────────────┘
```

On the **observatory**, either use the UI:

1. **Settings → Kangaroo runner → Remote GPU (SSH)**
2. Fill **SSH host** (`user@gpu-box`), remote binary, optional GPU id / extra args
3. **Save & enable runner**
4. **Test SSH + GPU** until the probe succeeds
5. **Grinder → Start kangaroo** (or `npm run kangaroo -- --puzzle N`)

Or set env (same effect):

```bash
export KANGAROO_MODE=remote-gpu
# or: KANGAROO_BACKEND=external + KANGAROO_SSH=…
export KANGAROO_SSH='user@gpu-box'
export KANGAROO_JLP_REMOTE_BIN='/opt/Kangaroo/kangaroo'
# export KANGAROO_SSH_OPTS='-o BatchMode=yes -o ConnectTimeout=10'
# export KANGAROO_WRAPPER=scripts/kangaroo-ssh-wrapper.sh
```

The app auto-builds  
`scripts/kangaroo-ssh-wrapper.sh {pubkey} {lo} {hi}`  
and injects `KANGAROO_SSH` / remote bin into the child env.

See [`scripts/kangaroo-ssh-wrapper.sh`](../scripts/kangaroo-ssh-wrapper.sh) — it:

1. Builds a JLP `in.txt` (range + pubkey)
2. `scp`s it to the GPU host
3. Runs `kangaroo -t 0 -gpu …` over SSH
4. Translates JLP progress / `Priv:` lines into the JSONL protocol the app expects

**Pros:** Vault and node credentials stay off the gaming PC; GPU can sleep or reboot independently.  
**Cons:** Needs passwordless SSH (or agent); network blips abort the job unless you add workfile resume on the remote side.

### C — Shared workdir / NFS

Mount a shared directory; run JLP by hand on the GPU box with the same `in.txt` the app would write,
and only use SatoshiSearch for indexing + manual hit import. This is operationally freer but not
wired into the auto vault/rescue path — prefer A or B for automated hits.

---

## Build the CUDA solver (RTX 3090)

On the **GPU runner** (Linux + proprietary NVIDIA drivers + CUDA toolkit):

```bash
# Drivers: nvidia-smi should show the 3090
nvidia-smi

git clone https://github.com/JeanLucPons/Kangaroo.git
cd Kangaroo

# Edit makefile: CUDA= and CXXCUDA= paths for your toolkit if needed
# Compute capability 8.6 = RTX 3090 / 3080 / A6000 class
make gpu=1 ccap=86 all

./kangaroo -l          # list CUDA devices
sudo install -m 755 kangaroo /opt/Kangaroo/kangaroo
```

Other cards: set `ccap` to that GPU’s compute capability (e.g. 4090 → often `89`, 2080 Ti → `75`).
See NVIDIA’s CUDA GPU compute capability table.

### Interval size limits

**Stock JeanLucPons is limited to ~125-bit intervals.** That covers many historical kangaroo
targets; it does **not** magically open #140 (~139-bit width → ~2^69.5 work) without a fork or a
different solver (e.g. RCKangaroo / community forks). Point `KANGAROO_JLP_BIN` (or the remote bin
in the SSH wrapper) at whatever binary you trust and have reviewed.

---

## Wire-up checklist

### GPU host

- [ ] `nvidia-smi` healthy  
- [ ] CUDA kangaroo binary builds and `-l` lists the device  
- [ ] For topology B: `sshd` up; observatory can `ssh user@gpu-box nvidia-smi` without a password prompt  
- [ ] Optional: dedicated user + directory for workfiles (`-w` / `-wi` for long runs)

### Observatory

- [ ] Puzzles indexed: `npm run index:puzzles` (pubkeys stored for exposed targets)  
- [ ] Backend configured (`jlp` for A, `external` + SSH wrapper for B)  
- [ ] Vault key set if you want recovered keys encrypted at rest  
- [ ] Rescue policy understood (`docs/RESCUE-POLICY.md`) — dry-run default is hold-not-broadcast  

### Smoke test

```bash
# CPU path (no GPU) — proves app plumbing
npm run kangaroo:selftest
npm run kangaroo -- --pubkey <known> --lo 1000 --hi 2000

# GPU path (topology A)
KANGAROO_BACKEND=jlp KANGAROO_JLP_BIN=/opt/Kangaroo/kangaroo \
  npm run kangaroo -- --puzzle 85   # smaller exposed range if still funded historically

# Remote path (topology B)
KANGAROO_BACKEND=external \
KANGAROO_EXTERNAL_CMD='scripts/kangaroo-ssh-wrapper.sh {pubkey} {lo} {hi}' \
KANGAROO_SSH=user@gpu-box \
  npm run kangaroo -- --puzzle 125
```

---

## JSONL protocol (external backend)

Any `KANGAROO_EXTERNAL_CMD` process must write **one JSON object per line** on stdout
(stderr is also scanned):

| `event` | Meaning | Fields |
|---------|---------|--------|
| `progress` | Live stats | `ops`, `dps`, `opsPerSec`, `elapsedMs` |
| `found` | Key recovered | `priv` (hex, ideally 64 chars), `ops`, `elapsedMs` |
| `exhausted` | Hit max-ops / solver quit empty | `ops`, `elapsedMs` |
| `cancelled` | SIGTERM / user stop | `ops`, `elapsedMs` |
| `error` | Fatal | `message` |

**Template placeholders** (also available as env vars):

| Placeholder | Env | Value |
|-------------|-----|--------|
| `{pubkey}` | `KANGAROO_PUBKEY` | Compressed/uncompressed pubkey hex |
| `{lo}` `{hi}` | `KANGAROO_LO` / `_HI` | Range as stored (may be odd-length hex) |
| `{lo64}` `{hi64}` | `KANGAROO_LO64` / `_HI64` | Zero-padded 64 hex chars |
| `{threads}` | `KANGAROO_THREADS` | From grind pace max workers (CPU-oriented) |
| `{dp}` | `KANGAROO_DP` | DP bits if set |
| `{max_ops}` | `KANGAROO_MAX_OPS` | Cap if set |
| `{puzzle}` | `KANGAROO_PUZZLE` | Puzzle N when started from UI/CLI |

Demo (no real solve): `scripts/kangaroo-external-echo.sh`.

---

## Long runs and workfiles

JeanLucPons supports periodic work saves (`-w`, `-wi`, `-ws`). For multi-day GPU jobs:

1. Put workfile paths on the **GPU host** disk (fast local SSD), not a flaky network mount.  
2. Pass them via `KANGAROO_JLP_EXTRA` (local jlp) or `KANGAROO_JLP_EXTRA` inside the SSH wrapper env.  
3. After a reboot, re-run with the same range/key and `-i workfile` (add to extra args).  

The stock SSH wrapper does **not** auto-resume; extend it with a stable remote work path if you need crash recovery.

---

## Security notes

- **Private keys** recovered by kangaroo go through the same hit pipeline as the grinder: encrypt
  with `VAULT_KEY_HEX` when configured, audit log, optional auto-sweep for the `puzzle` bucket.  
- Prefer topology **B** so the gaming PC never holds your vault key or RPC credentials.  
- SSH: use key auth, `BatchMode=yes`, restrict the remote account to run only the kangaroo binary
  if you can (wrapper + forced command).  
- Mempool front-running: when you eventually *spend* a found key, use the same careful broadcast
  practices as any puzzle claim (private relay / high fee / avoid leaking pubkey earlier than needed).
  Kangaroo itself only needs the **already-public** puzzle pubkey.  
- Do not expose an unauthenticated JLP **server mode** (`-s`) to the open internet.

---

## Honest performance expectations

| Setup | Rough class |
|-------|-------------|
| Laptop CPU `satoshi-kangaroo` | ~10⁶–10⁷ ops/s |
| Single RTX 3090 + good CUDA kangaroo | ~10⁸–10⁹+ ops/s (solver-dependent) |
| Multi-GPU / pool | What actually moves deep ECDLP frontiers |

Work for puzzle \(n\) with known pubkey ≈ \(2^{(n-1)/2}\) group operations. A 3090 is a large
upgrade over a laptop; it is **not** “solve #140 overnight.” See frontier notes in `KEYSPACE.md`.

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| `backend unavailable` / jlp | `KANGAROO_JLP_BIN` path exists; binary is CUDA build (`-l` works) |
| SSH wrapper hangs | Passwordless SSH; `KANGAROO_SSH`; firewall; remote `nvidia-smi` |
| `bad --lo/--hi` on CPU only | Upgrade binary (odd-length hex ranges fixed); GPU path pads via wrapper |
| Progress stuck at 0 on jlp | Solver prints to stderr with `\r` — app parses both; ensure you’re not redirecting away |
| Found key but no vault entry | `VAULT_KEY_HEX` / Settings vault; audit log `hit-store-failed` |
| Stock JLP rejects large range | Interval &gt; ~125 bits — need fork / other solver via `external` |

---

## Related files

| Path | Role |
|------|------|
| `src/lib/server/grinder/kangaroo-backends.ts` | cpu / jlp / external dispatch |
| `src/lib/server/grinder/kangaroo-engine.ts` | UI engine + hit pipeline |
| `scripts/kangaroo.ts` | CLI |
| `scripts/kangaroo-ssh-wrapper.sh` | Remote GPU JSONL adapter |
| `scripts/kangaroo-jlp-example.env` | Env template for topology A |
| `scripts/kangaroo-external-echo.sh` | JSONL plumbing smoke test |
| Settings UI | **Kangaroo backend** card |
| Grinder UI | Start/stop kangaroo + live backend line |
