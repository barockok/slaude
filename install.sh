#!/usr/bin/env bash
# install.sh — curl|bash baremetal fat installer for slaude
# Usage: curl -fsSL https://raw.githubusercontent.com/barockok/slaude/main/install.sh | bash
# Env overrides:
#   SLAUDE_VERSION      — pin a specific release tag (without 'v' prefix)
#   SLAUDE_DIST         — dist directory (default: $HOME/.slaude-dist)
#   SLAUDE_BIN_DIR      — bin directory (default: $HOME/.local/bin)
#   SLAUDE_NO_BOOTSTRAP — set to 1 to skip prereq installs (bun, uv)
set -euo pipefail

REPO="barockok/slaude"
DIST="${SLAUDE_DIST:-$HOME/.slaude-dist}"
BIN_DIR="${SLAUDE_BIN_DIR:-$HOME/.local/bin}"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

detect_platform() {
  local os arch
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in Linux|Darwin) ;; *) die "unsupported OS: $os (Linux/macOS only)";; esac
  case "$arch" in x86_64|amd64|arm64|aarch64) ;; *) die "unsupported arch: $arch";; esac
}

bootstrap() {
  [ "${SLAUDE_NO_BOOTSTRAP:-}" = "1" ] && { say "skipping prereq bootstrap (SLAUDE_NO_BOOTSTRAP=1)"; return; }
  have git || die "git not found and no auto-install — install git, then re-run"
  if ! have bun; then say "installing bun"; curl -fsSL https://bun.sh/install | bash; export PATH="$HOME/.bun/bin:$PATH"; fi
  if ! have uv;  then say "installing uv";  curl -fsSL https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"; fi
  have bun || die "bun still not on PATH after install — open a new shell and re-run"
}

resolve_version() {
  if [ -n "${SLAUDE_VERSION:-}" ]; then printf '%s' "$SLAUDE_VERSION"; return; fi
  curl -fsSL --max-time 30 -H 'accept: application/vnd.github+json' \
    "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -m1 '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/'
}

# sha256 check — prefer sha256sum (Linux), fall back to shasum -a 256 (macOS)
sha_cmd() {
  if have sha256sum; then printf 'sha256sum'; else printf 'shasum -a 256'; fi
}

verify_checksum() {
  local dir="$1" tar="$2" cmd line
  cmd="$(sha_cmd)"
  line="$(grep " ${tar}\$" "$dir/sha256sums.txt")" || die "no checksum entry for $tar — aborting"
  [ -n "$line" ] || die "no checksum entry for $tar — aborting"
  # shellcheck disable=SC2086
  printf '%s\n' "$line" | ( cd "$dir" && $cmd -c - ) || die "checksum verification failed — aborting"
}

atomic_symlink() {
  local target="$1" link="$2"
  # Try GNU mv -T (Linux); fall back to plain ln -sfn (macOS/portable)
  if ln -sfn "$target" "${link}.tmp" 2>/dev/null && mv -T "${link}.tmp" "$link" 2>/dev/null; then
    return 0
  fi
  rm -f "${link}.tmp"
  ln -sfn "$target" "$link"
}

main() {
  detect_platform
  bootstrap
  local version; version="$(resolve_version)"
  [ -n "$version" ] || die "could not resolve a release version"
  say "installing slaude $version"

  local base="https://github.com/$REPO/releases/download/v$version"
  local tar="slaude-$version.tar.gz"
  local tmp; tmp="$(mktemp -d)"
  # expand $tmp now (at trap definition), not at EXIT time
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  curl -fsSL "$base/$tar" -o "$tmp/$tar"
  curl -fsSL "$base/sha256sums.txt" -o "$tmp/sha256sums.txt"
  verify_checksum "$tmp" "$tar"

  local dest="$DIST/$version"
  mkdir -p "$dest"
  tar -xzf "$tmp/$tar" -C "$dest" --strip-components=1
  ( cd "$dest" && bun install --frozen-lockfile )

  atomic_symlink "$version" "$DIST/current"  # target is intentionally relative to $DIST (matches src/cli/dist.ts swapCurrent)
  mkdir -p "$BIN_DIR"
  ln -sf "$DIST/current/bin/slaude.ts" "$BIN_DIR/slaude"
  chmod +x "$dest/bin/slaude.ts" || true

  say "installed. slaude -> $BIN_DIR/slaude"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "add to PATH:  export PATH=\"$BIN_DIR:\$PATH\"";; esac
  say "next: set ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL, create \$SLAUDE_HOME/SOUL.md, then \`slaude server\`"
}

main "$@"
