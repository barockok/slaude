#!/usr/bin/env bash
# Prove the local topology fails over, by checking real state rather than logs.
#
# Every check reads Kubernetes or Redis directly. Crashes are simulated with a
# SIGKILL through the container runtime: `kubectl delete --force` still delivers
# SIGTERM, which only exercises the graceful path, and a leader that releases
# its lock on the way out says nothing about what happens when a process dies.
#
# Exits non-zero if any check fails. Takes a few minutes: the crash checks have
# to outlive the 30-second leader and heartbeat TTLs.
#
# The topology has node deployments for two labels: slaude-node (`default`, two
# replicas) and slaude-node-finance (`finance`, one). Checks about "the node
# worker" use the default ones; checks that must hold for every node (credential
# placement, the shared volume, heartbeats, what each node is allowed to hold)
# cover both. It also checks the node credentials and the legacy door, and that
# a node handed a gateway-only variable refuses to boot.
set -uo pipefail

PROFILE="${SLAUDE_LOCAL_PROFILE:-slaude-local}"
NS="slaude-scale"
PREFIX="${SLAUDE_REDIS_PREFIX:-slaude}"
LEADER_KEY="$PREFIX:lock:leader:reaper"
PROBE="slaude-ha-probe"
GW_SEL="app.kubernetes.io/name=slaude,app.kubernetes.io/component=gateway"
# The `default` label's nodes, the `finance` label's, and every node pod.
NODE_SEL="app.kubernetes.io/name=slaude,app.kubernetes.io/component=node"
FIN_SEL="app.kubernetes.io/name=slaude,app.kubernetes.io/component=node-finance"
ALL_NODE_SEL="app.kubernetes.io/name=slaude,slaude.dev/tier=node"
TMP="$(mktemp -d)"

pass=0
fail=0
ok() { printf '  PASS  %s\n' "$*"; pass=$((pass + 1)); }
bad() { printf '  FAIL  %s\n' "$*"; fail=$((fail + 1)); }
section() { printf '\n--- %s\n' "$*"; }
# expect <pass message> <fail message> <command...> — runs the command and
# branches on it. Taking the command itself avoids both `test && ok || bad`
# (which also runs bad if ok ever fails) and a `$?` that a later expansion in
# the same line could silently clobber.
expect() {
  local pass_msg="$1" fail_msg="$2"
  shift 2
  if "$@"; then ok "$pass_msg"; else bad "$fail_msg"; fi
}

k() { kubectl --context "$PROFILE" -n "$NS" "$@"; }
redis() { k exec deploy/dev-redis -c redis -- redis-cli "$@" 2>/dev/null | tr -d '\r'; }
ready() { k get deploy "$1" -o jsonpath='{.status.readyReplicas}' 2>/dev/null; }
pods() { k get pod -l "$1" --field-selector=status.phase=Running --request-timeout="${PROBE_TIMEOUT:-60s}" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null; }
http() { k exec "$PROBE" -- curl -s -m 3 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || echo 000; }
# A built shell references hashed assets; an unbuilt one references main.tsx.
lacks_source_entry() { ! grep -q 'main\.tsx' <<<"$1"; }
lacks_text() { ! grep -qF "$1" <<<"$2"; } # <text> <haystack>
heartbeats() { redis --scan --pattern "$PREFIX:nodes:*" | sort; }
# Live heartbeats expected: every ready node of both labels.
nodes_ready() { echo $(($(ready slaude-node || true) + 0 + $(ready slaude-node-finance || true) + 0)); }

# --- bounded, loud probe helpers (same discipline as verify-turns.sh) -------
# Every call is bounded, and a failed measurement yields an EMPTY value that
# expect_value reports as COULD NOT MEASURE — never as a wrong product value.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib.sh"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-60s}"
gateway() { k get pod -l "$GW_SEL" --field-selector=status.phase=Running -o name --request-timeout="$PROBE_TIMEOUT" 2>/dev/null | head -1; }

# Run the in-pod turn probe. On failure: says so on stderr, prints nothing to
# stdout, returns non-zero.
probe() {
  local pod out rc
  pod="$(gateway)"
  if [[ -z "$pod" ]]; then
    printf '  !! probe %s: no running gateway pod to exec into\n' "${1:-?}" >&2
    return 1
  fi
  out="$(k exec --request-timeout="$PROBE_TIMEOUT" "$pod" -- bun /tmp/probe/turns.ts "$@" 2>&1)"
  rc=$?
  if ((rc != 0)); then
    printf '  !! probe %s failed (exit %d) on %s: %s\n' \
      "${1:-?}" "$rc" "${pod#pod/}" "$(printf '%s' "$out" | tail -2 | tr '\n' ' ')" >&2
    return "$rc"
  fi
  printf '%s\n' "$out" | tail -1
}

# One field of the probe's JSON; silent and non-zero on empty/garbled input.
field() {
  python3 -c '
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    sys.exit(3)
try:
    doc = json.loads(raw)
except json.JSONDecodeError:
    sys.exit(3)
if sys.argv[1] not in doc:
    sys.exit(4)
print(doc[sys.argv[1]])
' "$1"
}

# <label> <actual> <want> <context>: an empty actual is "could not measure".
expect_value() {
  local label="$1" actual="$2" want="$3" ctx="$4"
  if [[ -z "$actual" ]]; then
    bad "$label — COULD NOT MEASURE ($ctx); see the !! lines above for why"
  elif [[ "$actual" == "$want" ]]; then
    ok "$label"
  else
    bad "$label — $ctx: got '$actual', want '$want'"
  fi
}

# Whether a path exists on the shared volume, seen from a given pod:
# prints present|absent, or NOTHING (non-zero) when the pod could not be asked.
vol_state() { # <pod> <path>
  # shellcheck disable=SC2016 # expands in the pod's shell, not here
  k exec --request-timeout="$PROBE_TIMEOUT" "$1" -- sh -c \
    'if [ -e "$1" ]; then echo present; else echo absent; fi' _ "$2" 2>/dev/null
}

# Whether a pod's environment holds a variable: present|absent, or NOTHING on
# an exec failure. The VALUE is never read out of the pod.
env_state() { # <pod> <name>
  # shellcheck disable=SC2016 # expands in the pod's shell, not here
  k exec --request-timeout="$PROBE_TIMEOUT" "$1" -- sh -c \
    'if [ -n "$(printenv "$1")" ]; then echo present; else echo absent; fi' _ "$2" 2>/dev/null
}

# Sync the local persona set (personas/local-set.json) plus the verifier persona
# through personas.sh: inside ONE gateway pod it seeds that pod's own soul cache
# (writeSoulCacheEntry, so no model is called) and posts to /deploy there, with
# the bearer read from the pod's environment by NAME. Prints personas.sh's JSON
# line ({status, warnings, souls: {<name>: <soul hash prefix>}}), or nothing.
sync_set() { # <revision> <verifier soul> [personas.sh sync options...]
  local rev="$1" vsoul="$2"
  shift 2
  SLAUDE_LOCAL_PROFILE="$PROFILE" "$HERE/personas.sh" sync --any-status --revision "$rev" \
    --add verifier=UTESTUSER7 --soul "verifier=$vsoul" "$@" 2>/dev/null | tail -1
}
# The soul hash prefix personas.sh reported for one persona: what a node logs.
soul_hash() { # <personas.sh JSON> <persona>
  python3 -c 'import json,sys; print(json.loads(sys.argv[1])["souls"][sys.argv[2]])' "$1" "$2" 2>/dev/null
}

# Wait (bounded) until the probe's tracked turn carries a completion marker.
# Prints the last value read (1 when done), or nothing if never measured.
wait_turn_done() { # <seconds>
  local v="" cur t0
  t0=$(date +%s)
  while (($(date +%s) - t0 < $1)); do
    cur="$(probe status | field withCompletionMarker || true)"
    [[ -n "$cur" ]] && v="$cur"
    [[ "$v" == 1 ]] && break
    sleep 5
  done
  printf '%s' "$v"
}

# Every session-boot soul line for the verifier persona, from the given node pods.
# Non-zero (and silent) if ANY pod's logs could not be read, so a missing pod is
# never mistaken for "no such line".
verifier_soul_lines() { # <node pod...>
  local p out all=""
  (($# > 0)) || return 1
  for p in "$@"; do
    out="$(k logs --request-timeout="$PROBE_TIMEOUT" "$p" 2>/dev/null)" || return 1
    all+="$(grep -F 'persona=verifier soul=' <<<"$out" || true)"$'\n'
  done
  printf '%s' "$all"
}

wait_ready() { # <deployment> <replicas> <timeout-seconds>
  local deadline=$(($(date +%s) + $3))
  while (($(date +%s) < deadline)); do
    [[ "$(ready "$1")" == "$2" ]] && return 0
    sleep 2
  done
  return 1
}

# SIGKILL the app process through the container runtime. Signalling PID 1 from
# inside the container is ignored by the kernel, so it has to come from outside.
crash() { # <pod> <container>
  local id
  id="$(k get pod "$1" -o jsonpath="{.status.containerStatuses[?(@.name==\"$2\")].containerID}")"
  id="${id#*://}"
  [[ -n "$id" ]] || return 1
  minikube -p "$PROFILE" ssh -- docker kill --signal=KILL "$id" >/dev/null
}

cleanup() {
  probe cleanup >/dev/null 2>&1 || true
  k delete pod "$PROBE" --ignore-not-found --wait=false >/dev/null 2>&1
  restore_node_hpa
  rm -rf "$TMP"
}
trap cleanup EXIT

# --- probe pod -------------------------------------------------------------
# Traffic comes from inside the cluster, through the Service, the same path the
# nodes use to reach the gateway.
k delete pod "$PROBE" --ignore-not-found --wait=true >/dev/null 2>&1
k run "$PROBE" --image=curlimages/curl:8.10.1 --restart=Never --command -- sleep 3600 >/dev/null
if ! k wait --for=condition=Ready "pod/$PROBE" --timeout=180s >/dev/null; then
  echo "probe pod never became ready"
  exit 2
fi

# --- 1. baseline -----------------------------------------------------------
section "baseline"
# Pin the node HPA (maxReplicas = minReplicas) for the run, restored by the
# trap: left alone it scales the deployment to three under turn load and holds
# it there for its ten-minute scale-down window, and the checks below say "two".
if pin_node_hpa; then
  wait_ready slaude-node 2 120 || echo "  note  node deployment did not settle at two replicas within 120s"
else
  echo "  note  node HPA not pinned; the node replica checks may see more than two"
fi
expect "two gateway replicas ready" \
  "gateway ready=$(ready slaude-gateway), want 2" \
  [ "$(ready slaude-gateway)" = 2 ]
expect "two node replicas ready" \
  "node ready=$(ready slaude-node), want 2" \
  [ "$(ready slaude-node)" = 2 ]
wait_ready slaude-node-finance 1 120 >/dev/null || true
expect "one finance node replica ready" \
  "finance node ready=$(ready slaude-node-finance), want 1" \
  [ "$(ready slaude-node-finance)" = 1 ]

code="$(http http://slaude-gateway:8080/readyz)"
expect "gateway readiness through the Service (checks Postgres)" \
  "gateway /readyz returned $code" \
  [ "$code" = 200 ]

# The internal API carries decrypted provider credentials; it must refuse a
# caller without the node bearer even from inside the cluster.
code="$(http http://slaude-gateway:8080/v1/tenants/default/runtime)"
expect "internal API refuses an unauthenticated caller" \
  "unauthenticated /v1 returned $code, want 401" \
  [ "$code" = 401 ]

n="$(heartbeats | grep -c . || true)"
want_beats="$(nodes_ready)"
expect "one node heartbeat per ready node registered in Redis ($want_beats)" \
  "node heartbeats=$n, want $want_beats" \
  [ "$n" = "$want_beats" ]

owner0="$(redis GET "$LEADER_KEY")"
expect "exactly one reaper leader elected" \
  "no reaper leader holds $LEADER_KEY" \
  [ -n "$owner0" ]

# A gateway refuses to boot on embedded storage, so the brain must be on the
# Postgres server. Prove it from the database itself: gbrain's tables exist in
# the separate brain database. Polled, because gateways bootstrap the brain in
# the background after they report ready.
brain_tables=""
deadline=$(($(date +%s) + 90))
while (($(date +%s) < deadline)); do
  brain_tables="$(k exec deploy/dev-postgres -c postgres -- psql -U slaude -d slaude_brain -tAc \
    "select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('pages', 'gbrain_cycle_locks')" \
    2>/dev/null | tr -d '[:space:]')"
  [[ "$brain_tables" == 2 ]] && break
  sleep 3
done
expect "the brain runs on the Postgres server, in its own database" \
  "brain tables found in slaude_brain: ${brain_tables:-none}, want 2" \
  [ "$brain_tables" = 2 ]


# --- credential placement --------------------------------------------------
# Phase 3: MCP credentials live in the gateway's store; a node holds only a
# pod-local working copy per session. A credentials file on the shared volume
# is the hazard the design removes (the agent's rename-over-path write silently
# un-shares it), so none may be written there. `-newer /proc/1` scopes the
# check to this pod's lifetime: files from before an upgrade are left in place
# on purpose by the import, for rollback, and must not trip it.
section "credential placement"
for pod in $(pods "$ALL_NODE_SEL"); do
  # shellcheck disable=SC2016  # expands inside the node pod, not here
  root="$(k exec "$pod" -- sh -c 'printf %s "$SLAUDE_NODE_CONFIG_ROOT"' 2>/dev/null | tr -d '\r')"
  expect "$pod keeps session config homes pod-local" \
    "$pod SLAUDE_NODE_CONFIG_ROOT='$root', want /config-home" \
    [ "$root" = /config-home ]
  # shellcheck disable=SC2016  # expands inside the node pod, not here
  writable="$(k exec "$pod" -- sh -c 't=/config-home/.verify-probe; touch "$t" && rm -f "$t" && echo yes' 2>/dev/null | tr -d '\r')"
  expect "$pod can write its pod-local root" \
    "$pod cannot write /config-home (volume missing or read-only)" \
    [ "$writable" = yes ]
  onvol="$(k exec "$pod" -- sh -c 'find /data -name .credentials.json -newer /proc/1 2>/dev/null | head -1' | tr -d '\r')"
  expect "no credentials file written to the shared volume since $pod started" \
    "credentials written to the shared volume: $onvol" \
    [ -z "$onvol" ]
done
imports="$(k logs deploy/slaude-gateway --tail=-1 2>/dev/null | grep -c '\[credential-import\] imported=' || true)"
expect "the gateway imported on-disk credentials at boot" \
  "no [credential-import] line in the gateway log" \
  [ "${imports:-0}" -ge 1 ]

# --- 2. shared volume ------------------------------------------------------
section "shared \$SLAUDE_HOME across every pod"
token="ha-$(date +%s)-$RANDOM"
read -r -a gws <<<"$(pods "$GW_SEL")"
read -r -a nodes <<<"$(pods "$ALL_NODE_SEL")"
k exec "${gws[0]}" -c gateway -- sh -c "echo $token > /data/.ha-probe" >/dev/null
seen=0
for p in "${gws[@]}"; do
  [[ "$(k exec "$p" -c gateway -- cat /data/.ha-probe 2>/dev/null | tr -d '\r')" == "$token" ]] && seen=$((seen + 1))
done
for p in "${nodes[@]}"; do
  [[ "$(k exec "$p" -c node -- cat /data/.ha-probe 2>/dev/null | tr -d '\r')" == "$token" ]] && seen=$((seen + 1))
done
want=$((${#gws[@]} + ${#nodes[@]}))
expect "a write on one gateway is visible on all $want app pods" \
  "write visible on $seen of $want app pods" \
  [ "$seen" = "$want" ]
k exec "${gws[0]}" -c gateway -- rm -f /data/.ha-probe >/dev/null 2>&1

# --- 3. gateway loss under traffic -----------------------------------------
section "gateway pod deleted while serving traffic"
# 30 seconds of requests at five per second, recorded inside the probe pod.
# shellcheck disable=SC2016  # expands inside the probe pod, not here
k exec "$PROBE" -- sh -c \
  'for i in $(seq 1 150); do curl -s -m 1 -o /dev/null -w "%{http_code}\n" http://slaude-gateway:8080/healthz; sleep 0.2; done' \
  >"$TMP/traffic" 2>/dev/null &
load=$!
sleep 4
k delete pod "${gws[0]}" --wait=false >/dev/null
wait "$load"

total="$(grep -c . "$TMP/traffic" || true)"
failed="$(grep -vc '^200$' "$TMP/traffic" || true)"
longest="$(awk '$1 != "200" { run++; if (run > max) max = run; next } { run = 0 } END { print max + 0 }' "$TMP/traffic")"
# Five consecutive misses at 200ms spacing is one second of unavailability.
if ((longest <= 5)); then
  ok "service stayed up: $failed of $total requests failed, longest outage ${longest} requests"
else
  bad "service went down: $failed of $total requests failed, longest outage ${longest} requests (~$((longest / 5))s)"
fi
expect "gateway replica replaced" \
  "gateway did not return to 2 ready replicas" \
  wait_ready slaude-gateway 2 180

# --- 4. reaper leader crash ------------------------------------------------
section "reaper leader killed without a chance to release its lock"
wait_ready slaude-gateway 2 180 >/dev/null
owner0="$(redis GET "$LEADER_KEY")"
moved=""
read -r -a gws <<<"$(pods "$GW_SEL")"
for p in "${gws[@]}"; do
  crash "$p" gateway || { bad "could not SIGKILL $p"; continue; }
  t0="$(date +%s)"
  # Leadership must move within the lock TTL plus one renewal tick.
  while (($(date +%s) - t0 < 60)); do
    cur="$(redis GET "$LEADER_KEY")"
    if [[ -n "$cur" && "$cur" != "$owner0" ]]; then
      moved=$(($(date +%s) - t0))
      break 2
    fi
    sleep 2
  done
  # Unchanged after 60s means that pod was not the leader. Try the next.
  wait_ready slaude-gateway 2 180 >/dev/null
done
if [[ -n "$moved" ]]; then
  ok "a new reaper leader took over ${moved}s after the old one died (lock TTL is 30s)"
else
  bad "reaper leadership never moved after killing every gateway process"
fi
expect "gateways recovered after the crash" \
  "gateways did not recover" \
  wait_ready slaude-gateway 2 180

# --- 5. node crash ---------------------------------------------------------
section "node worker killed mid-life"
wait_ready slaude-node 2 180 >/dev/null
read -r -a nodes <<<"$(pods "$NODE_SEL")"
victim="${nodes[0]}"
dead="$(heartbeats | grep "$PREFIX:nodes:$victim-" | head -n1)"
if [[ -z "$dead" ]]; then
  bad "no heartbeat found for $victim before the crash"
else
  crash "$victim" node || bad "could not SIGKILL $victim"
  t0="$(date +%s)"
  gone=""
  while (($(date +%s) - t0 < 75)); do
    if ! heartbeats | grep -qxF "$dead"; then gone=$(($(date +%s) - t0)); break; fi
    sleep 3
  done
  expect "dead node's heartbeat expired ${gone}s after the crash (TTL 30s)" \
    "dead node's heartbeat still present after 75s" \
    [ -n "$gone" ]

  expect "node worker restarted" \
    "node did not return to 2 ready replicas" \
    wait_ready slaude-node 2 180

  t0="$(date +%s)"
  settled=""
  while (($(date +%s) - t0 < 60)); do
    [[ "$(heartbeats | grep -c . || true)" == "$(nodes_ready)" ]] && { settled=1; break; }
    sleep 3
  done
  expect "back to one live heartbeat per ready node, with a fresh id for the restarted worker" \
    "heartbeat count did not settle at $(nodes_ready)" \
    [ -n "$settled" ]

  # The reaper leader prunes dead ids from the registry on its next pass.
  dead_id="${dead#"$PREFIX:nodes:"}"
  t0="$(date +%s)"
  reaped=""
  while (($(date +%s) - t0 < 90)); do
    if [[ "$(redis SISMEMBER "$PREFIX:nodeset" "$dead_id")" == 0 ]]; then reaped=$(($(date +%s) - t0)); break; fi
    sleep 5
  done
  expect "reaper removed the dead node from the registry within ${reaped}s" \
    "dead node still in $PREFIX:nodeset after 90s" \
    [ -n "$reaped" ]
fi

# --- node credentials and the legacy door -----------------------------------
# Each node presents its own credential (whoami, as that node). A signed one
# carries exactly its deployment's label; the legacy token is `default` only.
# The legacy door is whatever this cluster was brought up with
# (SLAUDE_LOCAL_LEGACY_DOOR: SLAUDE_NODE_LEGACY=off on the gateways when closed),
# and is checked from a gateway with its own SLAUDE_NODE_LEGACY_TOKEN.
section "node credentials and the legacy door"
# Run the node-side probe in a node pod (copied in first). Prints its JSON, or
# nothing (and says why on stderr).
node_probe() { # <pod> <args...>
  local pod="$1" out rc
  shift
  if ! k exec -i --request-timeout="$PROBE_TIMEOUT" "$pod" -- sh -c 'mkdir -p /tmp/probe && cat > /tmp/probe/node.ts' \
    <"$HERE/probe/node.ts" >/dev/null 2>&1; then
    printf '  !! could not copy probe/node.ts into %s\n' "$pod" >&2
    return 1
  fi
  out="$(k exec --request-timeout="$PROBE_TIMEOUT" "$pod" -- bun /tmp/probe/node.ts "$@" 2>&1 </dev/null)"
  rc=$?
  if ((rc != 0)); then
    printf '  !! node probe %s failed (exit %d) on %s: %s\n' "${1:-?}" "$rc" "$pod" "$(printf '%s' "$out" | tail -2 | tr '\n' ' ')" >&2
    return "$rc"
  fi
  printf '%s\n' "$out" | tail -1
}
door="$(k get configmap slaude-scale-gateway-config -o jsonpath='{.data.SLAUDE_NODE_LEGACY}' 2>/dev/null)"
door_state=open
[[ "$(tr '[:upper:]' '[:lower:]' <<<"$door")" == off ]] && door_state=closed
echo "  note  legacy door: $door_state"
gw_pod="$(gateway)"
if [[ -z "$gw_pod" ]]; then
  bad "legacy door — COULD NOT MEASURE (no running gateway pod)"
elif ! k exec -i --request-timeout="$PROBE_TIMEOUT" "${gw_pod#pod/}" -- sh -c 'mkdir -p /tmp/probe && cat > /tmp/probe/turns.ts' <"$HERE/probe/turns.ts"; then
  bad "legacy door — COULD NOT MEASURE (could not install the probe)"
else
  lw="$(probe legacy-whoami || true)"
  if [[ "$door_state" == closed ]]; then
    expect_value "the legacy door is closed: the legacy token is refused (401)" "$(field status <<<"$lw" || true)" "401" "whoami status with the legacy token"
  else
    expect_value "the legacy door is open: the legacy token is accepted as default" "$(field status <<<"$lw" || true)" "200" "whoami status with the legacy token"
    expect_value "the legacy identity is marked legacy" "$(field legacy <<<"$lw" || true)" "True" "whoami legacy flag"
  fi
fi
for sel_label in "$NODE_SEL default" "$FIN_SEL finance"; do
  sel="${sel_label% *}"
  label="${sel_label##* }"
  for pod in $(pods "$sel"); do
    w="$(node_probe "$pod" whoami || true)"
    expect_value "$pod is admitted by the gateway (whoami)" "$(field status <<<"$w" || true)" "200" "whoami status"
    expect_value "$pod's credential carries exactly label $label" "$(field labels <<<"$w" || true)" "['$label']" "credential labels"
    if [[ "$door_state" == closed ]]; then
      expect_value "$pod uses a signed credential (the door is closed)" "$(field legacy <<<"$w" || true)" "False" "legacy flag"
    else
      echo "  note  $pod credential: $(field legacy <<<"$w" 2>/dev/null | sed 's/True/legacy token/; s/False/signed/')"
    fi
  done
done

# --- a node handed a gateway-only variable refuses to boot -------------------
# The node entry runs in a node pod with a clean environment plus one fake
# gateway-only variable, and the pod's own SLAUDE_NODE_BOOT_CHECK. It must stop
# at the boot check, naming the variable and never its value. It has no node
# credential, so even a check that let it through could not join the cluster
# (it would stop at "SLAUDE_NODE_TOKEN is not set" instead, which fails here).
section "a node holding a gateway-only variable refuses to boot"
boot_pod="$(pods "$NODE_SEL" | awk '{print $1}')"
if [[ -z "$boot_pod" ]]; then
  bad "boot refusal — COULD NOT MEASURE (no running default node)"
else
  fake="verify-fake-$RANDOM$RANDOM"
  # shellcheck disable=SC2016 # expands inside the node pod
  boot_out="$(k exec --request-timeout="$PROBE_TIMEOUT" "$boot_pod" -- sh -c \
    'mode="$SLAUDE_NODE_BOOT_CHECK"; cd /app && env -i PATH="$PATH" HOME=/tmp SLAUDE_HOME=/tmp/verify-boot SLAUDE_ROLE=node \
       SLAUDE_NODE_BOOT_CHECK="$mode" SLAUDE_JOB_SECRET="$1" bun src/node/main.ts; echo "exit=$?"' _ "$fake" 2>&1 </dev/null)"
  boot_rc="$(sed -n 's/^exit=\([0-9]*\)$/\1/p' <<<"$boot_out" | tail -1)"
  if [[ -z "$boot_rc" ]]; then
    bad "the node entry's exit status — COULD NOT MEASURE (the exec failed): $(tail -2 <<<"$boot_out" | tr '\n' ' ' | cut -c1-200)"
  else
    expect "the node entry exited non-zero (exit $boot_rc)" "the node entry exited 0" [ "$boot_rc" != 0 ]
  fi
  expect "it refused at the boot check, naming SLAUDE_JOB_SECRET" \
    "no boot-check refusal in its output: $(tail -3 <<<"$boot_out" | tr '\n' ' ' | cut -c1-300)" \
    grep -q "refusing to boot: gateway-only variables are set in this node's environment: SLAUDE_JOB_SECRET" <<<"$boot_out"
  expect "it never printed the variable's value" "the value appeared in the output" \
    lacks_text "$fake" "$boot_out"
fi

# --- the web apps are actually in the image --------------------------------
#
# This is how the defect was found and the only way to see it: the apps build
# fine locally and dist/ is gitignored, so an image that never built them ships
# only Vite's SOURCE tree. The static server then falls back to it and serves
# HTML referencing /src/main.tsx, which a browser cannot run. Nothing in the unit
# suite can observe that, because nothing in the unit suite runs from the image.
#
# Checked against the image's own files rather than over HTTP, so it holds
# whether or not this overlay enables the panel and the portal.
section "web apps built into the image"

gw_pod="$(pods "$GW_SEL" | awk '{print $1}')"
for app in panel portal; do
  shell="$(k exec "$gw_pod" -- cat "src/gateway/$app/web/dist/index.html" 2>/dev/null || true)"
  expect "/$app has a built shell in the image" \
    "src/gateway/$app/web/dist/index.html is missing — the image never built it" \
    [ -n "$shell" ]
  [[ -n "$shell" ]] || continue
  expect "/$app shell references hashed assets" \
    "/$app shell references no built asset" \
    grep -qE "/$app/assets/[A-Za-z0-9_.-]+\\.(js|css)" <<<"$shell"
  expect "/$app shell references no Vite source entry" \
    "/$app shell still references a .tsx source entry" \
    lacks_source_entry "$shell"
done

# --- personas as code: a node needs no persona directory -------------------
#
# The claim: a node takes a persona's soul from the gateway's runtime bundle, not
# from the shared volume. "The turn completed" proves nothing on its own — a
# suppressed turn never calls the model, and a node that read the disk and fell
# back to the DEFAULT soul would complete it too. So the proof is the soul's
# hash: every session boot logs `persona=<name> soul=<first 12 hex of
# sha256(soulMd)>`. The expected hash is computed here from the exact text synced,
# a text distinctive to this run, and a node log must carry it.
#
# Sync extracts structured soul data with a model, and this check must not need
# one, so each soul's extraction cache entry is seeded first, written inside the
# gateway pod by writeSoulCacheEntry in src/soul/extract.ts: the same writer
# extraction uses, so the entry lands in the pod-local SLAUDE_SOUL_CACHE_DIR and
# carries the MAC derived from the pod's master key. The sync then finds it and
# calls no model; production code is untouched. personas.sh does both, in one pod.
#
# The section leaves the local persona set plus `verifier` synced. Every persona
# carries a Vault provider reference (the nodes run with the fallback off), so
# Vault must be seeded (up.sh does it; vault.sh seed redoes it).
section "personas as code"

gw_pod="$(gateway)"
gw_pod="${gw_pod#pod/}"
# shellcheck disable=SC2207 # pod names contain no whitespace
node_pods=($(pods "$ALL_NODE_SEL"))

if ! wait_ready slaude-gateway 2 180; then
  bad "gateway rollout did not reach 2 ready replicas — COULD NOT MEASURE personas as code"
elif ! wait_ready slaude-node 2 180; then
  bad "node rollout did not reach 2 ready replicas — COULD NOT MEASURE personas as code"
elif [[ -z "$gw_pod" ]]; then
  bad "personas as code — COULD NOT MEASURE (no running gateway pod)"
elif ((${#node_pods[@]} == 0)); then
  bad "personas as code — COULD NOT MEASURE (no running node pods)"
else
  k exec -i --request-timeout="$PROBE_TIMEOUT" "$gw_pod" -- sh -c 'mkdir -p /tmp/probe && cat > /tmp/probe/turns.ts' <"$HERE/probe/turns.ts" \
    || printf '  !! could not install the probe into %s\n' "$gw_pod" >&2

  # The deploy token reaches gateways and never nodes.
  expect_value "the gateway holds the deploy token" \
    "$(env_state "$gw_pod" SLAUDE_DEPLOY_TOKEN)" "present" "gateway env"
  for np in "${node_pods[@]}"; do
    expect_value "node $np does not hold the deploy token" \
      "$(env_state "$np" SLAUDE_DEPLOY_TOKEN)" "absent" "node env"
  done

  # Distinctive per run, so its hash cannot coincide with the default soul's and
  # no line from an earlier run can satisfy the check.
  soul="Verifier soul for the personas-as-code check, run $(date +%s)-$RANDOM."
  # TWO different hashes, deliberately. want_hash is the 12-hex prefix of the full
  # sha256 that manager.ts LOGS at session boot (the R4 grep below), of the soul
  # text exactly as synced (personas.sh reports it: SLAUDE_LOCAL_MANAGER adds a
  # line). The extraction cache key is a separate 16-hex derivation owned by
  # src/soul/extract.ts, computed in the pod through writeSoulCacheEntry.
  r1="$(sync_set verify-1 "$soul")"
  # The deploy token syncs; the node token must not.
  expect_value "the pipeline sync was accepted" "$(field status <<<"$r1" || true)" "200" "sync HTTP status"
  want_hash="$(soul_hash "$r1" verifier || true)"
  [[ -n "$want_hash" ]] || want_hash="$(printf '%s' "$soul" | shasum -a 256 | cut -c1-12)"
  expect_value "the node token cannot sync" \
    "$(sync_set verify-1n "$soul" --no-seed --token-var SLAUDE_NODE_LEGACY_TOKEN | field status || true)" "401" \
    "sync HTTP status with the node token"

  # Remove the persona's directory from the shared volume before the turn.
  if k exec --request-timeout="$PROBE_TIMEOUT" "$gw_pod" -- rm -rf /data/personas/verifier 2>/dev/null; then
    ok "removed /data/personas/verifier from the shared volume"
  else
    bad "could not remove /data/personas/verifier — COULD NOT MEASURE what follows"
  fi

  probe cleanup >/dev/null 2>&1 || true
  enq_out="$(probe enqueue 1 --persona verifier || true)"
  enq="$(field enqueued <<<"$enq_out" || true)"
  sess="$(field session <<<"$enq_out" || true)"
  expect_value "enqueued a turn for the persona" "$enq" "1" "enqueued"

  done_v="$(wait_turn_done 120)"
  expect_value "a node completed the persona's turn" "$done_v" "1" "turns completed"

  # THE proof of where the soul came from: the booting node logged the hash of
  # the synced text. A node that read the disk or fell back to the default soul
  # logs a different hash (or none for this persona) and fails here.
  seen=""
  t0=$(date +%s)
  while (($(date +%s) - t0 < 30)); do
    if lines="$(verifier_soul_lines "${node_pods[@]}")"; then
      if grep -qF "persona=verifier soul=$want_hash" <<<"$lines"; then seen=yes; else seen=no; fi
      [[ "$seen" == yes ]] && break
    fi
    sleep 3
  done
  expect_value "a node booted persona=verifier with the synced soul (soul=$want_hash)" \
    "$seen" "yes" "node boot log; other verifier boot hashes seen: $(grep -o 'soul=[0-9a-f]*' <<<"${lines:-}" | sort -u | tr '\n' ' ')"

  # The old code's inputs are absent. The persona's .claude home may exist now —
  # a node creates it for transcripts — so only the soul/config files are asserted.
  for f in SOUL.md config.json; do
    expect_value "/data/personas/verifier/$f is not on the volume" \
      "$(vol_state "$gw_pod" "/data/personas/verifier/$f")" "absent" "volume state"
  done

  # A WARM node session picks up a changed soul (spec §6.4). The turn above
  # left the verifier's session warm on a node. Sync soul B, then run a second
  # turn in the SAME session: its boot must log B's hash for that session. This
  # rests on the deferred reload seeing outstanding inputs reach zero, which
  # depends on the real CLI's result cadence (unit tests use a fake SDK). Each
  # step runs only after the previous one finished; a step that cannot run
  # makes the rest COULD NOT MEASURE, never a pass. The second turn can land on
  # the other node, where it boots cold: B is still required, so a node that
  # kept serving soul A fails, but a cold boot proves less than a warm one.
  soul_b="Verifier soul B for the warm-session check, run $(date +%s)-$RANDOM."
  if [[ "$done_v" != 1 || -z "$sess" ]]; then
    bad "warm session soul change — COULD NOT MEASURE (the first turn did not complete, or its session id is unknown)"
  else
    # committedAt must not go backwards; a second's gap keeps it strictly newer.
    sleep 1
    r2="$(sync_set verify-2 "$soul_b")"
    synced_b="$(field status <<<"$r2" || true)"
    want_b="$(soul_hash "$r2" verifier || true)"
    [[ -n "$want_b" ]] || want_b="$(printf '%s' "$soul_b" | shasum -a 256 | cut -c1-12)"
    expect_value "the sync to soul B was accepted" "$synced_b" "200" "sync HTTP status"
    if [[ "$synced_b" == 200 ]]; then
      enq2="$(probe again 1 --persona verifier | field enqueued || true)"
      expect_value "enqueued a second turn in the same session" "$enq2" "1" "enqueued"
      done2="$(wait_turn_done 120)"
      expect_value "a node completed the second turn" "$done2" "1" "turns completed"
      seen_b=""
      t0=$(date +%s)
      while [[ "$done2" == 1 ]] && (($(date +%s) - t0 < 30)); do
        if lines="$(verifier_soul_lines "${node_pods[@]}")"; then
          if grep -qF "session=$sess persona=verifier soul=$want_b" <<<"$lines"; then seen_b=yes; else seen_b=no; fi
          [[ "$seen_b" == yes ]] && break
        fi
        sleep 3
      done
      expect_value "the same session rebooted with soul B (session=$sess soul=$want_b)" \
        "$seen_b" "yes" "node boot log; hashes seen for this session: $(grep -F "session=$sess " <<<"${lines:-}" | grep -o 'soul=[0-9a-f]*' | sort -u | tr '\n' ' ')"
    fi
  fi
fi

# --- summary ---------------------------------------------------------------
section "result"
echo "  $pass passed, $fail failed"
((fail == 0))
