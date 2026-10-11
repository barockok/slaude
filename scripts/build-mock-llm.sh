#!/usr/bin/env bash
# Bundle the mock LLM into one Node file and build its image.
#   scripts/build-mock-llm.sh            -> image slaude-mock-llm:dev
#   IMAGE=name:tag scripts/build-mock-llm.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-slaude-mock-llm:dev}"
OUT="$ROOT/dist/mock-llm"

mkdir -p "$OUT"
bun build "$ROOT/e2e/mock-llm/main.ts" --target=node --outfile "$OUT/main.mjs"
cp "$ROOT/e2e/mock-llm/Dockerfile" "$OUT/Dockerfile"
docker build -t "$IMAGE" "$OUT"
echo "built $IMAGE"
