#!/usr/bin/env bash
# Assert the /mcp connect flow wrote an mcpOAuth entry into the INITIATOR's
# CLI credential store (verify-data/oauth/<userId>/.credentials.json).
#
# Run AFTER driving `/mcp connect <server>` in the verify REPL (see
# scripts/verify-1on1.sh, step 5). Linux/container only — on macOS the CLI store
# is keychain-backed, so the file write is shadowed and never round-trips.
set -euo pipefail

USERID="${1:-}"
DATA="${VERIFY_DATA:-./verify-data}"

if [[ -z "$USERID" ]]; then
  echo "usage: $0 <slack-user-id>   (the /1on1 lock initiator)"; exit 2
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "[verify] SKIP mcp-oauth on macOS — CLI store is keychain-backed; .credentials.json write is shadowed (Linux/container only)."
  exit 0
fi

CRED="$DATA/oauth/$USERID/.credentials.json"
if grep -q '"mcpOAuth"' "$CRED" 2>/dev/null; then
  echo "[verify] OK mcp-oauth: mcpOAuth entry present in $CRED"
else
  echo "[verify] FAIL mcp-oauth: no mcpOAuth entry in $CRED"
  echo "         (did you run /mcp connect in the locked thread first?)"
  exit 1
fi
