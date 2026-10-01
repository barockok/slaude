#!/usr/bin/env bash
# Bring up the scale topology with the mock LLM and the fake Slack on a local minikube.
# Needs no model or Slack credentials. Re-runnable.
#
# The cluster must exist before images can be built into it, so this starts it first
# (idempotent; same sizing as deploy/k8s-local/up.sh so its size check passes), builds the
# e2e images, then runs up.sh with our overlay. The default profile is slaude-e2e, kept
# apart from the slaude-local profile used for manual work.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SLAUDE_LOCAL_PROFILE="${SLAUDE_LOCAL_PROFILE:-slaude-e2e}"
PROFILE="$SLAUDE_LOCAL_PROFILE"

if ! minikube -p "$PROFILE" status --format '{{.Host}}' 2>/dev/null | grep -q Running; then
  minikube start -p "$PROFILE" --driver=docker --cpus="${SLAUDE_LOCAL_CPUS:-3}" --memory="${SLAUDE_LOCAL_MEMORY:-3500}" --addons=metrics-server
fi
"$ROOT/scripts/build-e2e-images.sh"

ANTHROPIC_BASE_URL="http://mock-llm:8080" \
ANTHROPIC_API_KEY="sk-mock" \
SLAUDE_LOCAL_OVERLAY="$ROOT/e2e/k8s" \
  "$ROOT/deploy/k8s-local/up.sh"

kubectl --context "$PROFILE" -n slaude-scale rollout status deploy/mock-llm deploy/fake-slack --timeout=300s
echo "e2e stack ready: mock-llm and fake-slack are up in namespace slaude-scale (profile $PROFILE)"
