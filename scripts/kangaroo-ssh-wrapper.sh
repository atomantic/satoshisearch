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
# shellcheck disable=SC2206
SSH_OPTS=(${KANGAROO_SSH_OPTS:--o BatchMode=yes -o StrictHostKeyChecking=accept-new})
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
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

IN_LOCAL="$WORKDIR/in.txt"
{
  printf '%s\n' "$lo_e"
  printf '%s\n' "$hi_e"
  printf '%s\n' "$pub_e"
} >"$IN_LOCAL"

REMOTE_DIR="/tmp/ss-kangaroo-$$"
REMOTE_IN="$REMOTE_DIR/in.txt"
REMOTE_OUT="$REMOTE_DIR/result.txt"

ssh "${SSH_OPTS[@]}" "$SSH_HOST" "mkdir -p '$REMOTE_DIR'"
scp "${SSH_OPTS[@]}" -q "$IN_LOCAL" "$SSH_HOST:$REMOTE_IN"

# -t 0 = GPU-only. EXTRA unquoted so operators can pass multiple flags.
REMOTE_CMD="$REMOTE_BIN -t 0 -gpu -gpuId $GPU_ID -o $REMOTE_OUT $EXTRA $REMOTE_IN"

t0_ms=$(($(date +%s) * 1000))
last_ops=0
found_priv=""
ssh_rc=0

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
# tr converts JLP \r progress updates into lines.
set +e
while IFS= read -r line || [[ -n "$line" ]]; do
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
done < <(ssh "${SSH_OPTS[@]}" "$SSH_HOST" "$REMOTE_CMD" 2>&1 | tr '\r' '\n')
ssh_rc=${PIPESTATUS[0]:-0}
set -e

now_ms=$(($(date +%s) * 1000))
elapsed=$((now_ms - t0_ms))

if [[ -n "$found_priv" ]]; then
  printf '{"event":"found","priv":"%s","ops":%s,"dps":0,"elapsedMs":%s}\n' \
    "$found_priv" "$last_ops" "$elapsed"
  ssh "${SSH_OPTS[@]}" "$SSH_HOST" "rm -rf '$REMOTE_DIR'" 2>/dev/null || true
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
    priv="$(pad_priv "$priv")"
    printf '{"event":"found","priv":"%s","ops":%s,"dps":0,"elapsedMs":%s}\n' \
      "$priv" "$last_ops" "$elapsed"
    ssh "${SSH_OPTS[@]}" "$SSH_HOST" "rm -rf '$REMOTE_DIR'" 2>/dev/null || true
    exit 0
  fi
fi

ssh "${SSH_OPTS[@]}" "$SSH_HOST" "rm -rf '$REMOTE_DIR'" 2>/dev/null || true

if [[ "$ssh_rc" -eq 130 || "$ssh_rc" -eq 143 ]]; then
  printf '{"event":"cancelled","ops":%s,"elapsedMs":%s}\n' "$last_ops" "$elapsed"
  exit 130
fi

if [[ "$ssh_rc" -ne 0 ]]; then
  printf '{"event":"error","message":"remote kangaroo exit %s"}\n' "$ssh_rc"
  exit 1
fi

printf '{"event":"exhausted","ops":%s,"elapsedMs":%s}\n' "$last_ops" "$elapsed"
exit 1
