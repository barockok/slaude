#!/usr/bin/env bash
# Print the BOX_DEFAULT_IMAGES build argument of the slaude image for a default
# box image that was just pushed: a comma list of
#
#   <architecture>=<repository>@sha256:<manifest digest>
#
# one entry per architecture, each naming that platform's own manifest. A node
# fetches a box image by digest and checks the manifest it received against
# that digest; from a multi-platform index it receives one platform's manifest,
# so the index digest can never be the pinned one.
#
# usage: box-default-refs.sh <repository> <pushed digest> <architecture>...
#   repository      registry/path in lower case, no tag (ghcr.io/example/slaude-box-default)
#   pushed digest   what the build reported: an index for a multi-platform
#                   push, a single manifest for a one-platform push
#   architecture    amd64 and/or arm64: every one must be found
#
# Needs docker buildx (imagetools) and jq, and read access to the repository.
# It prints a location and nothing else: no credential is read or written here.
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: $0 <repository> <pushed digest> <architecture>..." >&2
  exit 2
fi
repo="$1"
pushed="$2"
shift 2

digest_re='^sha256:[a-f0-9]{64}$'
if ! printf '%s' "$repo" | grep -Eq '^[a-z0-9][a-z0-9._:/-]*$'; then
  echo "box-default-refs: the repository must be lower case with no tag or digest" >&2
  exit 1
fi
if ! printf '%s' "$pushed" | grep -Eq "$digest_re"; then
  echo "box-default-refs: the pushed digest is not sha256:<64 hex digits>" >&2
  exit 1
fi

raw="$(docker buildx imagetools inspect --raw "${repo}@${pushed}")"
is_index="$(printf '%s' "$raw" | jq -r 'has("manifests")')"

refs=""
for arch in "$@"; do
  case "$arch" in amd64 | arm64) ;; *) echo "box-default-refs: unsupported architecture '$arch'" >&2; exit 1 ;; esac
  if [ "$is_index" = "true" ]; then
    found="$(printf '%s' "$raw" | jq -r --arg a "$arch" '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == $a) | .digest] | join(" ")')"
  elif [ "$#" -eq 1 ]; then
    # A one-platform push is a manifest, not an index: the pushed digest is that platform's.
    found="$pushed"
  else
    echo "box-default-refs: the pushed image is a single manifest, but $# architectures were asked for" >&2
    exit 1
  fi
  if ! printf '%s' "$found" | grep -Eq "$digest_re"; then
    echo "box-default-refs: the pushed image has no single linux/$arch manifest" >&2
    exit 1
  fi
  refs="${refs:+$refs,}${arch}=${repo}@${found}"
done
printf '%s\n' "$refs"
