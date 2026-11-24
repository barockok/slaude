#!/usr/bin/env bash
# Spike 1: runsc nested in a node pod (here: any Linux host, run as root).
# Usage: sudo bash 01-run.sh [label]     (label names the results file, default "vm")
# Output: results/01-run.<label>.txt (raw), a PASS/FAIL/INFO line per check.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$HERE/lib.sh"
LABEL=${1:-vm}
mkdir -p "$RESULTS" "$SPIKE"
LOG=$RESULTS/01-run.$LABEL.txt
exec > >(tee "$LOG") 2>&1

EXTRA=(--host-uds open)
say() { echo "[$(date +%T)] $*"; }
res() { echo "RESULT $1 | $2 | $3"; }   # name | PASS/FAIL/INFO | detail

say "host: $(uname -srm) cpus=$(nproc) mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)"
say "runsc: $(runsc --version | head -1) sha256=$(sha256sum "$(command -v runsc)" | cut -d' ' -f1) platform=$PLATFORM kvm=$([ -e /dev/kvm ] && echo yes || echo no)"
say "cgroup: $(stat -fc %T /sys/fs/cgroup) self=$(cut -d: -f3 /proc/self/cgroup)"

cg_delegate
prep_image
# static probe helper into the (read-only at run time) image directory
if [ ! -x "$BUNDLE/rootfs/usr/local/bin/box-probe" ]; then
  (cd /tmp && CGO_ENABLED=0 go build -o /tmp/box-probe "$HERE/probe/main.go") && install -m 0755 /tmp/box-probe "$BUNDLE/rootfs/usr/local/bin/box-probe"
fi

W=$SPIKE/w; rm -rf "$W"; mkdir -p "$W"
cleanup() { for n in $(runsc --root "$RS" list -quiet 2>/dev/null); do runsc --root "$RS" kill "$n" KILL >/dev/null 2>&1; runsc --root "$RS" delete -force "$n" >/dev/null 2>&1; done; }
trap cleanup EXIT
cleanup

# start NAME [overlay-size] [mem pids quota]; waits for the sandbox to answer an exec.
start() {
  local name=$1 size=${2:-2g} mem=${3:-0} pids=${4:-0} quota=${5:-0}
  mkdir -p "$W/$name/home" "$W/$name/ws" "$W/$name/run" "$W/$name/ov"
  chown 1000:1000 "$W/$name/home" "$W/$name/ws"
  mkspec "$name" "$W/$name/home" "$W/$name/ws" "$W/$name/run" "$mem" "$pids" "$quota"
  runsc --root "$RS" --platform "$PLATFORM" --network none --host-uds open \
    --overlay2 "root:dir=$W/$name/ov,size=$size" run --detach --bundle "$SPIKE/specs/$name" "$name" </dev/null
}
ex() { local n=$1; shift; runsc --root "$RS" exec --user 1000:1000 "$n" "$@"; }
exr() { local n=$1; shift; runsc --root "$RS" exec --user 0:0 "$n" "$@"; }
stop() { runsc --root "$RS" kill "$1" KILL >/dev/null 2>&1; runsc --root "$RS" delete -force "$1" >/dev/null 2>&1; }

# ---- 1. basic run and exec -------------------------------------------------
say "== 1 run/exec"
KEEPCAPS=1 start s1 2g && res run-detach PASS ok || res run-detach FAIL "start failed"
ex s1 /bin/sh -c 'id; df -h / | tail -1; cat /proc/version; (ip addr 2>&1 || cat /proc/net/dev) | head -5; ls -ld /home/agent /work /run/slaude' || true
ex s1 /bin/sh -c 'mount | head -12' || true
ex s1 /bin/sh -c 'echo ws-from-sandbox > /work/from-sandbox.txt; echo home-from-sandbox > /home/agent/h.txt' && \
  { [ "$(cat $W/s1/ws/from-sandbox.txt)" = ws-from-sandbox ] && res bind-mount-rw PASS "host sees sandbox writes" || res bind-mount-rw FAIL "host does not see"; }
echo host-wrote > "$W/s1/ws/from-host.txt"
[ "$(ex s1 cat /work/from-host.txt 2>/dev/null)" = host-wrote ] && res host-write-visible-shared-mode PASS "sandbox sees host write (shared mode)" || res host-write-visible-shared-mode FAIL "sandbox did not see host write"

# ---- 2. root overlay: dir= and size limit ----------------------------------
say "== 2 overlay"
df0=$(df --output=used -B1M "$W" | tail -1)
exr s1 box-probe write /usr/local/big1 1024
df1=$(df --output=used -B1M "$W" | tail -1)
ls -la "$W/s1/ov" || true
du -sm "$W/s1/ov" || true
exr s1 ls -la /usr/local/big1
res overlay-1GB-write INFO "host disk used delta MB=$((df1-df0)); backing dir listing above; rootfs untouched: $(du -sm $BUNDLE/rootfs/usr/local | cut -f1)MB"
[ -e "$BUNDLE/rootfs/usr/local/big1" ] && res overlay-root-untouched FAIL "write leaked into image dir" || res overlay-root-untouched PASS "image dir has no big1"
# size limit: 256 MB overlay, write 400 MB
KEEPCAPS=1 start s2 256m
out=$(exr s2 box-probe write /usr/local/big2 400 2>&1); echo "$out"
echo "$out" | grep -qiE 'no space|ENOSPC|WRITE-ERR' && res overlay-size-limit PASS "$out" || res overlay-size-limit FAIL "$out"
# isolation: two sandboxes, same read-only root, different dir=
KEEPCAPS=1 start s3 1g
exr s1 /bin/sh -c 'echo only-in-s1 > /usr/local/iso.txt; echo only-in-s1 > /etc/iso.txt'
if exr s3 test -e /usr/local/iso.txt || exr s3 test -e /etc/iso.txt; then res overlay-isolation FAIL "s3 sees s1 writes"; else res overlay-isolation PASS "s3 does not see s1 writes"; fi
[ -e "$BUNDLE/rootfs/etc/iso.txt" ] && res overlay-isolation-root FAIL "leaked into root" || res overlay-isolation-root PASS "root clean"
stop s2; stop s3
# after stop the overlay file must be disposable
stop s1
res overlay-after-stop INFO "backing dir after stop: $(du -sm $W/s1/ov | cut -f1)MB $(ls $W/s1/ov | wc -l) entries"
rm -rf "$W/s1/ov" "$W/s2/ov" "$W/s3/ov"

# ---- 3. exec stdio ---------------------------------------------------------
say "== 3 stdio"
start s4 2g
[ "$(printf 'hello\n' | ex s4 cat)" = hello ] && res stdio-roundtrip PASS "hello" || res stdio-roundtrip FAIL "no echo"
head -c 104857600 /dev/urandom > "$W/in100m"
h_in=$(sha256sum < "$W/in100m" | cut -d' ' -f1)
t0=$(now_ms); h_out=$(ex s4 cat < "$W/in100m" | sha256sum | cut -d' ' -f1); t1=$(now_ms)
[ "$h_in" = "$h_out" ] && res stdio-100MB PASS "sha256 equal, $((t1-t0)) ms" || res stdio-100MB FAIL "sha mismatch in=$h_in out=$h_out"
t0=$(now_ms); ex s4 cat < /dev/null; t1=$(now_ms)
res stdin-close INFO "cat with closed stdin returned in $((t1-t0)) ms"
# killing a hung exec and stopping a sandbox: see probe-cgroup.sh (run it too)
stop s4

# ---- 4. host Unix socket and loopback --------------------------------------
say "== 4 uds and loopback"
for mode in none open; do
  stop u-$mode >/dev/null 2>&1
  rm -rf "$W/u-$mode"; mkdir -p "$W/u-$mode/run" "$W/u-$mode/home" "$W/u-$mode/ws" "$W/u-$mode/ov"
  python3 - "$W/u-$mode/run/egress.sock" <<'PY' &
import socket,os,sys
p=sys.argv[1]
s=socket.socket(socket.AF_UNIX); s.bind(p); s.listen(5); os.chmod(p,0o777)
s.settimeout(25)
try:
    while True:
        c,_=s.accept(); d=c.recv(100); c.sendall(b"pong:"+d); c.close()
except Exception: pass
PY
  srv=$!
  sleep 0.5
  mkspec "u-$mode" "$W/u-$mode/home" "$W/u-$mode/ws" "$W/u-$mode/run"
  runsc --root "$RS" --platform "$PLATFORM" --network none --host-uds $mode \
    --overlay2 "root:dir=$W/u-$mode/ov,size=1g" run --detach --bundle "$SPIKE/specs/u-$mode" "u-$mode" </dev/null
  o=$(ex "u-$mode" box-probe uds-client /run/slaude/egress.sock 2>&1)
  echo "host-uds=$mode -> $o"
  echo "$o" | grep -q REPLY && res "host-uds-$mode" PASS "$o" || res "host-uds-$mode" FAIL "$o"
  kill $srv 2>/dev/null; stop "u-$mode"
done
start s5 1g
o=$(ex s5 box-probe loopback 3128 2>&1); echo "$o"
echo "$o" | grep -q LOOPBACK-ECHO && res loopback-network-none PASS "$(echo "$o" | tr '\n' ' ')" || res loopback-network-none FAIL "$o"
stop s5

# ---- 5. limits -------------------------------------------------------------
say "== 5 limits"
cg_of_self=$CGSURR
memcur() { cat "$cg_of_self/memory.current" 2>/dev/null || cat /sys/fs/cgroup/memory.current 2>/dev/null || echo na; }
# 5a memory 512 MB
start l1 1g 536870912 64 100000 && res limits-start PASS "spec with memory 512MB pids 64 cpu 1 core accepted" || res limits-start FAIL "start with limits failed"
runsc --root "$RS" state l1 2>&1 | grep -E 'pid|status' | head -3
ex l1 cat /proc/self/cgroup /sys/fs/cgroup/memory.max 2>&1 | head -5
ex l1 /bin/sh -c 'cat /sys/fs/cgroup/pids.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max 2>&1' | head -5
echo "-- alloc 900MB under 512MB limit"
o=$(timeout 60 runsc --root "$RS" exec l1 box-probe alloc 900 2>&1); rc=$?; echo "$o" | tail -4; echo "rc=$rc"
echo "$o" | grep -q ALLOC-DONE && res limit-memory FAIL "alloc 900MB completed under a 512MB limit rc=$rc" || res limit-memory PASS "alloc killed/refused rc=$rc last='$(echo "$o" | tail -1)'"
echo "sandbox state after: $(runsc --root "$RS" state l1 2>&1 | grep -E '"status"')"
stop l1
# 5b pids
start l2 1g 536870912 64 100000
o=$(ex l2 box-probe fork 200 2>&1); echo "$o"
echo "$o" | grep -q FORK-FAIL && res limit-pids PASS "$(echo "$o" | tr '\n' ' ')" || res limit-pids FAIL "$(echo "$o" | tr '\n' ' ')"
stop l2
# 5c cpu
start l3 1g 536870912 64 100000
o=$(ex l3 box-probe busy 6 2>&1); echo "$o"
res limit-cpu INFO "$o (cores near 1.0 means held to one core; 4.0 means not held)"
stop l3
start l4 1g 0 0 0
o=$(ex l4 box-probe busy 6 2>&1); echo "$o"
res limit-cpu-unlimited-control INFO "$o"
stop l4

# ---- 6. memory charged to the surrounding cgroup ---------------------------
say "== 6 cgroup charge"
start c1 1g
m0=$(memcur)
ex c1 box-probe alloc 400 8 >/dev/null 2>&1 & apid=$!
sleep 5
m1=$(memcur)
wait $apid
res memory-charged-to-surrounding-cgroup INFO "memory.current of $cg_of_self before=$m0 during=$m1 (alloc 400MB held in sandbox); delta MB=$(( (m1-m0)/1048576 ))"
stop c1

# ---- 7. start time ---------------------------------------------------------
say "== 7 start time (20 runs: run --detach + first exec returning)"
: > "$W/times"
for i in $(seq 1 20); do
  n=t$i; mkdir -p "$W/$n/home" "$W/$n/ws" "$W/$n/run" "$W/$n/ov"
  mkspec "$n" "$W/$n/home" "$W/$n/ws" "$W/$n/run"
  t0=$(now_ms)
  runsc --root "$RS" --platform "$PLATFORM" --network none --host-uds open --overlay2 "root:dir=$W/$n/ov,size=2g" run --detach --bundle "$SPIKE/specs/$n" "$n" </dev/null >/dev/null 2>&1
  t1=$(now_ms)
  runsc --root "$RS" exec "$n" /bin/true >/dev/null 2>&1
  t2=$(now_ms)
  echo "$((t1-t0)) $((t2-t0))" >> "$W/times"
  stop "$n"; rm -rf "$W/$n"
done
python3 - "$W/times" <<'PY'
import sys,statistics as s
rows=[tuple(map(int,l.split())) for l in open(sys.argv[1])]
for i,name in enumerate(("run --detach","run + first exec")):
    v=sorted(r[i] for r in rows); n=len(v)
    print(f"RESULT start-time | INFO | {name}: n={n} median={s.median(v)} ms p95={v[min(n-1,int(0.95*n))]} ms min={v[0]} max={v[-1]} all={sorted(r[i] for r in rows)}")
PY

# ---- 8. density ------------------------------------------------------------
say "== 8 density"
pss_runsc() { # sum PSS (kB) of every process whose cmdline mentions runsc
  local tot=0 n=0
  for p in $(pgrep -f 'runsc|exe' 2>/dev/null); do
    c=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null) || continue
    case "$c" in *runsc*boot*|*runsc*gofer*|*"--root $RS"*|*runsc-sandbox*) ;; *) continue;; esac
    v=$(awk '/^Pss:/{print $2}' /proc/$p/smaps_rollup 2>/dev/null) || continue
    [ -n "$v" ] && { tot=$((tot+v)); n=$((n+1)); }
  done
  echo "$tot $n"
}
echo "baseline: $(pss_runsc)"
start d1 2g; sleep 3
read -r kb n <<< "$(pss_runsc)"
echo "procs:"; pgrep -af 'runsc' | cut -c1-160
res density-idle-1 INFO "idle sandbox: PSS sum $((kb/1024)) MB over $n runsc processes"
stop d1
for i in $(seq 1 10); do start "d$i" 1g >/dev/null 2>&1; done
sleep 4
read -r kb n <<< "$(pss_runsc)"
res density-idle-10 INFO "10 idle sandboxes: PSS sum $((kb/1024)) MB over $n processes, $((kb/1024/10)) MB each; free: $(free -m | awk '/Mem:/{print "used="$3"MB"}')"
for i in $(seq 1 10); do stop "d$i"; done

say "done; log: results/$(basename "$LOG")"
