#!/usr/bin/env bash
# Bring up the scale topology with the mock LLM and the fake Slack on a local minikube.
# Needs no model or Slack credentials. Re-runnable.
#
# The cluster must exist before images can be built into it, so this starts it first
# (idempotent; same sizing as deploy/k8s-local/up.sh so its size check passes), builds the
# e2e images, then runs up.sh with our overlay. The default profile is slaude-e2e, kept
# apart from the slaude-local profile used for manual work; a profile that does not match
# /^slaude-e2e/ is refused before anything runs.
#
# This stack never carries real credentials: the mock LLM ignores them, and a real token in the
# cluster secret could change auth precedence and make the stack differ between machines.
# deploy/k8s-local/up.sh copies PROVIDER_KEYS from the caller's shell, or from the file named by
# SLAUDE_LOCAL_ENV_FILE, into the cluster secret. SCRUB lists every one of those names (plus the
# file variable) and the base script runs under `env -u` for each; render.test.ts fails if
# SCRUB drifts from PROVIDER_KEYS.
set -euo pipefail
# Guard first, before any minikube/kubectl/docker call: this script starts the profile, builds into
# it and applies the e2e overlay and mock credentials over it, so it must never reach another one.
PROFILE="${SLAUDE_LOCAL_PROFILE:-slaude-e2e}"
if [[ ! "$PROFILE" =~ ^slaude-e2e ]]; then
  printf "e2e-up: profile '%s' does not match /^slaude-e2e/; refusing to touch it\n" "$PROFILE" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SLAUDE_LOCAL_PROFILE="$PROFILE"

if ! minikube -p "$PROFILE" status --format '{{.Host}}' 2>/dev/null | grep -q Running; then
  minikube start -p "$PROFILE" --driver=docker --cpus="${SLAUDE_LOCAL_CPUS:-3}" --memory="${SLAUDE_LOCAL_MEMORY:-3500}" --addons=metrics-server
fi
"$ROOT/scripts/build-e2e-images.sh"

SCRUB=(ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN SLAUDE_LOCAL_ENV_FILE SLAUDE_LOCAL_MODEL)
unset_args=()
for name in "${SCRUB[@]}"; do unset_args+=(-u "$name"); done

env "${unset_args[@]}" \
  ANTHROPIC_BASE_URL="http://mock-llm:8080" \
  ANTHROPIC_API_KEY="sk-mock" \
  SLAUDE_LOCAL_OVERLAY="$ROOT/e2e/k8s" \
  "$ROOT/deploy/k8s-local/up.sh"

kubectl --context "$PROFILE" -n slaude-scale rollout status deploy/mock-llm deploy/fake-slack --timeout=300s
echo "e2e stack ready: mock-llm and fake-slack are up in namespace slaude-scale (profile $PROFILE)"
