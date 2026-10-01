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
pods() { k get pod -l "$1" --field-selector=status.phase=Running --request-timeout="${PROBE_TIMEOUT:-60s}" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null; }
http() { k exec "$PROBE" -- curl -s -m 3 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || echo 000; }
# A built shell references hashed assets; an unbuilt one references main.tsx.
lacks_source_entry() { ! grep -q 'main\.tsx' <<<"$1"; }
heartbeats() { redis --scan --pattern "$PREFIX:nodes:*" | sort; }

# --- bounded, loud probe helpers (same discipline as verify-turns.sh) -------
# Every call is bounded, and a failed measurement yields an EMPTY value that
# expect_value reports as COULD NOT MEASURE — never as a wrong product value.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# POST the persona set to /deploy from INSIDE a gateway pod, authenticating with
# the token variable (by NAME) from that pod's own environment. The token value
# is never read by this script, never on a command line, never in output; only
# the HTTP status is printed. Prints "unset" when the pod lacks the variable.
sync_status() { # <pod> <token-env-var-name> <json-payload>
  printf '%s' "$3" | k exec -i --request-timeout="$PROBE_TIMEOUT" "$1" -- bun -e "
    const tok = process.env.$2;
    if (!tok) { console.log('unset'); process.exit(0); }
    const r = await fetch('http://localhost:8080/deploy/v1/tenants/default/personas', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
      body: await Bun.stdin.text(),
    });
    console.log(r.status);
  " 2>/dev/null | tail -1
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


# --- credential placement --------------------------------------------------
# Phase 3: MCP credentials live in the gateway's store; a node holds only a
# pod-local working copy per session. A credentials file on the shared volume
# is the hazard the design removes (the agent's rename-over-path write silently
# un-shares it), so none may be written there. `-newer /proc/1` scopes the
# check to this pod's lifetime: files from before an upgrade are left in place
# on purpose by the import, for rollback, and must not trip it.
section "credential placement"
for pod in $(pods app.kubernetes.io/component=node); do
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
# Sync extracts structured soul data with a model, and this overlay has no
# provider credentials, so each soul's extraction cache entry is seeded first
# (src/soul/extract.ts: $SLAUDE_HOME/cache/soul.<full sha256>.json). The sync
# then finds it and calls no model; production code is untouched.
#
# The section leaves a synced persona set (default + verifier) on the local
# cluster. Syncing a full set tombstones any other persona previously synced.
section "personas as code"

gw_pod="$(gateway)"
gw_pod="${gw_pod#pod/}"
# shellcheck disable=SC2207 # pod names contain no whitespace
node_pods=($(pods "$NODE_SEL"))

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
  want_full="$(printf '%s' "$soul" | shasum -a 256 | cut -d' ' -f1)"
  want_hash="${want_full:0:12}"
  default_soul="Default verify soul."
  default_full="$(printf '%s' "$default_soul" | shasum -a 256 | cut -d' ' -f1)"
  seed_ok=1
  for sha in "$want_full" "$default_full"; do
    # shellcheck disable=SC2016 # expands in the pod's shell, not here
    printf '{"approvers":[]}' | k exec -i --request-timeout="$PROBE_TIMEOUT" "$gw_pod" -- sh -c \
      'mkdir -p "${SLAUDE_HOME:-/data}/cache" && cat > "${SLAUDE_HOME:-/data}/cache/soul.$1.json"' _ "$sha" 2>/dev/null \
      || { seed_ok=""; printf '  !! could not seed the soul extraction cache for %s\n' "${sha:0:12}" >&2; }
  done
  [[ -n "$seed_ok" ]] || bad "soul extraction cache not seeded — the sync below would need a model"
  payload="$(python3 -c '
import json, sys, datetime
print(json.dumps({
    "revision": "verify-1",
    "committedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "personas": [
        {"name": "default", "soul": sys.argv[2]},
        {"name": "verifier", "slackUserId": "UTESTUSER7", "soul": sys.argv[1]},
    ],
}))' "$soul" "$default_soul")"

  # The deploy token syncs; the node token must not.
  expect_value "the pipeline sync was accepted" \
    "$(sync_status "$gw_pod" SLAUDE_DEPLOY_TOKEN "$payload")" "200" "sync HTTP status"
  expect_value "the node token cannot sync" \
    "$(sync_status "$gw_pod" SLAUDE_NODE_TOKEN "$payload")" "401" "sync HTTP status with the node token"

  # Remove the persona's directory from the shared volume before the turn.
  if k exec --request-timeout="$PROBE_TIMEOUT" "$gw_pod" -- rm -rf /data/personas/verifier 2>/dev/null; then
    ok "removed /data/personas/verifier from the shared volume"
  else
    bad "could not remove /data/personas/verifier — COULD NOT MEASURE what follows"
  fi

  probe cleanup >/dev/null 2>&1 || true
  enq="$(probe enqueue 1 --persona verifier | field enqueued || true)"
  expect_value "enqueued a turn for the persona" "$enq" "1" "enqueued"

  done_v=""
  t0=$(date +%s)
  while (($(date +%s) - t0 < 120)); do
    cur="$(probe status | field withCompletionMarker || true)"
    [[ -n "$cur" ]] && done_v="$cur"
    [[ "$done_v" == 1 ]] && break
    sleep 5
  done
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
fi

# --- summary ---------------------------------------------------------------
section "result"
echo "  $pass passed, $fail failed"
((fail == 0))
