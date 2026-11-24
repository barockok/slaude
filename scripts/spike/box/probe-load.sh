#!/usr/bin/env bash
# Spike 1 density follow-up: the memory the sandbox itself (sentry + gofer + the guest page cache it holds)
# costs while the agent does heavy file work, as opposed to idle. Samples every 0.5 s during a clone, a warm
# bun install and an npm ci inside one sandbox. Run as root after 02-setup-bench.sh.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/spike/box/lib.sh
source "$HERE/lib.sh"
exec > >(tee "$RESULTS/01c-load-memory${LIMIT_MB:+-limit$LIMIT_MB}.txt") 2>&1
N=load; B=$SPIKE/load; rm -rf "$B"; mkdir -p "$B"/{home,ws,run,ov}
cp -a "$SPIKE/seed/home/." "$B/home/"; mkdir -p "$B/home/proj"; cp -a "$SPIKE/seed/proj/." "$B/home/proj/"; rm -rf "$B/home/proj/node_modules"
chown -R 1000:1000 "$B/home" "$B/ws"
runsc --root "$RS" delete -force $N >/dev/null 2>&1
ROOTFS=$SPIKE/bench-root EXTRA_MOUNTS="$SPIKE/mirror:/mirror" mkspec $N "$B/home" "$B/ws" "$B/run" $(( ${LIMIT_MB:-0} * 1048576 ))
runsc --root "$RS" --platform "$PLATFORM" --network none --host-uds open --overlay2 "root:dir=$B/ov,size=4g" run --detach --bundle "$SPIKE/specs/$N" $N </dev/null >/dev/null 2>&1
CG=/sys/fs/cgroup/$N
rss() { local t=0; for p in $(pgrep -f "runsc-(sandbox|gofer)" ); do v=$(awk '/VmRSS/{print $2}' /proc/"$p"/status 2>/dev/null); t=$((t+${v:-0})); done; echo $((t/1024)); }
sb() { echo "-- $1" | cut -c1-90; runsc --root "$RS" exec --user 1000:1000 --cwd /work $N /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/agent /bin/sh -c "$1" ; echo "   rc=$? sandbox: $(runsc --root "$RS" state $N 2>&1 | grep -E '"status"' | tr -d ' ')"; }
sleep 1
echo "idle: sentry+gofer RSS $(rss) MB, cgroup memory.current $(( $(cat $CG/memory.current) / 1048576 )) MB"
touch /tmp/.load-run
( peak=0; cpeak=0; while [ -e /tmp/.load-run ]; do r=$(rss); c=$(( $(cat $CG/memory.current) / 1048576 )); [ "$r" -gt "$peak" ] && peak=$r; [ "$c" -gt "$cpeak" ] && cpeak=$c; echo "$peak $cpeak" > /tmp/.load-peak; sleep 0.5; done ) &
sb 'git clone -q /mirror/synth.git /work/repo'
sb 'mkdir -p /work/proj && cp /home/agent/proj/package.json /home/agent/proj/bun.lock /work/proj/ && cd /work/proj && bun install --frozen-lockfile'
sb 'mkdir -p /work/proj2 && cp /home/agent/proj/package.json /home/agent/proj/package-lock.json /work/proj2/ && cd /work/proj2 && npm ci --offline --ignore-scripts --no-audit --no-fund'
rm -f /tmp/.load-run; sleep 1
read -r p c < /tmp/.load-peak
echo "RESULT load-memory | INFO | during clone + bun install + npm ci: sentry+gofer RSS peak ${p} MB; sandbox cgroup memory.current peak ${c} MB (includes the guest file cache and the workload's own memory); cgroup memory.peak $(( $(cat $CG/memory.peak 2>/dev/null || echo 0) / 1048576 )) MB; after the work (idle again) sentry+gofer RSS $(rss) MB, memory.current $(( $(cat $CG/memory.current) / 1048576 )) MB"
runsc --root "$RS" delete -force $N >/dev/null 2>&1
rm -rf "$B"
