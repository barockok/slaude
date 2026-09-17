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
set -uo pipefail

PROFILE="${SLAUDE_LOCAL_PROFILE:-slaude-local}"
NS="slaude-scale"
PREFIX="${SLAUDE_REDIS_PREFIX:-slaude}"
LEADER_KEY="$PREFIX:lock:leader:reaper"
PROBE="slaude-ha-probe"
GW_SEL="app.kubernetes.io/name=slaude,app.kubernetes.io/component=gateway"
NODE_SEL="app.kubernetes.io/name=slaude,app.kubernetes.io/component=node"
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
pods() { k get pod -l "$1" --field-selector=status.phase=Running -o jsonpath='{.items[*].metadata.name}' 2>/dev/null; }
http() { k exec "$PROBE" -- curl -s -m 3 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || echo 000; }
heartbeats() { redis --scan --pattern "$PREFIX:nodes:*" | sort; }

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
  k delete pod "$PROBE" --ignore-not-found --wait=false >/dev/null 2>&1
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
expect "two gateway replicas ready" \
  "gateway ready=$(ready slaude-gateway), want 2" \
  [ "$(ready slaude-gateway)" = 2 ]
expect "two node replicas ready" \
  "node ready=$(ready slaude-node), want 2" \
  [ "$(ready slaude-node)" = 2 ]

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
expect "two node heartbeats registered in Redis" \
  "node heartbeats=$n, want 2" \
  [ "$n" = 2 ]

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

# --- 2. shared volume ------------------------------------------------------
section "shared \$SLAUDE_HOME across every pod"
token="ha-$(date +%s)-$RANDOM"
read -r -a gws <<<"$(pods "$GW_SEL")"
read -r -a nodes <<<"$(pods "$NODE_SEL")"
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
    [[ "$(heartbeats | grep -c . || true)" == 2 ]] && { settled=1; break; }
    sleep 3
  done
  expect "back to two live heartbeats, with a fresh id for the restarted worker" \
    "heartbeat count did not settle at 2" \
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

# --- summary ---------------------------------------------------------------
section "result"
echo "  $pass passed, $fail failed"
((fail == 0))
