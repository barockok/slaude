#!/usr/bin/env bash
# Bundle the mock LLM and the fake Slack and build both images inside minikube,
# where imagePullPolicy: Never finds them. fake-slack imports src/gateway/slack/verify.ts;
# the bundler inlines it, so the image needs no src/.
#   SLAUDE_LOCAL_PROFILE   minikube profile (default slaude-e2e)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${SLAUDE_LOCAL_PROFILE:-slaude-e2e}"

for name in mock-llm fake-slack; do
  out="$ROOT/dist/$name"
  mkdir -p "$out"
  bun build "$ROOT/e2e/$name/main.ts" --target=node --outfile "$out/main.mjs"
  cp "$ROOT/e2e/$name/Dockerfile" "$out/Dockerfile"
  minikube -p "$PROFILE" image build -t "slaude-$name:dev" "$out"
done
echo "built slaude-mock-llm:dev slaude-fake-slack:dev in profile $PROFILE"
