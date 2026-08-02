#!/usr/bin/env bash
# Minimal external backend demo — emits JSONL the app understands.
# Not a real solver; use to verify KANGAROO_BACKEND=external wiring.
#
#   KANGAROO_BACKEND=external \
#   KANGAROO_EXTERNAL_CMD='scripts/kangaroo-external-echo.sh {pubkey} {lo} {hi}' \
#   npm run kangaroo -- --pubkey 02… --lo 1 --hi ff
set -euo pipefail
pubkey="${1:-${KANGAROO_PUBKEY:-}}"
lo="${2:-${KANGAROO_LO:-}}"
hi="${3:-${KANGAROO_HI:-}}"
echo "{\"event\":\"progress\",\"ops\":0,\"dps\":0,\"opsPerSec\":0,\"elapsedMs\":0}"
sleep 0.2
echo "{\"event\":\"progress\",\"ops\":1000,\"dps\":1,\"opsPerSec\":5000,\"elapsedMs\":200}"
sleep 0.2
# Fake "not found" so we don't write a bogus key into the vault.
echo "{\"event\":\"exhausted\",\"ops\":1000,\"elapsedMs\":400}"
echo "external-echo: pubkey=$pubkey lo=$lo hi=$hi" >&2
