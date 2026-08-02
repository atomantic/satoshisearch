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

Configure in **Settings → Kangaroo runners**: add any number of endpoints (local CPU, local CUDA,
multiple remote GPUs). Toggle **enabled** per runner; Grinder races all enabled ready runners
(first `found` wins, others cancel). Env (`KANGAROO_SSH`, …) can still inject an ad-hoc remote.

Per remote runner: SSH host, remote binary, GPU id, extra args, **Test** probe
(`nvidia-smi -L` + `kangaroo -l`).

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

On the **observatory**, use the UI:

1. **Settings → Kangaroo runners → + Remote GPU**
2. Name it (e.g. `GPU · Tailscale 3090`), set **SSH host** `user@100.x.x.x`, remote binary
3. **Save runner** and leave **Enabled** checked
4. **Test** until the probe succeeds (passwordless SSH required)
5. Optionally keep **CPU (this machine)** enabled to race both
6. **Grinder → Start kangaroo** (checkboxes select a subset; default = all enabled)

Or inject one remote via env (added to the runner list at runtime):

```bash
export KANGAROO_SSH='user@100.120.88.104'
export KANGAROO_JLP_REMOTE_BIN='/opt/Kangaroo/kangaroo'
```

Each remote uses `scripts/kangaroo-ssh-wrapper.sh` with per-runner SSH/env injection.

**Honest multi-runner note:** independent processes do not share distinguished-point tables.
Racing N remotes raises aggregate ops/s but is not as efficient as one multi-GPU JLP job with a
shared herd. Still useful for “laptop CPU + home 3090 + another box.”

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

## Windows + WSL2 GPU runner (mirrored networking)

A Windows box with an NVIDIA GPU makes a fine topology-B runner via **WSL2** — the JLP
binary and sshd live in WSL, using the Windows driver (no Linux driver install). Reference
setup for an RTX 3090:

1. **CUDA toolkit in WSL** (no driver): add NVIDIA's `wsl-ubuntu` apt repo, install
   `cuda-nvcc-12-6` + `cuda-cudart-dev-12-6`, then register the runtime so *non-login SSH
   shells* can find it: `echo /usr/local/cuda/lib64 > /etc/ld.so.conf.d/cuda.conf && ldconfig`.
2. **Build kangaroo**: `make gpu=1 ccap=86 CUDA=/usr/local/cuda CXXCUDA=/usr/bin/g++ all`,
   install to `/opt/Kangaroo/kangaroo`, confirm `kangaroo -l` lists the GPU.
3. **sshd in WSL**: `openssh-server`, key-only (`PasswordAuthentication no`, `AllowUsers <you>`),
   auto-start on WSL boot via `/etc/wsl.conf`:
   ```ini
   [boot]
   command = service ssh start
   ```
4. **Keep WSL alive** (it only runs on demand): register
   [`scripts/gpu-runner-keepalive.ps1`](../scripts/gpu-runner-keepalive.ps1) as a per-user
   logon Scheduled Task so sshd is always reachable.
5. **Open the firewall**: with `networkingMode=mirrored` in `.wslconfig`, WSL shares the host
   IPs (no `netsh portproxy` needed) — but inbound is gated by the **WSL Hyper-V firewall**
   (`DefaultInboundAction=Block`). Run
   [`scripts/gpu-runner-firewall.ps1`](../scripts/gpu-runner-firewall.ps1) **elevated** to allow
   TCP 22 through both the Hyper-V and standard firewalls, scoped to Tailscale + LAN.

The observatory then connects to the host's Tailscale/LAN address as `<you>@host` on port 22
(a `~/.ssh/config` alias keeps `ssh` and `scp` consistent — avoid `-p` in `KANGAROO_SSH_OPTS`,
which `scp` reads as "preserve times", not port).

The observatory runs `ssh` with no agent to inherit, so a key you normally select by hand
with `ssh -i` will not be found: give the host an `IdentityFile` line in `~/.ssh/config`
(preferred — `scp` picks it up too) or add `-i /path/to/key` to the runner's SSH options.
Both the probe and the wrapper layer your options over their own defaults, so naming a key
no longer costs you `BatchMode`.

`nvidia-smi` lives in `/usr/lib/wsl/lib` on WSL2 and WSL only puts that on `PATH` for shells
it launches itself, so an ssh session won't see it. The probe appends that directory before
looking. Kangaroo itself finds CUDA regardless, so a "GPU #0 …" line from `kangaroo -l` is the
real signal that the host is ready.

Kangaroo separates its progress updates with a bare `\r`, so the wrapper turns them into lines
on the GPU host using `stdbuf` from GNU coreutils. On a host without it the run still works,
but updates arrive in ~4KB bursts — roughly a minute of apparent stalling between refreshes.
Stopping a run kills the remote process explicitly, since closing the SSH channel on its own
leaves the job holding the GPU.

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
| `scripts/gpu-runner-keepalive.ps1` | Keep WSL2 runner + sshd alive (logon task) |
| `scripts/gpu-runner-firewall.ps1` | Open TCP 22 to WSL (Hyper-V + standard firewall) |
| `scripts/kangaroo-jlp-example.env` | Env template for topology A |
| `scripts/kangaroo-external-echo.sh` | JSONL plumbing smoke test |
| Settings UI | **Kangaroo backend** card |
| Grinder UI | Start/stop kangaroo + live backend line |
