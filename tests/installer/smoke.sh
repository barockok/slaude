#!/usr/bin/env bash
# tests/installer/smoke.sh
# Drives install.sh against a fixture release served from a local dir, in an
# isolated HOME. Asserts the dist layout + the `slaude version` subcommand.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

WORK="$(mktemp -d)"; export HOME="$WORK/home"; mkdir -p "$HOME"
export SLAUDE_DIST="$HOME/.slaude-dist" SLAUDE_BIN_DIR="$HOME/.local/bin"
export SLAUDE_NO_BOOTSTRAP=1   # bun/git/uv already present in the CI image
VERSION="$(grep -m1 '"version"' "$ROOT/package.json" | sed -E 's/.*"([0-9.]+)".*/\1/')"
export SLAUDE_VERSION="$VERSION"

# Build the fixture release assets the installer expects.
REL="$WORK/rel"; mkdir -p "$REL"
bash "$ROOT/scripts/package-release.sh" "$REL"

# Stub curl: serve our local assets + a fake releases/latest.
# Args are parsed positionally to find the URL and -o <dest>.
BINS="$WORK/bin"; mkdir -p "$BINS"
CURL_STUB="$BINS/curl"
{
  printf '#!/usr/bin/env bash\n'
  printf 'url=""; out_path=""\n'
  printf 'i=1\n'
  # shellcheck disable=SC2016
  printf 'while [ "$i" -le "$#" ]; do\n'
  # shellcheck disable=SC2016
  printf '  eval "arg=\${$i}"\n'
  # shellcheck disable=SC2016
  printf '  if [ "$arg" = "-o" ]; then\n'
  # shellcheck disable=SC2016
  printf '    i=$((i + 1)); eval "out_path=\${$i}"\n'
  # shellcheck disable=SC2016
  printf '  else\n'
  # shellcheck disable=SC2016
  printf '    case "$arg" in http*) url="$arg" ;; esac\n'
  printf '  fi\n'
  # shellcheck disable=SC2016
  printf '  i=$((i + 1))\n'
  printf 'done\n'
  # shellcheck disable=SC2016
  printf 'case "$url" in\n'
  printf '  *releases/latest) echo '"'"'{"tag_name":"v%s"}'"'"'; exit 0 ;;\n' "$VERSION"
  # shellcheck disable=SC2016
  printf '  *slaude-%s.tar.gz) cp "%s/slaude-%s.tar.gz" "$out_path"; exit 0 ;;\n' \
    "$VERSION" "$REL" "$VERSION"
  # shellcheck disable=SC2016
  printf '  *sha256sums.txt) cp "%s/sha256sums.txt" "$out_path"; exit 0 ;;\n' "$REL"
  printf 'esac\n'
  printf 'exit 0\n'
} > "$CURL_STUB"
chmod +x "$CURL_STUB"
export PATH="$BINS:$PATH"

bash "$ROOT/install.sh"

test -L "$SLAUDE_DIST/current" || { echo "FAIL: no current symlink"; exit 1; }
test -x "$SLAUDE_BIN_DIR/slaude" || test -L "$SLAUDE_BIN_DIR/slaude" \
  || { echo "FAIL: no slaude bin link"; exit 1; }
out="$(env SLAUDE_DIST="$SLAUDE_DIST" bun "$SLAUDE_DIST/current/bin/slaude.ts" version)"
echo "$out" | grep -q "slaude $VERSION" || { echo "FAIL: version mismatch: $out"; exit 1; }

bash "$ROOT/install.sh"   # idempotency: second run must succeed
echo "SMOKE OK ($VERSION)"
rm -rf "$WORK"
