#!/usr/bin/env bash
# Shared helpers for the local cluster scripts. Sourced, never run.
#
# The caller defines `log` and `die` (die must exit or return non-zero), and
# NS, PROFILE where a function says it reads them.

# Say something in the caller's way when it has one (`diag` writes to stdout and
# a log file), plainly otherwise.
_say() {
  if declare -F diag >/dev/null; then diag "$*"; else printf '%s\n' "$*"; fi
}

# Whether something already listens on a local TCP port. Pure bash, so it needs
# neither nc nor lsof, and it tests the loopback address a forward would bind.
port_in_use() { # <port>
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# Warning text when the Docker VM is below the provisional floor in sizing.env.
# Prints nothing and returns 0 when it is big enough; prints the warning and
# returns 1 when it is not. Docker reports a little less than the VM's nominal
# memory, so the memory floor is compared with a 7 % allowance.
vm_size_warning() { # <ncpu> <mem-bytes> <floor-cpus> <floor-mem-mb>
  local ncpu="$1" mem_mb=$(($2 / 1024 / 1024)) floor_cpus="$3" floor_mb="$4"
  if ((ncpu < floor_cpus || mem_mb < floor_mb * 93 / 100)); then
    printf 'WARNING: the Docker VM has %s CPU and %s MB; the provisional floor is %s CPU and %s MB.\n' \
      "$ncpu" "$mem_mb" "$floor_cpus" "$floor_mb"
    printf '         Below it the cluster can start and still fail under load (probe timeouts,\n'
    printf '         OOM kills, verify scripts that "could not measure"). The floor is provisional.\n'
    return 1
  fi
}

# Wait for Postgres to accept TCP connections, then make sure the brain
# database exists. Reads NS. Tunables: PG_TRIES (30), PG_SLEEP (2),
# CREATE_TRIES (5).
#
# TCP matters. On first initialisation the Postgres image runs a temporary
# server that listens on the unix socket only, runs the init scripts, and
# restarts. `pg_isready` without -h succeeds against that temporary server, and
# a CREATE DATABASE then races the init script's own. 127.0.0.1 is not served
# by the temporary server.
#
# "already exists" counts as success: whoever got there first made the same
# database. Anything else is retried, and the last failure is reported rather
# than swallowed.
ensure_brain_database() {
  local tries="${PG_TRIES:-30}" nap="${PG_SLEEP:-2}" create_tries="${CREATE_TRIES:-5}" i out
  local up=false
  for ((i = 1; i <= tries; i++)); do
    if kubectl -n "$NS" exec deploy/dev-postgres -c postgres -- pg_isready -h 127.0.0.1 -U slaude >/dev/null 2>&1; then
      up=true
      break
    fi
    sleep "$nap"
  done
  if ! $up; then
    die "postgres did not accept TCP connections after $tries attempts (pg_isready -h 127.0.0.1); check: kubectl -n $NS logs deploy/dev-postgres"
    return 1
  fi

  psql_pg() { kubectl -n "$NS" exec deploy/dev-postgres -c postgres -- psql -U slaude -v ON_ERROR_STOP=1 "$@"; }
  for ((i = 1; i <= create_tries; i++)); do
    # stdout only, compared exactly: stderr text must not be able to match.
    if out="$(psql_pg -d postgres -tAc "select 1 from pg_database where datname = 'slaude_brain'" 2>/dev/null)" && [[ "$out" == 1 ]]; then
      break
    fi
    if out="$(psql_pg -d postgres -c "CREATE DATABASE slaude_brain" 2>&1)"; then
      break
    fi
    if grep -qi 'already exists' <<<"$out"; then
      break
    fi
    if ((i == create_tries)); then
      die "could not create the slaude_brain database after $create_tries attempts; last error: $(tail -n1 <<<"$out")"
      return 1
    fi
    sleep "$nap"
  done
  psql_pg -d slaude_brain -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null
}

# --- node HPA pinning (verify scripts) --------------------------------------
# The local overlay keeps a CPU HPA on the node Deployment (min 2, max 3). Turn
# load can scale it to three, and its 10-minute scale-down window then holds it
# there, so a script that assumes two nodes sees three. The scripts pin
# maxReplicas to minReplicas for the run and restore it on exit.
#
# The original maxReplicas is also kept in an annotation on the HPA, so a run
# that was killed before its trap fired (SIGKILL, lost terminal) cannot make the
# next run record the pinned value as the original.
HPA_NAME="${HPA_NAME:-slaude-node-cpu-fallback}"
HPA_ANNOTATION="slaude.dev/original-max-replicas"

# Reads NS and PROFILE. Says why and returns non-zero when the HPA cannot be
# read or patched; the caller decides whether that is fatal.
pin_node_hpa() {
  local min max saved
  local err
  min="$(kubectl --context "$PROFILE" -n "$NS" get hpa "$HPA_NAME" -o jsonpath='{.spec.minReplicas}' 2>&1)"
  max="$(kubectl --context "$PROFILE" -n "$NS" get hpa "$HPA_NAME" -o jsonpath='{.spec.maxReplicas}' 2>&1)"
  if [[ ! "$min" =~ ^[0-9]+$ || ! "$max" =~ ^[0-9]+$ ]]; then
    err="$(printf '%s %s' "$min" "$max" | tr '\n' ' ')"
    _say "  !! could not read minReplicas/maxReplicas of hpa/$HPA_NAME: ${err:0:300}"
    return 1
  fi
  saved="$(kubectl --context "$PROFILE" -n "$NS" get hpa "$HPA_NAME" -o 'jsonpath={.metadata.annotations.slaude\.dev/original-max-replicas}' 2>/dev/null)"
  if [[ "$saved" =~ ^[0-9]+$ ]]; then
    PINNED_ORIGINAL_MAX="$saved"
  else
    PINNED_ORIGINAL_MAX="$max"
  fi
  if ! kubectl --context "$PROFILE" -n "$NS" patch hpa "$HPA_NAME" --type merge \
    -p "{\"metadata\":{\"annotations\":{\"$HPA_ANNOTATION\":\"$PINNED_ORIGINAL_MAX\"}},\"spec\":{\"maxReplicas\":$min}}" >/dev/null; then
    _say "  !! could not pin hpa/$HPA_NAME to $min replicas"
    return 1
  fi
  PINNED_HPA=1
}

# Wait (bounded) until a deployment reports exactly <n> ready replicas. Reads NS
# and PROFILE. Non-zero on timeout.
wait_deploy_ready() { # <deployment> <n> <timeout-seconds>
  local deadline=$(($(date +%s) + $3)) got
  while :; do
    got="$(kubectl --context "$PROFILE" -n "$NS" get deploy "$1" -o jsonpath='{.status.readyReplicas}' 2>/dev/null)"
    [[ "$got" == "$2" ]] && return 0
    (($(date +%s) >= deadline)) && return 1
    sleep "${POLL_FAST:-2}"
  done
}

restore_node_hpa() {
  [[ "${PINNED_HPA:-0}" == 1 ]] || return 0
  if kubectl --context "$PROFILE" -n "$NS" patch hpa "$HPA_NAME" --type merge \
    -p "{\"metadata\":{\"annotations\":{\"$HPA_ANNOTATION\":null}},\"spec\":{\"maxReplicas\":$PINNED_ORIGINAL_MAX}}" >/dev/null; then
    PINNED_HPA=0
  else
    _say "  !! could not restore hpa/$HPA_NAME maxReplicas to $PINNED_ORIGINAL_MAX; restore it by hand"
    return 1
  fi
}

# The cluster default model: SLAUDE_LOCAL_MODEL from the shell, else from the
# dotenv file named by SLAUDE_LOCAL_ENV_FILE (same lookup rules as the provider
# keys: last assignment wins, surrounding quotes stripped). Prints the value, or
# nothing. Reads the environment.
resolve_local_model() {
  local model="${SLAUDE_LOCAL_MODEL:-}"
  if [[ -z "$model" && -n "${SLAUDE_LOCAL_ENV_FILE:-}" ]]; then
    if [[ ! -r "$SLAUDE_LOCAL_ENV_FILE" ]]; then
      die "SLAUDE_LOCAL_ENV_FILE is not readable: $SLAUDE_LOCAL_ENV_FILE"
      return 1
    fi
    model="$(grep -E "^[[:space:]]*(export[[:space:]]+)?SLAUDE_LOCAL_MODEL=" "$SLAUDE_LOCAL_ENV_FILE" | tail -n1 \
      | sed -E "s/^[[:space:]]*(export[[:space:]]+)?SLAUDE_LOCAL_MODEL=//; s/^[\"']//; s/[\"']\$//" || true)"
  fi
  printf '%s' "$model"
}
