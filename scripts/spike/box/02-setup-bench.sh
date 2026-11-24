#!/usr/bin/env bash
# Prepare everything Spike 2 needs, once: toolchain image (docker + exported rootfs + EROFS), a synthetic
# 20,000-file git mirror, and offline caches (bun, npm, pip wheels, go modules) seeded into a fake home.
# Run as root in the VM: sudo bash 02-setup-bench.sh        (needs network; ~10 min)
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$HERE/lib.sh"
S=$SPIKE
mkdir -p "$S/ctx" "$S/mirror" "$S/seed/home"
exec > >(tee "$RESULTS/02-setup-bench.txt") 2>&1

echo "== image"
BUN=$(readlink -f /usr/local/bin/bun)
cp -f "$BUN" "$S/ctx/bun"
cp -f "$(find "$S/sdk/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64" -name claude -type f | head -1)" "$S/ctx/claude"
[ -x "$BUNDLE/rootfs/usr/local/bin/box-probe" ] && cp -f "$BUNDLE/rootfs/usr/local/bin/box-probe" "$S/ctx/box-probe"
docker build -q -t slaude-bench -f "$HERE/Dockerfile.bench" "$S/ctx"
if [ ! -d "$S/bench-root/usr" ]; then
  mkdir -p "$S/bench-root"
  cid=$(docker create slaude-bench /bin/true)
  docker export "$cid" | tar -x -C "$S/bench-root"
  docker rm "$cid" >/dev/null
fi
du -sm "$S/bench-root"
if [ ! -f "$S/bench.erofs" ]; then
  mkfs.erofs -zlz4hc "$S/bench.erofs" "$S/bench-root" 2>&1 | tail -3
fi
ls -la "$S/bench.erofs"

echo "== synthetic git mirror: 20,000 files, 120 commits, branches main and feature"
if [ ! -d "$S/mirror/synth.git" ]; then
  python3 - "$S/mirror/synth.git" <<'PY'
import subprocess,sys,random,os
dst=sys.argv[1]
subprocess.run(["git","init","-q","--bare",dst],check=True)
random.seed(7)
def blob(i,v): return (f"// file {i} version {v}\n"+("\n".join(f"line {j} of file {i} xyzzy{(i*j)%97}" for j in range(40)))+"\n").encode()
out=[]
mark=[0]
def emit_commit(ref,msg,files,parent=None):
    mark[0]+=1
    m=mark[0]
    out.append(f"commit {ref}\nmark :{m}\ncommitter Spike <spike@example.invalid> {1700000000+m*60} +0000\ndata {len(msg)}\n{msg}\n")
    if parent: out.append(f"from :{parent}\n")
    for path,data in files:
        out.append(f"M 100644 inline {path}\ndata {len(data)}\n")
        out.append(data.decode()+"\n")
    return m
N=20000
files=[(f"pkg{i%400:03d}/sub{(i//400)%5}/file{i}.ts",blob(i,0)) for i in range(N)]
last=emit_commit("refs/heads/main","initial",files)
for c in range(1,120):
    ch=[(f"pkg{random.randrange(400):03d}/sub{random.randrange(5)}/file{k}.ts",blob(k,c)) for k in random.sample(range(N),25)]
    last=emit_commit("refs/heads/main",f"change {c}",ch,last)
    if c==60: base=last
fb=base
for c in range(5):
    ch=[(f"pkg{random.randrange(400):03d}/sub{random.randrange(5)}/file{k}.ts",blob(k,1000+c)) for k in random.sample(range(N),200)]
    fb=emit_commit("refs/heads/feature",f"feature {c}",ch,fb)
data="".join(out).encode()
subprocess.run(["git","--git-dir",dst,"fast-import","--quiet"],input=data,check=True)
subprocess.run(["git","--git-dir",dst,"symbolic-ref","HEAD","refs/heads/main"],check=True)
PY
  git --git-dir "$S/mirror/synth.git" count-objects -vH | head -4
fi

echo "== JS project (about 1,000 packages): bun and npm caches"
P=$S/seed/proj; mkdir -p "$P"
cat > "$P/package.json" <<'JSON'
{ "name": "spike-proj", "version": "1.0.0", "private": true,
  "dependencies": { "next": "14.2.15", "react": "18.3.1", "react-dom": "18.3.1", "typescript": "5.6.3", "webpack": "5.95.0",
    "@babel/core": "7.25.8", "@babel/preset-env": "7.25.8", "@babel/preset-react": "7.25.7", "jest": "29.7.0", "eslint": "8.57.1", "vite": "5.4.9",
    "@aws-sdk/client-s3": "3.670.0", "lodash": "4.17.21", "express": "4.21.1", "axios": "1.7.7", "rxjs": "7.8.1", "zod": "3.23.8", "prettier": "3.3.3" } }
JSON
export HOME=$S/seed/home
cd "$P"
if [ ! -f bun.lock ] && [ ! -f bun.lockb ]; then bun install 2>&1 | tail -3; fi
rm -rf node_modules
if [ ! -f package-lock.json ]; then npm install --package-lock-only --no-audit --no-fund 2>&1 | tail -2; fi
npm ci --no-audit --no-fund --ignore-scripts 2>&1 | tail -2   # populates ~/.npm
rm -rf node_modules
bun install --frozen-lockfile 2>&1 | tail -3   # populates ~/.bun cache
echo "packages in node_modules (bun): $(find node_modules -maxdepth 3 -name package.json -path '*/node_modules/*' | wc -l)"
echo "lock entries: $(grep -c 'resolved' package-lock.json)"
rm -rf node_modules
du -sm "$S/seed/home/.bun" "$S/seed/home/.npm" 2>/dev/null

echo "== pip wheels"
mkdir -p "$S/seed/home/wheels"
python3 -m pip download --quiet --dest "$S/seed/home/wheels" numpy 2>&1 | tail -2 || true
ls "$S/seed/home/wheels" | head

echo "== go module and mirror"
if [ ! -d "$S/mirror/xtools.git" ]; then git clone -q --bare --branch v0.21.0 https://go.googlesource.com/tools "$S/mirror/xtools.git" 2>&1 | tail -2 || git clone -q --bare --branch v0.21.0 https://github.com/golang/tools "$S/mirror/xtools.git"; fi
rm -rf "$S/seed/xtools"; git clone -q "$S/mirror/xtools.git" "$S/seed/xtools"
cd "$S/seed/xtools" && GOFLAGS=-mod=mod GOMODCACHE=$S/seed/home/go/pkg/mod go mod download 2>&1 | tail -2
( time GOCACHE=$S/seed/gocache-tmp GOMODCACHE=$S/seed/home/go/pkg/mod go build ./... ) 2>&1 | tail -4
rm -rf "$S/seed/gocache-tmp" "$S/seed/xtools"
chown -R 1000:1000 "$S/seed" "$S/mirror"
du -sm "$S/seed" "$S/mirror"
echo setup-done
