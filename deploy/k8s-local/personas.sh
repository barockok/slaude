#!/usr/bin/env bash
# The local persona set (personas/local-set.json) on the local cluster. up.sh runs
# `kb` and `sync`.
#
#   ./personas.sh sync [--relabel <persona>=<label>]... [--add <persona>=<slack user>]...
#                      [--soul <persona>=<text>]... [--revision <r>]
#                      [--token-var <NAME>] [--no-seed] [--any-status]
#       Sync the set through the gateway's own /deploy, from inside one gateway
#       pod: the soul-extraction cache is seeded there first (no model is
#       called), then the payload is posted to that pod. A sync replaces the
#       whole set, so a relabel lasts until the next plain `sync` (or up.sh run).
#       Prints one JSON line: {status, error?, warnings, souls}. Exits 0 on a 200,
#       or, with --any-status, whenever the sync could be attempted.
#   ./personas.sh kb
#       Create the set's knowledge bases under $SLAUDE_HOME/knowledge/ on the
#       shared volume when missing. Prints how many were created; gateways
#       register knowledge sources at boot, so restart them after a creation.
#
# Slack users in the set are placeholders. For a real-Slack run export
# SLAUDE_LOCAL_ALPHA_SLACK_USER, SLAUDE_LOCAL_BETA_SLACK_USER (the bot users of
# the apps you registered with `bun run slack-app add --persona alpha|beta`) and
# SLAUDE_LOCAL_MANAGER (your own Slack user id) before running this or up.sh.
#
# Every persona gets Vault provider references (vault.sh seeds the secrets), so
# run `vault.sh seed` first; up.sh does.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib.sh"
PROFILE="${SLAUDE_LOCAL_PROFILE:-slaude-local}"
NS="slaude-scale"
SET="$HERE/personas/local-set.json"
TIMEOUT="${PROBE_TIMEOUT:-120s}"

die() { printf 'personas.sh: %s\n' "$*" >&2; exit 1; }
k() { kubectl --context "$PROFILE" -n "$NS" "$@"; }
gateway() {
  k get pod -l app.kubernetes.io/component=gateway --field-selector=status.phase=Running \
    -o name --request-timeout="$TIMEOUT" 2>/dev/null | head -1
}

sync() {
  local payload_args=() probe_args=() any=0 pod payload out
  while (($#)); do
    case "$1" in
      --relabel | --add | --soul) payload_args+=("$1" "${2:?$1 needs a value}"); shift 2 ;;
      --revision | --token-var) probe_args+=("$1" "${2:?$1 needs a value}"); shift 2 ;;
      --no-seed) probe_args+=("$1"); shift ;;
      --any-status) any=1; shift ;;
      *) die "unknown option $1" ;;
    esac
  done
  payload="$(persona_payload "$SET" "${payload_args[@]+"${payload_args[@]}"}")" || die "could not build the payload"
  pod="$(gateway)"
  [[ -n "$pod" ]] || die "no running gateway pod"
  k exec -i --request-timeout="$TIMEOUT" "$pod" -- sh -c 'mkdir -p /tmp/probe && cat > /tmp/probe/personas.ts' \
    <"$HERE/probe/personas.ts" || die "could not copy the sync script into ${pod#pod/}"
  out="$(printf '%s' "$payload" | k exec -i --request-timeout="$TIMEOUT" "$pod" -- \
    bun /tmp/probe/personas.ts "${probe_args[@]+"${probe_args[@]}"}" 2>&1 | tail -1)" || true
  printf '%s\n' "$out"
  if ((any)); then
    python3 -c 'import json,sys; json.loads(sys.argv[1])' "$out" 2>/dev/null
  else
    [[ "$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("status"))' "$out" 2>/dev/null)" == 200 ]]
  fi
}

kb() {
  local pod created=0 label
  pod="$(gateway)"
  [[ -n "$pod" ]] || die "no running gateway pod"
  while IFS= read -r label; do
    [[ "$label" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "bad knowledge base label '$label'"
    # shellcheck disable=SC2016 # expands in the pod's shell
    if k exec --request-timeout="$TIMEOUT" "$pod" -- sh -c '[ -e "/data/knowledge/$1/README.md" ]' _ "$label" </dev/null; then
      continue
    fi
    # shellcheck disable=SC2016 # expands in the pod's shell
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["knowledgeBases"][sys.argv[2]], end="")' "$SET" "$label" \
      | k exec -i --request-timeout="$TIMEOUT" "$pod" -- sh -c 'mkdir -p "/data/knowledge/$1" && cat > "/data/knowledge/$1/README.md"' _ "$label" \
      || die "could not create knowledge base $label"
    created=$((created + 1))
  done < <(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1])).get("knowledgeBases", {})))' "$SET")
  echo "$created"
}

case "${1:-}" in
  sync) shift; sync "$@" ;;
  kb) kb ;;
  *) die "usage: personas.sh sync [options] | kb" ;;
esac
