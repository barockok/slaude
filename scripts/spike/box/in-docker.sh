#!/usr/bin/env bash
# Run one of the spike scripts inside a privileged container (stand-in for the boxd sidecar of a node pod).
# Usage (in the Linux VM, user in the docker group): bash in-docker.sh <script> <label> [memory, default 2g] [extra docker args]
# Needs: runsc and gvisor-bin in /usr/local/bin (00-setup.sh), the image `slaude-spike` (docker build -t slaude-spike -f Dockerfile.spike .).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script=$1; label=$2; mem=${3:-2g}; shift 3 2>/dev/null || shift $#
docker run --rm --privileged --cgroupns=private --memory="$mem" \
  -v /usr/local/bin:/usr/local/bin:ro -v /var/lib/slaude-spike:/var/lib/slaude-spike -v "$HERE":"$HERE" -w "$HERE" \
  "$@" slaude-spike bash "$script" "$label"
