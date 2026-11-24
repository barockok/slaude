#!/usr/bin/env bash
# Box smoke test: a real node worker runs sessions in real sandboxes, on both tiers, against the mock model.
#
#   scripts/smoke/box-smoke.sh              both tiers (gvisor, then bwrap)
#   scripts/smoke/box-smoke.sh gvisor       one tier
#
# On macOS it re-runs itself inside the Colima VM (colima ssh), where the repository is visible at the same path.
# On Linux it needs root, Docker, runsc (gVisor), skopeo and umoci; bubblewrap is installed with apt when missing.
# It never starts or stops the VM, and it needs no credential: the model is e2e/mock-llm, and "the provider's real
# credential" is a random string the test invents.
#
# What it runs, per tier (both files are skipped by a plain `bun test`):
#   tests/box/tier-contract.test.ts        the sandbox contract: isolation, limits, network, abort, what persists
#   tests/node/worker-box-real.test.ts     a node worker with SLAUDE_BOX_TIER set, the supervisor as its own root
#                                          process, the real CLI in a box, a turn with a Bash tool call
#
# Work area: $SLAUDE_SMOKE_DIR (default /var/lib/slaude-smoke), on the machine's own disk: a copy of the repository
# with Linux dependencies, a pinned Bun, the compiled box-init, the box image, and logs/<tier>.log.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TIERS="${*:-gvisor bwrap}"

if [ "$(uname -s)" = "Darwin" ]; then
  command -v colima >/dev/null || { echo "box-smoke: on macOS this needs a running Colima VM (colima ssh)"; exit 2; }
  exec colima ssh -- sudo env SLAUDE_SMOKE_DIR="${SLAUDE_SMOKE_DIR:-}" bash "$SRC/scripts/smoke/box-smoke.sh" $TIERS
fi

[ "$(id -u)" = "0" ] || exec sudo env SLAUDE_SMOKE_DIR="${SLAUDE_SMOKE_DIR:-}" bash "$0" $TIERS

SMOKE="${SLAUDE_SMOKE_DIR:-/var/lib/slaude-smoke}"
BUN_VERSION="1.3.11"
REDIS_PORT=16379
MOCK_PORT=18080
export PATH="$SMOKE/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

say() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null || { echo "box-smoke: $1 is not installed ($2)"; exit 2; }; }

need docker "the box image, Redis and the mock model run in it"
need skopeo "it turns the box image into an OCI layout"
need umoci "the image cache unpacks with it"
need curl "to fetch the pinned Bun"
need unzip "to unpack the pinned Bun"
for tier in $TIERS; do
  case "$tier" in
    gvisor) need runsc "install gVisor: https://gvisor.dev/docs/user_guide/install/" ;;
    bwrap) command -v bwrap >/dev/null || { say "installing bubblewrap"; apt-get install -y bubblewrap >/dev/null; } ;;
    *) echo "box-smoke: unknown tier '$tier' (gvisor or bwrap)"; exit 2 ;;
  esac
done

mkdir -p "$SMOKE/repo" "$SMOKE/logs" "$SMOKE/init" "$SMOKE/tmp"
# A node refuses to start a sandbox with less than 1 GB free on its box volume (the admission rule, working as
# meant), and this run needs room for an image, unpacked copies of it and a container image on top.
free_mb="$(df -Pm "$SMOKE" | awk 'NR==2 {print $4}')"
[ "$free_mb" -ge 3072 ] || { echo "box-smoke: $SMOKE has $free_mb MB free; at least 3072 MB are needed"; exit 2; }

say "copying the repository to $SMOKE/repo"
find "$SMOKE/repo" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
# tar exits 1 when a file changed while it was read (an editor, another checkout of the tree): the copy is still whole.
{ tar -C "$SRC" --warning=no-file-changed --exclude ./node_modules --exclude ./.git --exclude ./.claude --exclude ./coverage --exclude ./dist -cf - . || [ $? -eq 1 ]; } | tar -C "$SMOKE/repo" -xf - --no-same-owner
cd "$SMOKE/repo"

if [ "$("$SMOKE/bun/bin/bun" --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  say "fetching Bun $BUN_VERSION (the version the image is built on)"
  case "$(uname -m)" in
    aarch64 | arm64) asset=bun-linux-aarch64 ;;
    x86_64) asset=bun-linux-x64 ;;
    *) echo "box-smoke: no Bun build for $(uname -m)"; exit 2 ;;
  esac
  tmp="$(mktemp -d)"
  base="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
  curl -fsSL -o "$tmp/$asset.zip" "$base/$asset.zip"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  (cd "$tmp" && grep " $asset.zip\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
  (cd "$tmp" && unzip -q "$asset.zip")
  mkdir -p "$SMOKE/bun/bin"
  install -m 0755 "$tmp/$asset/bun" "$SMOKE/bun/bin/bun"
  rm -rf "$tmp"
fi

if [ ! -d node_modules ] || ! cmp -s bun.lock node_modules/.lock-stamp; then
  say "installing dependencies"
  # No build scripts: a module compiled on this machine against libuv does not load in Bun, and the product image has none.
  rm -rf node_modules
  bun install --frozen-lockfile --ignore-scripts >/dev/null
  cp bun.lock node_modules/.lock-stamp
fi

say "compiling box-init"
bun build --compile src/box/init/main.ts --outfile "$SMOKE/init/box-init" >/dev/null

say "building the box image and its OCI layout"
docker build -q -t slaude-box-smoke:dev scripts/smoke/box >/dev/null
rm -rf "$SMOKE/layout"
skopeo copy --quiet docker-daemon:slaude-box-smoke:dev "oci:$SMOKE/layout:box"

say "starting Redis and the mock model"
IMAGE=slaude-mock-llm:smoke bash scripts/build-mock-llm.sh >/dev/null 2>&1
cleanup() {
  docker rm -f slaude-smoke-redis slaude-smoke-mock >/dev/null 2>&1 || true
  # Test homes and work directories of this run. The container image is rebuilt by the next run.
  rm -rf "$SMOKE/tmp" "$SMOKE/work"
  [ "${SLAUDE_SMOKE_KEEP_IMAGES:-0}" = "1" ] || docker rmi slaude-box-nested:smoke >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
mkdir -p "$SMOKE/tmp" "$SMOKE/work"
docker run -d --rm --name slaude-smoke-redis -p "127.0.0.1:$REDIS_PORT:6379" redis:7-alpine >/dev/null
docker run -d --rm --name slaude-smoke-mock -p "127.0.0.1:$MOCK_PORT:8080" slaude-mock-llm:smoke >/dev/null
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$MOCK_PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "http://127.0.0.1:$MOCK_PORT/healthz" >/dev/null || { echo "box-smoke: the mock model did not come up"; exit 1; }

status=0
summary=""
for tier in $TIERS; do
  say "tier $tier ($( [ "$tier" = gvisor ] && runsc --version | head -1 || bwrap --version ))"
  log="$SMOKE/logs/$tier.log"
  # A clean environment: nothing of the caller's reaches the tests, the worker or the supervisor.
  set +e
  env -i PATH="$PATH" HOME=/root TMPDIR="$SMOKE/tmp" \
    SLAUDE_BOX_TEST_TIER="$tier" \
    SLAUDE_BOX_TEST_LAYOUT="$SMOKE/layout" \
    SLAUDE_BOX_TEST_INIT_DIR="$SMOKE/init" \
    SLAUDE_REDIS_TEST_URL="redis://127.0.0.1:$REDIS_PORT" \
    SLAUDE_BOX_TEST_MOCK_LLM="http://127.0.0.1:$MOCK_PORT" \
    bun test tests/box/tier-contract.test.ts tests/node/worker-box-real.test.ts --timeout 120000 >"$log" 2>&1
  code=$?
  set -e
  grep -E '^\((pass|fail|skip)\)|^\[tier ' "$log" || true
  counts="$(grep -E '^ +[0-9]+ (pass|fail|skip)$' "$log" | tr -s ' ' | tr '\n' ',' | sed 's/,$//')"
  summary="$summary\n  $tier:$counts (exit $code, log $log)"
  [ "$code" = "0" ] || status=1
done

# The same two suites again, NESTED: in a privileged container with its own cgroup namespace and a memory limit,
# which is the shape of the supervisor container in a node pod (not a pod: no Kubernetes is involved). The image is
# built from the box layers of the repository's own Dockerfile, so those lines (the pinned runsc, bubblewrap, tini,
# the compiled box-init) are what runs. Skip with SLAUDE_SMOKE_NESTED=0.
if [ "${SLAUDE_SMOKE_NESTED:-1}" != "0" ]; then
  say "building the box layers of the Dockerfile"
  mkdir -p "$SMOKE/nested" "$SMOKE/work"
  {
    awk '/^FROM oven\/bun:1.3-debian AS boxinit/,/^$/' Dockerfile
    echo 'FROM oven/bun:1.3-debian'
    echo 'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl && rm -rf /var/lib/apt/lists/*'
    echo 'ARG TARGETARCH'
    awk '/^ARG RUNSC_VERSION/,/^COPY --from=boxinit/' Dockerfile
  } >"$SMOKE/nested/Dockerfile"
  docker build -q -t slaude-box-nested:smoke -f "$SMOKE/nested/Dockerfile" "$SMOKE/repo" >/dev/null
  for tier in $TIERS; do
    say "tier $tier, nested in a privileged container (private cgroup namespace, 4 GB)"
    log="$SMOKE/logs/$tier-nested.log"
    rm -rf "$SMOKE/work"/* "$SMOKE/tmp"/*
    set +e
    # tini as pid 1, as the supervisor container must be started: runsc and bwrap leave processes for pid 1 to reap.
    docker run --rm --privileged --cgroupns=private --memory=4g --network host \
      -v "$SMOKE:$SMOKE" -w "$SMOKE/repo" \
      -e TMPDIR="$SMOKE/tmp" \
      -e SLAUDE_BOX_TEST_TIER="$tier" \
      -e SLAUDE_BOX_TEST_LAYOUT="$SMOKE/layout" \
      -e SLAUDE_BOX_TEST_INIT_DIR=/usr/local/lib/slaude-box \
      -e SLAUDE_BOX_TEST_WORKDIR="$SMOKE/work" \
      -e SLAUDE_REDIS_TEST_URL="redis://127.0.0.1:$REDIS_PORT" \
      -e SLAUDE_BOX_TEST_MOCK_LLM="http://127.0.0.1:$MOCK_PORT" \
      slaude-box-nested:smoke tini -- bun test tests/box/tier-contract.test.ts tests/node/worker-box-real.test.ts --timeout 120000 >"$log" 2>&1
    code=$?
    set -e
    grep -E '^\((pass|fail|skip)\)|^\[tier ' "$log" || true
    counts="$(grep -E '^ +[0-9]+ (pass|fail|skip)$' "$log" | tr -s ' ' | tr '\n' ',' | sed 's/,$//')"
    summary="$summary\n  $tier, nested:$counts (exit $code, log $log)"
    [ "$code" = "0" ] || status=1
  done
  rm -rf "$SMOKE/work"
fi

say "summary"
printf '%b\n' "$summary"
[ "$status" = "0" ] && echo "box-smoke: PASS" || echo "box-smoke: FAIL (see the logs above)"
exit "$status"
