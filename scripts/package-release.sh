#!/usr/bin/env bash
# Build the curated slaude release tarball + checksums into <out-dir>.
# Tarball contains only the runtime subset; host runs `bun install` after extract.
set -euo pipefail

OUT_DIR="${1:?usage: package-release.sh <out-dir>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(grep -m1 '"version"' "$ROOT/package.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="slaude-${VERSION}"

mkdir -p "$OUT_DIR" "$STAGE/$PKG"
# Curated runtime subset — no tests/docs/.github/sim/coverage.
cp -R "$ROOT/src" "$ROOT/bin" "$STAGE/$PKG/"
cp "$ROOT/package.json" "$ROOT/bun.lock" "$ROOT/README.md" "$STAGE/$PKG/"

TARBALL="$OUT_DIR/${PKG}.tar.gz"
tar -C "$STAGE" -czf "$TARBALL" "$PKG"

SHA="$(command -v sha256sum || true)"
if [ -n "$SHA" ]; then SHA="sha256sum"; else SHA="shasum -a 256"; fi
( cd "$OUT_DIR" && $SHA "${PKG}.tar.gz" > sha256sums.txt )

echo "packaged $TARBALL"
