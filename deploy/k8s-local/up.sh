#!/usr/bin/env bash
# Bring up slaude's horizontal-scale topology on a local single-node minikube:
# two gateway replicas, two node workers, in-cluster Postgres and Redis, and a
# shared $SLAUDE_HOME volume.
#
# Idempotent: re-running rebuilds the image from the current checkout and rolls
# the app pods onto it. Secrets are generated once and reused.
#
# Environment (all optional):
#   SLAUDE_LOCAL_PROFILE   minikube profile name             (default slaude-local)
#   SLAUDE_LOCAL_CPUS      CPUs for the minikube node         (default 3)
#   SLAUDE_LOCAL_MEMORY    memory in MB for the minikube node (default 3500)
#   SLAUDE_LOCAL_ENV_FILE  a dotenv file to read LLM provider credentials from.
#                          Only ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL,
#                          ANTHROPIC_AUTH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN are
#                          taken from it; nothing else is read.
#   ANTHROPIC_* / CLAUDE_CODE_OAUTH_TOKEN
#                          taken from your shell when set, overriding the file.
#
# Without provider credentials the cluster still boots and passes every HA
# check; nodes simply cannot run a model turn.
set -euo pipefail

PROFILE="${SLAUDE_LOCAL_PROFILE:-slaude-local}"
CPUS="${SLAUDE_LOCAL_CPUS:-3}"
MEMORY="${SLAUDE_LOCAL_MEMORY:-3500}"
IMAGE="slaude:local"
NS="slaude-scale"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SECRETS="$HERE/secrets.env"
PROVIDER="$HERE/provider.env"
PROVIDER_KEYS=(ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN)

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

for bin in minikube kubectl openssl python3; do
  command -v "$bin" >/dev/null || die "$bin is required"
done

# --- 1. Cluster ------------------------------------------------------------
if minikube -p "$PROFILE" status --format '{{.Host}}' 2>/dev/null | grep -q Running; then
  log "minikube profile '$PROFILE' already running"
else
  # Download first, outside the start timer. minikube gives host creation a
  # fixed six minutes, and on a slow link the ~480 MB base image alone can take
  # longer — the start then times out, retries, and can leave an orphaned node
  # container holding its memory reservation. A cached download is a no-op.
  #
  # The sizing flags MUST be passed here too. --download-only still writes the
  # profile, and a later start refuses to resize an existing profile — it warns
  # and silently keeps whatever this call recorded, which is minikube's default
  # (4000 MB here): more than intended, and on a swapless Docker VM enough to
  # push other containers into the OOM killer.
  log "fetching minikube base image and Kubernetes preload (skipped when cached)"
  minikube start -p "$PROFILE" --driver=docker --cpus="$CPUS" --memory="$MEMORY" --download-only

  log "starting minikube profile '$PROFILE' (${CPUS} CPU, ${MEMORY} MB)"
  if ! minikube start -p "$PROFILE" --driver=docker --cpus="$CPUS" --memory="$MEMORY" \
    --addons=metrics-server; then
    # A failed start can leave a half-created node container running. Remove it
    # rather than leave it reserving memory on the Docker host.
    minikube delete -p "$PROFILE" >/dev/null 2>&1 || true
    die "minikube failed to start; the partial cluster was removed. Re-run to retry — downloads are cached."
  fi
fi
kubectl config use-context "$PROFILE" >/dev/null

# Refuse to continue on a node sized differently from what was asked for. An
# existing profile keeps its original size no matter what flags are passed, so
# without this check a stale profile silently wins.
actual="$(minikube profile list -o json 2>/dev/null | PROFILE="$PROFILE" python3 -c '
import json, os, sys
for p in json.load(sys.stdin).get("valid", []):
    if p["Name"] == os.environ["PROFILE"]:
        print(p["Config"]["CPUs"], p["Config"]["Memory"])
')"
if [[ "$actual" != "$CPUS $MEMORY" ]]; then
  die "profile '$PROFILE' is sized '${actual:-unknown}' (CPUs MB), not '$CPUS $MEMORY'. Run ./down.sh and re-run."
fi

# --- 2. Secrets ------------------------------------------------------------
# Generated once. Regenerating SLAUDE_MASTER_KEY would orphan every encrypted
# slack_apps row, so an existing file is never overwritten.
umask 077
if [[ ! -s "$SECRETS" ]]; then
  log "generating $SECRETS"
  {
    echo "SLAUDE_MASTER_KEY=$(openssl rand -base64 32)"
    echo "SLAUDE_NODE_TOKEN=$(openssl rand -hex 24)"
    echo "SLAUDE_JOB_SECRET=$(openssl rand -hex 24)"
    echo "SLAUDE_PG_URL=postgres://slaude:slaude@postgres:5432/slaude"
    echo "SLAUDE_REDIS_URL=redis://redis:6379"
  } >"$SECRETS"
fi

# Provider credentials are rewritten every run, so rotating a key is a re-run.
# Values are never printed.
: >"$PROVIDER"
found=()
for key in "${PROVIDER_KEYS[@]}"; do
  val="${!key:-}"
  if [[ -z "$val" && -n "${SLAUDE_LOCAL_ENV_FILE:-}" ]]; then
    [[ -r "$SLAUDE_LOCAL_ENV_FILE" ]] || die "SLAUDE_LOCAL_ENV_FILE is not readable: $SLAUDE_LOCAL_ENV_FILE"
    # Last assignment wins, matching dotenv semantics. Surrounding quotes are stripped.
    val="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$SLAUDE_LOCAL_ENV_FILE" | tail -n1 \
      | sed -E "s/^[[:space:]]*(export[[:space:]]+)?${key}=//; s/^[\"']//; s/[\"']$//" || true)"
  fi
  if [[ -n "$val" ]]; then
    printf '%s=%s\n' "$key" "$val" >>"$PROVIDER"
    found+=("$key")
  fi
done
if ((${#found[@]})); then
  log "provider credentials present: ${found[*]}"
else
  log "no provider credentials found — cluster will boot, but nodes cannot run model turns"
fi

# --- 3. Image --------------------------------------------------------------
# Refuse to build without disk headroom, BEFORE starting. The node's storage is
# a volume on the Docker host's disk, shared with every other container there.
#
# This has to be a precondition, not a watchdog: killing `minikube image build`
# only disconnects the client, and BuildKit inside the node keeps writing. An
# observed build consumed more than 2.7 GB and was still going when the host
# disk hit 100%. The default floor is set above that, and is overridable.
MIN_FREE_MB="${SLAUDE_LOCAL_MIN_BUILD_FREE_MB:-5000}"
free_mb="$(minikube -p "$PROFILE" ssh -- df -m /var 2>/dev/null | tr -d '\r' | awk 'NR==2 {print $4}')"
if [[ ! "$free_mb" =~ ^[0-9]+$ ]]; then
  die "could not read free disk space on the minikube node; refusing to build blind"
fi
if ((free_mb < MIN_FREE_MB)); then
  die "only ${free_mb} MB free on the Docker host disk; the image build needs at least ${MIN_FREE_MB} MB.
Filling that disk can break every other container sharing it. Free space or grow
the disk, then re-run. See the README's disk space section.
(Override with SLAUDE_LOCAL_MIN_BUILD_FREE_MB at your own risk.)"
fi
log "disk headroom ok: ${free_mb} MB free (floor ${MIN_FREE_MB} MB)"

# Built inside minikube so imagePullPolicy: Never finds it. The first build is
# slow; later builds reuse the layer cache.
log "building $IMAGE from $ROOT inside minikube"
minikube -p "$PROFILE" image build -t "$IMAGE" "$ROOT"

# --- 4. Apply --------------------------------------------------------------
existed=false
kubectl -n "$NS" get deploy slaude-gateway >/dev/null 2>&1 && existed=true

log "applying overlay"
kubectl kustomize --load-restrictor LoadRestrictionsNone "$HERE" | kubectl apply -f -

# Same tag, new build: the Deployment spec is unchanged, so roll it explicitly.
if $existed; then
  log "rolling app pods onto the new image"
  kubectl -n "$NS" rollout restart deploy/slaude-gateway deploy/slaude-node
fi

# --- 5. Wait ---------------------------------------------------------------
log "waiting for rollouts"
for d in dev-postgres dev-redis slaude-gateway slaude-node; do
  kubectl -n "$NS" rollout status "deploy/$d" --timeout=600s
done

log "ready"
kubectl -n "$NS" get pods -o wide
cat <<EOF

Next:
  $HERE/verify-ha.sh                         # prove failover behaviour
  kubectl -n $NS port-forward svc/slaude-gateway 8080:8080
  $HERE/down.sh                              # delete the cluster
EOF
