#!/usr/bin/env bash
# Spike 2: bind-mount I/O benchmark. Run as root in the Linux VM after 02-setup-bench.sh:
#     sudo bash 02-bench.sh C0|C1|C2|C3|C4|C5 [runs=5]
# C0 runc (docker), C1 runsc systrap + dir overlay (the design), C2 = C1 with exclusive file access for
# bind mounts, C3 = erofs root, C4 = C1 on kvm (only if /dev/kvm), C5 = C1 with directfs off.
# Output: results/02-bench.<cfg>.tsv  (cfg workload run ms rc), one line per timed command.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$HERE/lib.sh"
CFG=${1:?config}; RUNS=${2:-5}; GO_RUNS=${GO_RUNS:-3}
B=$SPIKE/b/$CFG; NAME=bench-$(echo "$CFG" | tr 'A-Z' 'a-z')
TSV=$RESULTS/02-bench.$CFG.tsv; : > "$TSV"
mkdir -p "$RESULTS"
cg_delegate

stop_all() { docker rm -f "$NAME" >/dev/null 2>&1; runsc --root "$RS" delete -force "$NAME" >/dev/null 2>&1; }
trap stop_all EXIT
stop_all
rm -rf "$B"; mkdir -p "$B"/{home,ws,run,ov}
echo "[$CFG] seeding home (caches, wheels, go modules, project)"; cp -a "$SPIKE/seed/home/." "$B/home/"; mkdir -p "$B/home/proj"; cp -a "$SPIKE/seed/proj/." "$B/home/proj/" 2>/dev/null; rm -rf "$B/home/proj/node_modules"
chown -R 1000:1000 "$B"

RUNSC_COMMON=(--root "$RS" --platform "$PLATFORM" --network none --host-uds open)
case $CFG in
  C0) docker run -d --name "$NAME" --network none --user 1000:1000 -v "$B/home":/home/agent -v "$B/ws":/work -v "$B/run":/run/slaude -v "$SPIKE/mirror":/mirror:ro -e HOME=/home/agent slaude-bench box-probe init >/dev/null ;;
  C1|C2|C3|C4|C5)
    FLAGS=()
    [ "$CFG" = C2 ] && FLAGS+=(--file-access-mounts=exclusive)
    [ "$CFG" = C5 ] && FLAGS+=(--directfs=false)
    [ "$CFG" = C4 ] && { [ -e /dev/kvm ] || { echo "C4 not run: no /dev/kvm"; echo "C4 not-run no /dev/kvm" > "$TSV"; exit 0; }; RUNSC_COMMON=(--root "$RS" --platform kvm --network none --host-uds open); }
    ROOT=$SPIKE/bench-root
    if [ "$CFG" = C3 ]; then
      # EROFS root: the image as one file, memory-mapped by the sentry, overlay on top
      export EROFS_ANN=1
    fi
    ROOTFS=$ROOT BOX_INIT=1 EXTRA_MOUNTS="$SPIKE/mirror:/mirror" mkspec "$NAME" "$B/home" "$B/ws" "$B/run"
    if [ "$CFG" = C3 ]; then
      python3 - "$SPIKE/specs/$NAME/config.json" "$SPIKE/bench.erofs" "$B/ov" <<'PY'
import json,sys
p,img=sys.argv[1:3]
c=json.load(open(p))
c.setdefault("annotations",{}).update({"dev.gvisor.spec.rootfs.source":img,"dev.gvisor.spec.rootfs.type":"erofs","dev.gvisor.spec.rootfs.overlay":"dir="+sys.argv[3]})
json.dump(c,open(p,"w"),indent=1)
PY
    fi
    if ! runsc "${RUNSC_COMMON[@]}" "${FLAGS[@]}" --overlay2 "root:dir=$B/ov,size=4g" run --detach --bundle "$SPIKE/specs/$NAME" "$NAME" </dev/null; then
      echo "$CFG not-run sandbox failed to start" > "$TSV"; exit 0
    fi ;;
  *) echo "unknown config"; exit 2 ;;
esac

REAL=REALCRED-$RANDOM-$RANDOM; PH=sk-ant-api03-PLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDER-AAAAAA
bun "$HERE/lib/serve.ts" "$B/run/llm.sock" A "$REAL" "$PH" > "$B/serve.log" 2>&1 &
SERVE=$!
trap 'kill $SERVE 2>/dev/null; stop_all' EXIT
for i in $(seq 1 50); do [ -S "$B/run/llm.sock" ] && break; sleep 0.1; done

X() { # X "shell command" -> runs as the agent user in /work, returns the command's rc
  case $CFG in
    C0) docker exec -u 1000:1000 -w /work -e HOME=/home/agent "$NAME" /bin/sh -c "$1" ;;
    *)  runsc --root "$RS" exec --user 1000:1000 --cwd /work "$NAME" /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/agent GOMODCACHE=/home/agent/go/pkg/mod GOCACHE=/home/agent/gocache GOFLAGS=-mod=mod GOPATH=/home/agent/go /bin/sh -c "$1" ;;
  esac
}
T() { # T workload run "command": time it, append to the TSV
  local w=$1 r=$2; shift 2
  local t0 t1 rc
  t0=$(now_ms); X "$*" >"$B/last.out" 2>&1; rc=$?; t1=$(now_ms)
  printf '%s\t%s\t%s\t%s\t%s\n' "$CFG" "$w" "$r" "$((t1-t0))" "$rc" >> "$TSV"
  [ "$rc" -ne 0 ] && { echo "[$CFG] $w run $r rc=$rc: $(tail -2 "$B/last.out" | tr '\n' ' ' | cut -c1-200)"; }
  return 0
}

echo "[$CFG] sanity: $(X 'id -u; git --version; bun --version; node --version; go version' 2>&1 | tr '\n' ' ')"
sync; echo 3 > /proc/sys/vm/drop_caches   # run 1 of every workload starts after a cold host page cache
for r in $(seq 1 "$RUNS"); do
  X 'rm -rf /work/* /work/.[a-z]* 2>/dev/null; true'
  T clone $r 'git clone -q /mirror/synth.git /work/repo'
  X 'test "$(git -C /work/repo ls-files | wc -l)" -ge 20000' || echo "[$CFG] run $r: CLONE INVALID (fewer than 20000 files)"
  T git-status $r 'cd /work/repo && git status -s > /tmp/st.out && test "$(wc -l < /tmp/st.out)" -eq 0'
  T git-log100 $r 'cd /work/repo && git log -100 --stat > /tmp/log.out && test "$(wc -l < /tmp/log.out)" -gt 100'
  T git-checkout $r 'cd /work/repo && git checkout -q feature && git checkout -q main'
  T rg $r 'rg -c xyzzy42 /work/repo --glob "!.git" > /tmp/rg.out && test "$(wc -l < /tmp/rg.out)" -gt 1000'
  X 'mkdir -p /work/proj && cp /home/agent/proj/package.json /home/agent/proj/bun.lock /work/proj/ 2>/dev/null || cp /home/agent/proj/package.json /home/agent/proj/bun.lockb /work/proj/'
  T bun-install-warm $r 'cd /work/proj && bun install --frozen-lockfile >/dev/null 2>&1'
  X 'mkdir -p /work/proj2 && cp /home/agent/proj/package.json /home/agent/proj/package-lock.json /work/proj2/'
  T npm-ci-warm $r 'cd /work/proj2 && npm ci --offline --ignore-scripts --no-audit --no-fund >/dev/null 2>&1'
  T pip-venv-numpy $r 'python3 -m venv /work/venv && /work/venv/bin/pip install -q --no-index --find-links /home/agent/wheels numpy'
  X 'mkdir -p /work/tiny && cd /work/tiny && for i in 1 2 3 4 5; do printf "import {test,expect} from \"bun:test\"; test(\"t$i\",()=>{expect(1+$i).toBe(1+$i)});\n" > a$i.test.ts; done'
  T bun-test-tiny $r 'cd /work/tiny && bun test >/dev/null 2>&1'
  T many-files-create $r 'mkdir /work/many && cd /work/many && seq 1 20000 | xargs -P4 -n500 sh -c "for i in \"\$@\"; do echo \$i > f\$i; done" _'
  T many-files-find $r 'find /work/many | wc -l; du -s /work/many >/dev/null'
  T many-files-delete $r 'rm -rf /work/many'
  T toolchain-python-imports $r 'python3 -c "import asyncio,ssl,email,xml.dom.minidom,http.client,sqlite3,json,decimal,unittest,argparse,logging.handlers,multiprocessing,concurrent.futures,urllib.request,zipfile,tarfile,csv,ast,dis,typing"'
  T toolchain-node-builtins $r 'node -e "for (const m of require(\"module\").builtinModules) { try { require(m) } catch {} }"'
  T toolchain-claude-version $r 'claude --version'
  CLIENV='env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/agent CLAUDE_CONFIG_DIR=/home/agent/.claude ANTHROPIC_API_KEY='$PH' ANTHROPIC_BASE_URL=http://127.0.0.1:3129 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1'
  T cli-boot-plain-turn $r "$CLIENV claude -p --output-format json 'hello plain' >/dev/null"
  T agent-turn-10-tools $r "$CLIENV claude -p --dangerously-skip-permissions --output-format json 'TURN10 go' | grep -c 'turn10 done'"
  if [ "$r" -le "$GO_RUNS" ]; then
    X 'rm -rf /home/agent/gocache; git clone -q /mirror/xtools.git /work/xtools'
    T go-build-xtools $r 'cd /work/xtools && go build ./... 2>&1 | tail -3'
  fi
  echo "[$CFG] run $r done"
done

# coherence between host writes and a running sandbox (decides whether exclusive mode is usable at all)
X 'rm -rf /work/*; echo v1 > /work/stale.txt; cat /work/stale.txt >/dev/null'
echo v2 > "$B/ws/stale.txt"; echo new > "$B/ws/newfile.txt"
seen_new=$(X 'cat /work/newfile.txt 2>&1' | tr -d '\n'); seen_stale=$(X 'cat /work/stale.txt 2>&1' | tr -d '\n')
sleep 3
seen_new3=$(X 'cat /work/newfile.txt 2>&1' | tr -d '\n'); seen_stale3=$(X 'cat /work/stale.txt 2>&1' | tr -d '\n')
echo "[$CFG] host-write coherence: new-file immediately='$seen_new' after-3s='$seen_new3'; rewritten-file (v1 read earlier, host wrote v2) immediately='$seen_stale' after-3s='$seen_stale3'" | tee -a "$RESULTS/02-coherence.txt"
echo "$CFG coherence new='$seen_new' new3s='$seen_new3' rewritten='$seen_stale' rewritten3s='$seen_stale3'" >> "$TSV"
stop_all
rm -rf "$B"
echo "[$CFG] done"
