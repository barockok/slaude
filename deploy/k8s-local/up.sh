#!/usr/bin/env bash
# Bring up slaude's horizontal-scale topology on a local single-node minikube:
# two gateway replicas, node workers for two labels (two `default`, one
# `finance`, each with its own signed credential), in-cluster Postgres and
# Redis, a dev Vault holding each persona's provider key, the mock MCP server
# the bridge calls, a shared $SLAUDE_HOME volume, and the local persona set
# (personas/local-set.json) synced through /deploy.
#
# Idempotent: re-running rebuilds the image from the current checkout and rolls
# the app pods onto it. Secrets are generated once and reused.
#
# Environment (all optional):
#   SLAUDE_LOCAL_PROFILE   minikube profile name             (default slaude-local);
#                          every kubectl call names its context, so a run never
#                          touches the current context of your shell
#   SLAUDE_LOCAL_CPUS      CPUs for the minikube node         (default LOCAL_NODE_CPUS in sizing.env)
#   SLAUDE_LOCAL_MEMORY    memory in MB for the minikube node (default LOCAL_NODE_MEMORY_MB in sizing.env)
#   SLAUDE_LOCAL_MODEL     the cluster-wide default SLAUDE_MODEL, for a gateway whose
#                          model names differ from the base ConfigMap's. Read from the
#                          shell, else from SLAUDE_LOCAL_ENV_FILE. Written to model.env.
#   SLAUDE_LOCAL_PORT      local port printed for the gateway forward (default 8080)
#   SLAUDE_LOCAL_ENV_FILE  a dotenv file to read LLM provider credentials from.
#                          Only ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL,
#                          ANTHROPIC_AUTH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN are
#                          taken from it; nothing else is read.
#   ANTHROPIC_* / CLAUDE_CODE_OAUTH_TOKEN
#                          taken from your shell when set, overriding the file.
#   SLAUDE_LOCAL_OVERLAY   a kustomize directory to apply instead of this one;
#                          it should build on this directory (used by e2e/up.sh).
#   SLAUDE_LOCAL_NODE_AUTH signed (default) | legacy: what the `default` node
#                          deployment presents. legacy = the shared legacy token
#                          (label default only); `finance` is always signed.
#   SLAUDE_LOCAL_LEGACY_DOOR open (default) | closed: closed sets
#                          SLAUDE_NODE_LEGACY=off on the gateways, so only signed
#                          credentials are accepted. Needs NODE_AUTH=signed.
#   SLAUDE_LOCAL_SYNC_PERSONAS 1 (default) | 0: sync the local persona set. The
#                          e2e suite sets 0: its cases need a never-synced tenant.
#   SLAUDE_LOCAL_ALPHA_SLACK_USER, SLAUDE_LOCAL_BETA_SLACK_USER, SLAUDE_LOCAL_MANAGER
#                          real Slack user ids for the persona set (personas.sh).
#
# Without provider credentials the cluster still boots and passes every HA
# check; the personas' Vault secrets then hold placeholders, and nodes simply
# cannot run a model turn.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Node size defaults and the provisional Docker VM floor live in one file.
# shellcheck source=/dev/null
. "$HERE/sizing.env"
# shellcheck source=/dev/null
. "$HERE/lib.sh"
PROFILE="${SLAUDE_LOCAL_PROFILE:-slaude-local}"
CPUS="${SLAUDE_LOCAL_CPUS:-$LOCAL_NODE_CPUS}"
MEMORY="${SLAUDE_LOCAL_MEMORY:-$LOCAL_NODE_MEMORY_MB}"
IMAGE="slaude:local"
NS="slaude-scale"
ROOT="$(cd "$HERE/../.." && pwd)"
SECRETS="$HERE/secrets.env"
PROVIDER="$HERE/provider.env"
MODEL_ENV="$HERE/model.env"
PROVIDER_KEYS=(ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN)

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

for bin in minikube kubectl openssl python3 bun; do
  command -v "$bin" >/dev/null || die "$bin is required"
done

# The Docker VM that hosts the minikube node. Smaller than the provisional floor
# still starts, and then fails under load in ways that look like product bugs.
if command -v docker >/dev/null && vm="$(docker info --format '{{.NCPU}} {{.MemTotal}}' 2>/dev/null)" && [[ "$vm" =~ ^[0-9]+\ [0-9]+$ ]]; then
  # shellcheck disable=SC2086 # two words, deliberately split
  vm_size_warning $vm "$LOCAL_VM_FLOOR_CPUS" "$LOCAL_VM_FLOOR_MEMORY_MB" || true
fi

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
# Every kubectl call below names this context explicitly; nothing depends on, or
# changes, the current context. Refuse to go on when minikube did not create it:
# a context of that name pointing anywhere else is not this cluster.
if ! kubectl config get-contexts -o name 2>/dev/null | grep -qxF "$PROFILE"; then
  die "kubectl has no context named '$PROFILE' (minikube creates it); refusing to apply anything"
fi
if [[ "$(kubectl config view -o jsonpath="{.contexts[?(@.name==\"$PROFILE\")].context.cluster}" 2>/dev/null)" != "$PROFILE" ]]; then
  die "kubectl context '$PROFILE' does not point at minikube's cluster '$PROFILE'; refusing to apply anything"
fi

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
    echo "SLAUDE_NODE_LEGACY_TOKEN=$(openssl rand -hex 24)"
    echo "SLAUDE_JOB_SECRET=$(openssl rand -hex 24)"
    echo "SLAUDE_PG_URL=postgres://slaude:slaude@postgres:5432/slaude"
    echo "SLAUDE_REDIS_URL=redis://redis:6379"
  } >"$SECRETS"
fi
# Non-secret connection settings added after a secrets.env was first generated.
# Appended when missing, never rewritten: the file is otherwise left alone.
ensure_secret() { grep -q "^$1=" "$SECRETS" || echo "$1=$2" >>"$SECRETS"; }
# A gateway refuses to boot with the brain on embedded PGLite; the brain uses its
# own database on the in-cluster Postgres (created by the dev datastores init).
ensure_secret SLAUDE_BRAIN_DATABASE_URL "postgres://slaude:slaude@postgres:5432/slaude_brain"
# Signs and verifies node credentials (gateway only; at least 32 characters).
ensure_secret SLAUDE_NODE_KEY "$(openssl rand -hex 32)"
# The gateway's Vault token. vault.sh creates a token with this id and a
# read-only policy, so the gateway never holds the root token.
ensure_secret SLAUDE_VAULT_TOKEN "$(openssl rand -hex 24)"
# The static bearer persona `beta` sends to the mock MCP server through the
# bridge, named by a ${PERSONA_*} placeholder in personas/local-set.json.
ensure_secret PERSONA_BETA_MOCKMCP_TOKEN "local-$(openssl rand -hex 16)"

# The dev Vault's root token, in its own file and Secret (the vault pod only).
VAULT_ROOT="$HERE/vault-root.env"
touch "$VAULT_ROOT"
SECRETS="$VAULT_ROOT"
ensure_secret VAULT_DEV_ROOT_TOKEN_ID "$(openssl rand -hex 24)"
SECRETS="$HERE/secrets.env"

# secrets.env is the GATEWAY's Secret. Nodes get their own: Redis in node.env
# (shared by every node deployment), and one credential file per node
# deployment. They are derived on every run rather than generated, so the token
# the gateway accepts and the token nodes present can never differ, and a
# cluster created before the split (which had one Secret for both tiers) keeps
# its existing values.
#
# The gateway reads the shared node token as SLAUDE_NODE_LEGACY_TOKEN; a node
# presents it as its own SLAUDE_NODE_TOKEN. A secrets.env written before that
# rename holds SLAUDE_NODE_TOKEN: the line is renamed in place (value kept), so
# the gateway never reads a node credential under the node's variable name.
if grep -q '^SLAUDE_NODE_TOKEN=' "$SECRETS" && ! grep -q '^SLAUDE_NODE_LEGACY_TOKEN=' "$SECRETS"; then
  sed -i.bak 's/^SLAUDE_NODE_TOKEN=/SLAUDE_NODE_LEGACY_TOKEN=/' "$SECRETS" && rm -f "$SECRETS.bak"
fi
NODE_ENV="$HERE/node.env"
grep -E '^SLAUDE_REDIS_URL=' "$SECRETS" >"$NODE_ENV" || true
[[ "$(wc -l <"$NODE_ENV" | tr -d ' ')" == 1 ]] \
  || die "$SECRETS must define SLAUDE_REDIS_URL exactly once; fix it or run ./down.sh --purge"
[[ "$(grep -c '^SLAUDE_NODE_LEGACY_TOKEN=' "$SECRETS")" == 1 ]] \
  || die "$SECRETS must define SLAUDE_NODE_LEGACY_TOKEN exactly once; fix it or run ./down.sh --purge"

# Node credentials, one per node deployment. The signed ones are minted once with
# the repo's CLI (bun) and kept in node-credentials.env; they are minted again when
# missing, when they no longer verify under SLAUDE_NODE_KEY, or with under 7 days
# left. Values are never printed.
NODE_AUTH="${SLAUDE_LOCAL_NODE_AUTH:-signed}"
LEGACY_DOOR="${SLAUDE_LOCAL_LEGACY_DOOR:-open}"
[[ "$NODE_AUTH" == signed || "$NODE_AUTH" == legacy ]] || die "SLAUDE_LOCAL_NODE_AUTH must be signed or legacy"
[[ "$LEGACY_DOOR" == open || "$LEGACY_DOOR" == closed ]] || die "SLAUDE_LOCAL_LEGACY_DOOR must be open or closed"
if [[ "$NODE_AUTH" == legacy && "$LEGACY_DOOR" == closed ]]; then
  die "SLAUDE_LOCAL_NODE_AUTH=legacy needs the legacy door open"
fi
CREDS="$HERE/node-credentials.env"
touch "$CREDS"
for label in default finance; do
  var="NODE_CRED_$(tr '[:lower:]' '[:upper:]' <<<"$label")"
  tok="$(sed -n "s/^$var=//p" "$CREDS" | tail -n1)"
  days=""
  [[ -n "$tok" ]] && days="$(node_credential_days_left "$ROOT" "$SECRETS" "$tok" || true)"
  if [[ -z "$days" ]] || ((days < 7)); then
    tok="$(mint_node_credential "$ROOT" "$SECRETS" "$label" "local-$label" 30d)" \
      || die "could not mint the $label node credential (bun src/cli/node-token.ts)"
    { grep -v "^$var=" "$CREDS" || true; printf '%s=%s\n' "$var" "$tok"; } >"$CREDS.tmp" && mv "$CREDS.tmp" "$CREDS"
    log "minted the $label node credential (id local-$label, 30 days)"
  fi
  if [[ "$label" == default && "$NODE_AUTH" == legacy ]]; then
    tok="$(sed -n 's/^SLAUDE_NODE_LEGACY_TOKEN=//p' "$SECRETS" | tail -n1)"
  fi
  printf 'SLAUDE_NODE_TOKEN=%s\n' "$tok" >"$HERE/node-cred-$label.env"
done
log "node auth: default=$NODE_AUTH, finance=signed; legacy door $LEGACY_DOOR"

# Gateway-only switches, merged into slaude-scale-gateway-config.
GATEWAY_ENV="$HERE/gateway.env"
: >"$GATEWAY_ENV"
if [[ "$LEGACY_DOOR" == closed ]]; then
  printf 'SLAUDE_NODE_LEGACY=off\n' >"$GATEWAY_ENV"
fi

# The pipeline credential for /deploy. It lives in its OWN file and Secret, not
# secrets.env, and is wired into the gateway only by key: a node holding the
# deploy token could rewrite persona identity — the one thing the separate
# token exists to prevent. 48 hex chars clears the gateway's 32-character
# floor. Never printed.
DEPLOY="$HERE/deploy.env"
touch "$DEPLOY"
SECRETS="$DEPLOY"
ensure_secret SLAUDE_DEPLOY_TOKEN "$(openssl rand -hex 24)"
SECRETS="$HERE/secrets.env"

# Provider credentials are rewritten every run. They reach the GATEWAY only (its
# own model calls, and vault.sh seeds each persona's Vault secret from this file);
# nodes take every persona's key from Vault through its runtime bundle.
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

# The cluster default model. It cannot ride in provider.env: pods load envFrom
# with the Secret first and the ConfigMap second, and the later source wins, so
# the base ConfigMap's SLAUDE_MODEL would override it. kustomization.yaml merges
# this file into that ConfigMap instead. The file always exists; empty means
# "keep the base default".
model="$(resolve_local_model)"
: >"$MODEL_ENV"
if [[ -n "$model" ]]; then
  printf 'SLAUDE_MODEL=%s\n' "$model" >"$MODEL_ENV"
  log "cluster default model: $model"
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
kubectl --context "$PROFILE" -n "$NS" get deploy slaude-gateway >/dev/null 2>&1 && existed=true

log "applying overlay"
kubectl kustomize --load-restrictor LoadRestrictionsNone "${SLAUDE_LOCAL_OVERLAY:-$HERE}" | kubectl --context "$PROFILE" apply -f -

# Same tag, new build: the Deployment spec is unchanged, so roll it explicitly.
if $existed; then
  log "rolling app pods onto the new image"
  kubectl --context "$PROFILE" -n "$NS" rollout restart deploy/slaude-gateway deploy/slaude-node deploy/slaude-node-finance deploy/mock-mcp
fi

# --- 5. Wait ---------------------------------------------------------------
log "waiting for rollouts"
kubectl --context "$PROFILE" -n "$NS" rollout status deploy/dev-postgres --timeout=600s

# Postgres creates the brain database from its init script, but only when its
# data directory is first initialised. A volume created before that script
# existed never gets it, and minikube's hostpath storage names directories
# after the claim, so deleting and recreating the claim reattaches the old
# data. Without the database a gateway exits and is restarted in a loop.
log "ensuring the brain database exists"
ensure_brain_database

for d in dev-redis vault mock-mcp slaude-gateway slaude-node slaude-node-finance; do
  kubectl --context "$PROFILE" -n "$NS" rollout status "deploy/$d" --timeout=600s
done

# --- 6. Vault and the persona set --------------------------------------------
# Every run: dev mode keeps Vault in memory, so a restarted vault pod is empty.
log "seeding the dev Vault"
SLAUDE_LOCAL_PROFILE="$PROFILE" "$HERE/vault.sh" seed

if [[ "${SLAUDE_LOCAL_SYNC_PERSONAS:-1}" == 1 ]]; then
  # Knowledge sources are registered when a gateway boots, so a new knowledge
  # base needs one gateway restart before a persona can search it.
  log "creating the local knowledge bases"
  created="$(SLAUDE_LOCAL_PROFILE="$PROFILE" "$HERE/personas.sh" kb)"
  if [[ "$created" != 0 ]]; then
    kubectl --context "$PROFILE" -n "$NS" rollout restart deploy/slaude-gateway
    kubectl --context "$PROFILE" -n "$NS" rollout status deploy/slaude-gateway --timeout=600s
  fi
  log "syncing the local persona set (default, alpha on default, beta on finance)"
  SLAUDE_LOCAL_PROFILE="$PROFILE" "$HERE/personas.sh" sync \
    || die "the persona sync was refused (see the JSON line above)"
else
  log "persona sync skipped (SLAUDE_LOCAL_SYNC_PERSONAS=0)"
fi

log "ready"
kubectl --context "$PROFILE" -n "$NS" get pods -o wide
cat <<EOF

Next:
  $HERE/verify-ha.sh                         # prove failover behaviour
  $HERE/verify-turns.sh                      # prove turn delivery, labels, rotation, the bridge
  $HERE/forward.sh gateway                   # self-healing forward on localhost:${SLAUDE_LOCAL_PORT:-8080}
  $HERE/down.sh                              # delete the cluster
EOF
