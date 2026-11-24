#!/usr/bin/env bash
# A small, self-contained Spike 2 subset for hosts that cannot build the full benchmark image (host 2 and host 3,
# a privileged pod). It needs only runsc, skopeo, umoci, python3 and git on the host. Compares, on the SAME volume:
#   plain   the workload run directly in the pod (the baseline; there is no runc inside a pod)
#   C1      runsc systrap, image directory + `root:dir=` overlay, bind mounts in shared mode (the design)
#   C2      C1 with --file-access-mounts=exclusive
#   C5      C1 with --directfs=false
# Usage (root): bash 02-mini.sh <label> [runs=3] ; output results/02-mini.<label>.tsv (cfg workload run ms rc)
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$HERE/lib.sh"
LABEL=${1:-pod}; RUNS=${2:-3}
mkdir -p "$RESULTS" "$SPIKE"
TSV=$RESULTS/02-mini.$LABEL.tsv; : > "$TSV"
cg_delegate
# rootfs with git: node:22-bookworm carries git, python3, node, npm
IMG=${BENCH_IMAGE:-docker.io/library/node:22-bookworm}
ROOTFS=$SPIKE/mini-root
if [ ! -d "$SPIKE/mini-bundle/rootfs/usr" ]; then
  [ -d "$SPIKE/mini-oci" ] || skopeo copy docker://$IMG oci:"$SPIKE/mini-oci":latest
  umoci unpack --image "$SPIKE/mini-oci":latest "$SPIKE/mini-bundle"
fi
ROOTFS=$SPIKE/mini-bundle/rootfs
BUNDLE=$SPIKE/mini-bundle   # mkspec reads $BUNDLE/config.json
# synthetic 20,000-file mirror, same generator as 02-setup-bench.sh
M=$SPIKE/mirror-mini/synth.git
if [ ! -d "$M" ]; then
  mkdir -p "$SPIKE/mirror-mini"
  python3 - "$M" <<'PY'
import subprocess,sys,random
dst=sys.argv[1]
subprocess.run(["git","init","-q","--bare",dst],check=True)
random.seed(7)
def blob(i,v): return (f"// file {i} version {v}\n"+("\n".join(f"line {j} of file {i} xyzzy{(i*j)%97}" for j in range(40)))+"\n").encode()
out=[];mark=[0]
def emit_commit(ref,msg,files,parent=None):
    mark[0]+=1;m=mark[0]
    out.append(f"commit {ref}\nmark :{m}\ncommitter Spike <spike@example.invalid> {1700000000+m*60} +0000\ndata {len(msg)}\n{msg}\n")
    if parent: out.append(f"from :{parent}\n")
    for path,data in files:
        out.append(f"M 100644 inline {path}\ndata {len(data)}\n"); out.append(data.decode()+"\n")
    return m
N=20000
last=emit_commit("refs/heads/main","initial",[(f"pkg{i%400:03d}/sub{(i//400)%5}/file{i}.ts",blob(i,0)) for i in range(N)])
for c in range(1,120):
    last=emit_commit("refs/heads/main",f"change {c}",[(f"pkg{random.randrange(400):03d}/sub{random.randrange(5)}/file{k}.ts",blob(k,c)) for k in random.sample(range(N),25)],last)
    if c==60: base=last
fb=base
for c in range(5):
    fb=emit_commit("refs/heads/feature",f"feature {c}",[(f"pkg{random.randrange(400):03d}/sub{random.randrange(5)}/file{k}.ts",blob(k,1000+c)) for k in random.sample(range(N),200)],fb)
subprocess.run(["git","--git-dir",dst,"fast-import","--quiet"],input="".join(out).encode(),check=True)
subprocess.run(["git","--git-dir",dst,"symbolic-ref","HEAD","refs/heads/main"],check=True)
PY
fi
chown -R 1000:1000 "$SPIKE/mirror-mini"   # git refuses a repository owned by another uid (dubious ownership)

run_cfg() { # run_cfg CFG exec-prefix...   (the prefix executes `sh -c <script>` somewhere)
  local cfg=$1; shift
  for r in $(seq 1 "$RUNS"); do
    for step in clone git-status git-log100 git-checkout many-files-create many-files-find many-files-delete; do
      local cmd
      case $step in
        clone) cmd='rm -rf "$WS"/* "$WS"/.[a-z]* 2>/dev/null; git clone -q "$MIRROR/synth.git" "$WS/repo" && test "$(git -C "$WS/repo" ls-files | wc -l)" -ge 20000';;
        git-status) cmd='cd "$WS/repo" && git status -s > "$WS/.st" && test "$(wc -l < "$WS/.st")" -eq 0';;
        git-log100) cmd='cd "$WS/repo" && git log -100 --stat > "$WS/.log" && test "$(wc -l < "$WS/.log")" -gt 100';;
        git-checkout) cmd='cd "$WS/repo" && git checkout -q feature && git checkout -q main';;
        many-files-create) cmd='mkdir "$WS/many" && cd "$WS/many" && seq 1 20000 | xargs -P4 -n500 sh -c "for i in \"\$@\"; do echo \$i > f\$i; done" _';;
        many-files-find) cmd='find "$WS/many" | wc -l';;
        many-files-delete) cmd='rm -rf "$WS/many"';;
      esac
      local t0 t1 rc
      t0=$(now_ms); "$@" "$cmd" >/dev/null 2>&1; rc=$?; t1=$(now_ms)
      printf '%s\t%s\t%s\t%s\t%s\n' "$cfg" "$step" "$r" "$((t1-t0))" "$rc" >> "$TSV"
    done
  done
}

# plain baseline: directly in the pod, same volume
B=$SPIKE/mini/plain; rm -rf "$B"; mkdir -p "$B/ws"; chown -R 1000:1000 "$B"
plain() { setpriv --reuid 1000 --regid 1000 --clear-groups env WS=$B/ws MIRROR=$SPIKE/mirror-mini HOME=$B /bin/sh -c "$1"; }
sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
run_cfg plain plain

for cfg in C1 C2 C5; do
  B=$SPIKE/mini/$cfg; rm -rf "$B"; mkdir -p "$B"/{home,ws,run,ov}; chown -R 1000:1000 "$B/home" "$B/ws"
  N=mini-$(echo $cfg | tr A-Z a-z)
  FLAGS=(); [ $cfg = C2 ] && FLAGS+=(--file-access-mounts=exclusive); [ $cfg = C5 ] && FLAGS+=(--directfs=false)
  ROOTFS=$ROOTFS EXTRA_MOUNTS="$SPIKE/mirror-mini:/mirror" mkspec "$N" "$B/home" "$B/ws" "$B/run"
  runsc --root "$RS" --platform "$PLATFORM" --network none --host-uds open "${FLAGS[@]}" --overlay2 "root:dir=$B/ov,size=4g" run --detach --bundle "$SPIKE/specs/$N" "$N" </dev/null >"$B/run.log" 2>&1 || { echo "$cfg not-run start failed: $(tail -2 $B/run.log)" >> "$TSV"; continue; }
  sbx() { runsc --root "$RS" exec --user 1000:1000 --cwd /work "$N" /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/agent WS=/work MIRROR=/mirror /bin/sh -c "$1"; }
  sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
  run_cfg "$cfg" sbx
  runsc --root "$RS" delete -force "$N" >/dev/null 2>&1
done
echo "done: $TSV"
