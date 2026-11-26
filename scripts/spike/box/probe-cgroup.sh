#!/usr/bin/env bash
# Spike 1 follow-up: where do the sandbox processes live in the cgroup tree, is the memory charged
# to the surrounding cgroup, and what do the spec limits become on the host. Run as root.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/spike/box/lib.sh
source "$HERE/lib.sh"
LABEL=${1:-vm}
mkdir -p "$RESULTS"
exec > >(tee "$RESULTS/01b-cgroup.$LABEL.txt") 2>&1
W=$SPIKE/w2; rm -rf "$W"; mkdir -p "$W/a/home" "$W/a/ws" "$W/a/run" "$W/a/ov"; chown 1000:1000 "$W/a/home" "$W/a/ws"
EXTRA=()
cleanup() { runsc --root "$RS" delete -force a >/dev/null 2>&1; }
trap cleanup EXIT; cleanup
cg_delegate
self=$CGSURR
echo "self cgroup: $self"
KEEPCAPS=1 mkspec a "$W/a/home" "$W/a/ws" "$W/a/run" 536870912 64 100000
runsc --root "$RS" --platform "$PLATFORM" --network none --host-uds open --overlay2 "root:dir=$W/a/ov,size=1g" run --detach --bundle "$SPIKE/specs/a" a </dev/null
sleep 1
echo "--- processes and their cgroups"
for p in $(pgrep -f runsc); do printf '%s %s cg=%s\n' "$p" "$(tr '\0' ' ' < /proc/"$p"/cmdline | cut -c1-70)" "$(cut -d: -f3 /proc/"$p"/cgroup)"; done
echo "--- spec cgroupsPath: $(python3 -c "import json;print(json.load(open('$SPIKE/specs/a/config.json'))['linux'].get('cgroupsPath'))")"
sbpid=$(pgrep -f runsc-sandbox | head -1)
cg=/sys/fs/cgroup$(cut -d: -f3 /proc/"$sbpid"/cgroup)
echo "sandbox cgroup dir: $cg"
for f in memory.max pids.max cpu.max memory.current pids.current; do printf '%s=%s\n' $f "$(cat "$cg"/$f 2>/dev/null)"; done
echo "--- memory charged: alloc 300MB held 6s in sandbox"
m_self0=$(cat "$self"/memory.current); m_sb0=$(cat "$cg"/memory.current 2>/dev/null)
runsc --root "$RS" exec --user 1000:1000 a box-probe alloc 300 6 >/dev/null 2>&1 &
ap=$!
sleep 4
m_self1=$(cat "$self"/memory.current); m_sb1=$(cat "$cg"/memory.current 2>/dev/null)
echo "RESULT charge | INFO | surrounding scope delta MB=$(( (m_self1-m_self0)/1048576 )); sandbox cgroup ($cg) delta MB=$(( (m_sb1-m_sb0)/1048576 )); sandbox cgroup memory.current=$((m_sb1/1048576)) MB"
echo "--- RSS per runsc process during alloc"
for p in $(pgrep -f runsc); do printf '%s %s rss_kb=%s\n' "$p" "$(tr '\0' ' ' < /proc/"$p"/cmdline | cut -c1-40)" "$(awk '/VmRSS/{print $2}' /proc/"$p"/status)"; done
wait $ap
echo "--- cpu limit measured on the host: 4 busy threads for 6s"
u0=$(awk '/usage_usec/{print $2}' "$cg"/cpu.stat)
runsc --root "$RS" exec --user 1000:1000 a box-probe busy 6 2>&1
u1=$(awk '/usage_usec/{print $2}' "$cg"/cpu.stat)
echo "RESULT cpu-host-measured | INFO | sandbox cgroup cpu usage over 6 s wall: $(( (u1-u0)/1000 )) ms => $(python3 -c "print(round(($u1-$u0)/6e6,2))") cores (limit 1.0); throttled: $(grep -E 'nr_throttled|throttled_usec' "$cg"/cpu.stat | tr '\n' ' ')"
echo "--- pids: host threads of the sandbox cgroup at idle: $(cat "$cg"/pids.current)"
echo "--- exec client kill: does the in-sandbox process die?"
runsc --root "$RS" exec --user 1000:1000 a sleep 1000 & cp=$!
sleep 1
runsc --root "$RS" ps a
t0=$(now_ms); kill -TERM $cp; wait $cp 2>/dev/null; t1=$(now_ms)
sleep 1
echo "ps 1 s after TERM to the exec client:"; runsc --root "$RS" ps a
echo "RESULT kill-exec-client | INFO | client TERM -> exit in $((t1-t0)) ms; 'sleep' rows in ps after 1 s: $(runsc --root "$RS" ps a | grep -c ' sleep')"
runsc --root "$RS" exec --user 1000:1000 a sleep 1000 & cp=$!
sleep 1
t0=$(now_ms); runsc --root "$RS" kill a KILL
for _ in $(seq 1 100); do runsc --root "$RS" state a 2>&1 | grep -q '"stopped"' && break; sleep 0.05; done
t1=$(now_ms); wait $cp 2>/dev/null; t2=$(now_ms)
echo "RESULT kill-sandbox | INFO | runsc kill KILL -> state stopped in $((t1-t0)) ms, exec client gone in $((t2-t0)) ms; state=$(runsc --root "$RS" state a 2>&1 | grep -E '"status"')"
