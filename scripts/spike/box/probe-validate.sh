#!/usr/bin/env bash
# Spike 2 sanity: prove the benchmark's one-line git commands measure real work inside the sandbox
# (status on 20,000 files, checkout changing files, rg hit counts), not a fast failure. Run as root.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/spike/box/lib.sh
source "$HERE/lib.sh"
exec > >(tee "$RESULTS/02d-validate.txt") 2>&1
N="val"; B=$SPIKE/val; rm -rf "$B"; mkdir -p "$B"/{home,ws,run,ov}; chown -R 1000:1000 "$B/home" "$B/ws"
runsc --root "$RS" delete -force $N >/dev/null 2>&1
ROOTFS=$SPIKE/bench-root EXTRA_MOUNTS="$SPIKE/mirror:/mirror" mkspec $N "$B/home" "$B/ws" "$B/run"
runsc --root "$RS" --platform "$PLATFORM" --network none --host-uds open --overlay2 "root:dir=$B/ov,size=2g" run --detach --bundle "$SPIKE/specs/$N" $N </dev/null >/dev/null 2>&1
sb() { runsc --root "$RS" exec --user 1000:1000 --cwd /work $N /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/agent /bin/sh -c "$1" 2>&1; }
# shellcheck disable=SC2016  # the single-quoted command is run by the shell inside the sandbox, which expands it
sb 'git clone -q /mirror/synth.git /work/repo; cd /work/repo; echo files=$(git ls-files | wc -l); git status | head -3; echo "status rc=$?"; git status -s | wc -l; echo untracked-test; echo x > newfile; echo modified >> pkg000/sub0/file0.ts; git status -s | head -3; git checkout -q -- . ; rm newfile; git checkout -q feature; echo branch=$(git branch --show-current) head=$(git rev-parse --short HEAD); git checkout -q main; echo branch=$(git branch --show-current); rg -c xyzzy42 /work/repo --glob "!.git" | wc -l; time git status -s | wc -l' | tail -22
runsc --root "$RS" delete -force $N >/dev/null 2>&1
rm -rf "$B"
