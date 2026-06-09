#!/usr/bin/env bash
# Seed ./verify-data from maria's persona + MCP config, then print the
# /1on1 OAuth-isolation verification procedure.
set -euo pipefail

MARIA="${MARIA_DIR:-../deploy-hermes/agents/maria}"
DATA="./verify-data"

[ -f "$MARIA/soul.md" ]   || { echo "missing $MARIA/soul.md"; exit 1; }
[ -f "$MARIA/.mcp.json" ] || { echo "missing $MARIA/.mcp.json"; exit 1; }

mkdir -p "$DATA/.claude"
# Loader expects uppercase SOUL.md; Linux is case-sensitive, maria ships soul.md.
cp "$MARIA/soul.md"   "$DATA/SOUL.md"
cp "$MARIA/.mcp.json" "$DATA/.mcp.json"
echo "seeded $DATA  (SOUL.md + .mcp.json from $MARIA)"
echo

CLI="bun node_modules/@anthropic-ai/claude-agent-sdk/cli.js"
COMPOSE="docker compose -f docker-compose.verify.yaml --env-file .env.verify"

cat <<EOF
NEXT STEPS
  0) cp .env.verify.example .env.verify   # fill CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) + GRAFANA_*
  1) $COMPOSE build

  2) Bootstrap workbench OAuth ONCE (plain CLI — its prompt URL is visible here,
     unlike the slaude TUI which suppresses logs). Authenticate as the AGENT:
       $COMPOSE run --rm -w /data verify $CLI --mcp-config /data/.mcp.json
         → inside: run  /mcp  → pick workbench → complete the browser auth
     Token persists to verify-data/.claude/  (file-based on Linux).

  3) Run the slaude sim REPL:
       $COMPOSE run --rm verify
     In the REPL:
       a) "is workbench connected?"        → expect: connected (reads /data/.claude token)
       b) /thread T1                        → PIN the thread (lock is thread-scoped)
       c) /1on1                             → lock; session reboots onto /data/oauth/<userId>
       d) "is workbench still connected?"   → expect: DISCONNECTED  ← isolation proven
       e) /1on1 off                         → reboots back to /data/.claude
       f) "is workbench connected?"         → expect: connected again

  4) Inspect from the host:
       ls verify-data/.claude/.credentials.json        # agent token (present)
       ls verify-data/oauth/<userId>/.credentials.json # initiator dir (absent → no token)

NOTE: the OAuth callback is loopback. Clean on a real Linux host/VM; on
Docker-Desktop-for-mac the callback lands in the Linux VM — run on Linux to verify.
EOF
