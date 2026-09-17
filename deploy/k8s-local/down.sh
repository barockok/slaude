#!/usr/bin/env bash
# Delete the local minikube cluster.
#
#   ./down.sh           delete the cluster, keep generated secrets
#   ./down.sh --purge   also delete secrets.env and provider.env
#
# Keeping secrets.env by default means a later up.sh reuses the same master key.
set -euo pipefail

PROFILE="${SLAUDE_LOCAL_PROFILE:-slaude-local}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

minikube delete -p "$PROFILE"

if [[ "${1:-}" == "--purge" ]]; then
  rm -f "$HERE/secrets.env" "$HERE/provider.env"
  echo "removed generated secrets"
fi
