#!/usr/bin/env bash
# Bundle the mock LLM and the fake Slack and build both images inside minikube,
# where imagePullPolicy: Never finds them. fake-slack imports src/gateway/slack/verify.ts;
# the bundler inlines it, so the image needs no src/.
#   SLAUDE_LOCAL_PROFILE   minikube profile; must match /^slaude-e2e/ (default slaude-e2e)
set -euo pipefail

# Guard first, before any minikube call: images are built into the profile, so only an e2e one.
PROFILE="${SLAUDE_LOCAL_PROFILE:-slaude-e2e}"
if [[ ! "$PROFILE" =~ ^slaude-e2e ]]; then
  printf "build-e2e-images: profile '%s' does not match /^slaude-e2e/; refusing to touch it\n" "$PROFILE" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for name in mock-llm fake-slack; do
  out="$ROOT/dist/$name"
  mkdir -p "$out"
  bun build "$ROOT/e2e/$name/main.ts" --target=node --outfile "$out/main.mjs"
  cp "$ROOT/e2e/$name/Dockerfile" "$out/Dockerfile"
  minikube -p "$PROFILE" image build -t "slaude-$name:dev" "$out"
done
echo "built slaude-mock-llm:dev slaude-fake-slack:dev in profile $PROFILE"
