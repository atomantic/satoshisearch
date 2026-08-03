#!/usr/bin/env bash
# Remote GPU kangaroo adapter for KANGAROO_BACKEND=external.
#
# Runs JeanLucPons-compatible Kangaroo over SSH and emits JSONL for satoshisearch.
#
# Usage (observatory):
#   export KANGAROO_BACKEND=external
#   export KANGAROO_EXTERNAL_CMD='scripts/kangaroo-ssh-wrapper.sh {pubkey} {lo} {hi}'
#   export KANGAROO_SSH='user@gpu-host'           # required
#   export KANGAROO_JLP_REMOTE_BIN='/opt/Kangaroo/kangaroo'  # optional
#   export KANGAROO_SSH_OPTS='-o BatchMode=yes'   # optional
#   export KANGAROO_JLP_EXTRA='-d 18'             # optional remote extra args
#   export KANGAROO_JLP_GPU_ID=0                  # optional
#   npm run kangaroo -- --puzzle 125
#
# Docs: docs/KANGAROO-GPU.md
set -euo pipefail

pubkey="${1:-${KANGAROO_PUBKEY:-}}"
lo="${2:-${KANGAROO_LO:-}}"
hi="${3:-${KANGAROO_HI:-}}"

if [[ -z "$pubkey" || -z "$lo" || -z "$hi" ]]; then
  echo '{"event":"error","message":"kangaroo-ssh-wrapper: need pubkey lo hi"}'
  exit 2
fi

SSH_HOST="${KANGAROO_SSH:-}"
if [[ -z "$SSH_HOST" ]]; then
  echo '{"event":"error","message":"set KANGAROO_SSH=user@gpu-host"}'
  exit 2
fi

REMOTE_BIN="${KANGAROO_JLP_REMOTE_BIN:-/opt/Kangaroo/kangaroo}"
# Caller opts go first — ssh keeps the first value it sees per option, so these
# defaults only fill in what the caller left unset. Appending rather than
# replacing means adding `-i key` doesn't silently drop BatchMode and let a
# passphrase prompt block a headless run.
# shellcheck disable=SC2206
SSH_OPTS=(${KANGAROO_SSH_OPTS:-} -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
GPU_ID="${KANGAROO_JLP_GPU_ID:-0}"
EXTRA="${KANGAROO_JLP_EXTRA:-}"

pad_even() {
  local h="${1#0x}"
  h="${h#0X}"
  if (( ${#h} % 2 == 1 )); then
    h="0${h}"
  fi
  printf '%s' "$h"
}

lo_e="$(pad_even "$lo")"
hi_e="$(pad_even "$hi")"

# Pubkey must remain 33- or 65-byte hex (66 / 130 chars). Strip 0x only.
pub_e="${pubkey#0x}"
pub_e="${pub_e#0X}"
pub_e="$(printf '%s' "$pub_e" | tr 'A-F' 'a-f')"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ss-kang-ssh.XXXXXX")"

REMOTE_TAG="ss-kangaroo-$$"
REMOTE_DIR="/tmp/$REMOTE_TAG"
REMOTE_IN="$REMOTE_DIR/in.txt"
REMOTE_OUT="$REMOTE_DIR/result.txt"
REMOTE_WORK_DIR="/tmp/ss-kangaroo-${pub_e}"
REMOTE_WORK_FILE="$REMOTE_WORK_DIR/kangaroo.work"

# The remote kangaroo has no controlling tty, so closing the ssh channel does not
# reach it — without an explicit kill every Stop leaves a job burning on the GPU
# and the next run competes with it. Bracketing the first character keeps the
# pattern from matching the shell sshd spawns to run this very command, which
# would otherwise kill the session before the kangaroo.
KILL_PATTERN="[${REMOTE_TAG:0:1}]${REMOTE_TAG:1}"

cleanup_delete_work=0
cleaned=0
cleanup() {
  [[ "$cleaned" -eq 1 ]] && return 0
  cleaned=1
  rm -rf "$WORKDIR"
  
  local delete_work=""
  if [[ "$cleanup_delete_work" -eq 1 ]]; then
    delete_work="rm -rf '$REMOTE_WORK_DIR';"
  fi

  # rm before pkill: this command line mentions REMOTE_DIR, so the pattern also
  # matches the shell sshd spawned for the cleanup itself and takes it down —
  # fine as the last act, fatal to anything sequenced after it.
  ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
    "$delete_work rm -rf '$REMOTE_DIR'; pkill -f '$KILL_PATTERN'" >/dev/null 2>&1 || true
}

# The engine sends SIGTERM and follows with SIGKILL after a couple of seconds, so
# the remote teardown has to happen in the handler rather than on the way out.
# The cancelled event goes first: dying from a trapped signal means the engine
# sees a plain exit code rather than a signal, so without it a Stop would be
# reported as a runner that quit without a result.
on_signal() {
  local rc="$1" now
  now=$(($(date +%s) * 1000))
  printf '{"event":"cancelled","ops":%s,"elapsedMs":%s}\n' \
    "${last_ops:-0}" "$((now - ${t0_ms:-$now}))"
  cleanup
  exit "$rc"
}
trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM HUP

IN_LOCAL="$WORKDIR/in.txt"
{
  printf '%s\n' "$lo_e"
  printf '%s\n' "$hi_e"
  printf '%s\n' "$pub_e"
} >"$IN_LOCAL"

ssh "${SSH_OPTS[@]}" "$SSH_HOST" "mkdir -p '$REMOTE_DIR' '$REMOTE_WORK_DIR'"
scp "${SSH_OPTS[@]}" -q "$IN_LOCAL" "$SSH_HOST:$REMOTE_IN"

# Automatically handle periodic saves and resumption if workfile options are not explicitly set
RESUME_ARGS=""
if [[ ! "$EXTRA" =~ -w[[:space:]] && ! "$EXTRA" =~ -i[[:space:]] ]]; then
  if ssh "${SSH_OPTS[@]}" "$SSH_HOST" "[ -f '$REMOTE_WORK_FILE' ]" 2>/dev/null; then
    RESUME_ARGS="-i $REMOTE_WORK_FILE"
  fi
  EXTRA="$EXTRA -w $REMOTE_WORK_FILE -wi 30 -ws"
fi

# -t 0 = GPU-only. EXTRA unquoted so operators can pass multiple flags.
KANG_CMD="$REMOTE_BIN -t 0 -gpu -gpuId $GPU_ID -o $REMOTE_OUT $EXTRA $RESUME_ARGS $REMOTE_IN"

# JLP separates progress updates with a bare \r, so they have to become newlines
# before the read loop below sees them — and that conversion must happen on the
# remote, unbuffered. Running `tr` locally block-buffers ~4KB, which at ~110
# bytes per update is over a minute of total silence before the first line
# arrives, so the UI just sits at 0/s. stdbuf ships with GNU coreutils; fall
# back to plain tr where it is missing (buffered, but no worse than before).
#
# The remote exit code rides back in-band: the pipeline's own status would be
# tr's, and enabling pipefail would depend on the login shell being bash.
REMOTE_CMD="{ $KANG_CMD; echo \"__SS_RC__\$?\"; } 2>&1 | { command -v stdbuf >/dev/null 2>&1 && exec stdbuf -o0 tr '\\r' '\\n'; exec tr '\\r' '\\n'; }"

t0_ms=$(($(date +%s) * 1000))
last_ops=0
found_priv=""
ssh_rc=0
remote_rc=""
RC_FILE="$WORKDIR/ssh.rc"

emit_progress() {
  local ops="$1" rate="$2" elapsed="$3"
  printf '{"event":"progress","ops":%s,"dps":0,"opsPerSec":%s,"elapsedMs":%s}\n' \
    "$ops" "$rate" "$elapsed"
}

pad_priv() {
  local p="$1"
  p="$(printf '%s' "$p" | tr 'A-F' 'a-f')"
  printf '%064s' "$p" | tr ' ' '0'
}

# Process substitution keeps variables in this shell (not a pipe subshell).
set +e
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" =~ __SS_RC__([0-9]+) ]]; then
    remote_rc="${BASH_REMATCH[1]}"
    continue
  fi

  if [[ "$line" =~ \[([0-9.]+)[[:space:]]*M(Key|K)/s\] ]]; then
    rate_raw="${BASH_REMATCH[1]}"
    rate="$(awk -v r="$rate_raw" 'BEGIN{printf "%.0f", r*1e6}')"
    ops="$last_ops"
    if [[ "$line" =~ Count[[:space:]]+2\^([0-9.]+) ]]; then
      exp="${BASH_REMATCH[1]}"
      ops="$(awk -v e="$exp" 'BEGIN{printf "%.0f", 2^e}')"
      last_ops="$ops"
    fi
    now_ms=$(($(date +%s) * 1000))
    elapsed=$((now_ms - t0_ms))
    if [[ "$line" =~ \[([0-9]+)s\] ]]; then
      elapsed=$((BASH_REMATCH[1] * 1000))
    elif [[ "$line" =~ \[([0-9]+):([0-9]{2}) ]]; then
      elapsed=$(( (10#${BASH_REMATCH[1]} * 60 + 10#${BASH_REMATCH[2]}) * 1000 ))
    fi
    emit_progress "$ops" "$rate" "$elapsed"
  fi

  if [[ "$line" =~ Priv:[[:space:]]*0x([0-9a-fA-F]+) ]]; then
    found_priv="$(pad_priv "${BASH_REMATCH[1]}")"
    break
  fi
# -tt forces a pty for the streaming session, which is what actually stops the
# remote job. Closing the channel alone leaves the kangaroo running, and the
# cleanup trap cannot be relied on: the engine SIGKILLs this script two seconds
# after SIGTERM, while a trap cannot run until the blocked `read` below returns
# (up to one progress interval) and then needs an ssh round trip of its own. A
# controlling terminal makes the remote take SIGHUP the moment the connection
# drops, even if we are killed outright.
#
# The status write is best-effort: a signal tears down WORKDIR from the trap
# while this subshell is still winding down, and a failed write must not print.
done < <({ ssh -tt "${SSH_OPTS[@]}" "$SSH_HOST" "$REMOTE_CMD" 2>&1; { echo $? >"$RC_FILE"; } 2>/dev/null; })
# PIPESTATUS here would describe the while loop, not the ssh inside the process
# substitution, so every failure used to be reported as a clean "exhausted".
# Prefer the remote kangaroo's own code; fall back to ssh's for transport errors.
if [[ -n "$remote_rc" ]]; then
  ssh_rc="$remote_rc"
else
  ssh_rc="$(cat "$RC_FILE" 2>/dev/null || echo 0)"
  [[ "$ssh_rc" =~ ^[0-9]+$ ]] || ssh_rc=0
fi
set -e

now_ms=$(($(date +%s) * 1000))
elapsed=$((now_ms - t0_ms))

if [[ -n "$found_priv" ]]; then
  cleanup_delete_work=1
  printf '{"event":"found","priv":"%s","ops":%s,"dps":0,"elapsedMs":%s}\n' \
    "$found_priv" "$last_ops" "$elapsed"
  exit 0
fi

# Fallback: -o result file
OUT_LOCAL="$WORKDIR/result.txt"
if scp "${SSH_OPTS[@]}" -q "$SSH_HOST:$REMOTE_OUT" "$OUT_LOCAL" 2>/dev/null; then
  priv=""
  if grep -qoE 'Priv:[[:space:]]*0x[0-9a-fA-F]+' "$OUT_LOCAL" 2>/dev/null; then
    # Take the hex AFTER "Priv:", not the first 0x token — the "Pub:" value
    # precedes it in JLP's -o file and would otherwise be returned as the key.
    priv="$(grep -oiE 'Priv:[[:space:]]*0x[0-9a-fA-F]+' "$OUT_LOCAL" | head -1 | sed -E 's/.*0[xX]//')"
  elif grep -qoE '^[0-9a-fA-F]{16,64}$' "$OUT_LOCAL" 2>/dev/null; then
    priv="$(grep -oE '^[0-9a-fA-F]{16,64}$' "$OUT_LOCAL" | head -1)"
  fi
  if [[ -n "$priv" ]]; then
    cleanup_delete_work=1
    priv="$(pad_priv "$priv")"
    printf '{"event":"found","priv":"%s","ops":%s,"dps":0,"elapsedMs":%s}\n' \
      "$priv" "$last_ops" "$elapsed"
    exit 0
  fi
fi

if [[ "$ssh_rc" -eq 130 || "$ssh_rc" -eq 143 ]]; then
  printf '{"event":"cancelled","ops":%s,"elapsedMs":%s}\n' "$last_ops" "$elapsed"
  exit 130
fi

if [[ "$ssh_rc" -ne 0 ]]; then
  printf '{"event":"error","message":"remote kangaroo exit %s"}\n' "$ssh_rc"
  exit 1
fi

cleanup_delete_work=1
printf '{"event":"exhausted","ops":%s,"elapsedMs":%s}\n' "$last_ops" "$elapsed"
exit 1
