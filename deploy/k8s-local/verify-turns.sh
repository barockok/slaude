#!/usr/bin/env bash
# Turn-level failover on the local scale cluster.
#
# verify-ha.sh proves the INFRASTRUCTURE survives: replicas, heartbeats, leader
# election, the reaper, the shared volume, credential placement. It never drives
# a turn, because Slack cannot reach a laptop — so nothing there proved the claim
# the deploy docs make, that a turn survives losing the node running it.
#
# This drives turns through the real queue from inside a gateway pod, kills a node
# mid-flight, and asserts every turn still completes exactly once. Then it fires
# one cron occurrence and asserts the two gateways dispatch it once between them.
#
# Recovery is not instant: a killed node never releases its session lock, so the
# turn it held waits for that lock's TTL (10 minutes by default) before another
# node can run it. Nothing is lost or duplicated — it is a latency bound, and
# the run reports how long it actually took.
#
# The probe's turns are suppressed, so the full lifecycle runs (claim, session
# lock, completion marker, ack) without a model call. Costs no provider tokens.
set -uo pipefail

PROFILE="${MINIKUBE_PROFILE:-slaude-local}"
NS="${NAMESPACE:-slaude-scale}"
TURNS="${TURNS:-6}"
# A killed node cannot release its session lock, so the turn it was running is
# blocked until that lock's TTL expires. The local overlay sets a short TTL
# (SLAUDE_SESSION_LOCK_TTL_MS) so this is quick; production's default is 10
# minutes. The turn is never lost or duplicated either way — it waits.
RECOVER_TIMEOUT="${RECOVER_TIMEOUT:-240}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass=0
fail=0
ok() { printf '  PASS  %s\n' "$*"; pass=$((pass + 1)); }
bad() { printf '  FAIL  %s\n' "$*"; fail=$((fail + 1)); }
section() { printf '\n--- %s\n' "$*"; }
expect() { # <label> <failure-detail> <test...>
  local label="$1" detail="$2"; shift 2
  if "$@"; then ok "$label"; else bad "$label — $detail"; fi
}

k() { kubectl --context "$PROFILE" -n "$NS" "$@"; }
gateway() { k get pod -l app.kubernetes.io/component=gateway --field-selector=status.phase=Running -o name --request-timeout="$PROBE_TIMEOUT" 2>/dev/null | head -1; }
nodes() { k get pod -l app.kubernetes.io/component=node --field-selector=status.phase=Running -o name; }

# Every call into the cluster is bounded. An unbounded `kubectl exec` hangs
# forever when the apiserver stops answering mid-run — observed stalling this
# script for 34 minutes inside `probe cron`, with no output to say why.
PROBE_TIMEOUT="${PROBE_TIMEOUT:-60s}"

# Run the in-pod probe.
#
# On any failure this says so on stderr and returns non-zero, printing NOTHING
# to stdout. That distinction is the point: `field` used to turn both a failed
# exec and a genuine zero into an empty string, so an unreachable pod was
# reported as "only  of 6 turns completed" — infrastructure trouble wearing a
# product failure's clothes, which is worse than no result at all.
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

# Pull one field out of the probe's JSON. Silent and non-zero when the input is
# empty, unparseable, or lacks the key, so a failed probe cannot be read as a
# number by the caller.
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

# Sum one or more counters out of the probe's `shared` queue snapshot. Silent
# and non-zero on unparseable input, for the same reason as `field`.
queue_sum() { # <counter...>
  python3 -c '
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    sys.exit(3)
try:
    q = json.loads(raw)["shared"]
except (json.JSONDecodeError, KeyError, TypeError):
    sys.exit(3)
print(sum(int(q.get(k, 0)) for k in sys.argv[1:]))
' "$@"
}

# Assert on a value the probe measured. An empty actual means no measurement was
# ever obtained, which is reported as such: "could not measure" and "measured
# the wrong number" have different causes and different fixes, and conflating
# them is what made three of this script's past failures misleading.
expect_value() { # <label> <actual> <want> <context>
  local label="$1" actual="$2" want="$3" ctx="$4"
  if [[ -z "$actual" ]]; then
    bad "$label — COULD NOT MEASURE ($ctx); see the !! lines above for why the probe failed"
  elif [[ "$actual" == "$want" ]]; then
    ok "$label"
  else
    bad "$label — $ctx: got '$actual', want '$want'"
  fi
}

# Kill a node's container outright — no SIGTERM, no drain — the way verify-ha
# simulates a lost worker.
crash_node() { # <pod>
  local pod="${1#pod/}" id
  id="$(k get pod "$pod" -o jsonpath='{.status.containerStatuses[0].containerID}' | sed 's|.*/||')"
  [[ -n "$id" ]] || return 1
  minikube -p "$PROFILE" ssh -- docker kill --signal=KILL "$id" >/dev/null 2>&1
}

cleanup() {
  probe cleanup >/dev/null 2>&1 || true
  k exec "$(gateway)" -- rm -rf /tmp/probe /tmp/verify-turns-ids.json >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- preconditions ---------------------------------------------------------
section "preconditions"
gw_ready="$(k get deploy slaude-gateway -o jsonpath='{.status.readyReplicas}' 2>/dev/null)"
node_ready="$(k get deploy slaude-node -o jsonpath='{.status.readyReplicas}' 2>/dev/null)"
# At least two of each: the HPA may have scaled nodes up under an earlier run,
# and every assertion below holds with more than two.
expect "at least two gateway replicas ready" "gateway ready=$gw_ready, want >= 2" [ "${gw_ready:-0}" -ge 2 ]
expect "at least two node replicas ready" "node ready=$node_ready, want >= 2" [ "${node_ready:-0}" -ge 2 ]
if ((fail > 0)); then
  echo "cluster is not at two gateways and two nodes; run up.sh first"
  exit 2
fi

k exec -i "$(gateway)" -- sh -c 'mkdir -p /tmp/probe && cat > /tmp/probe/turns.ts' < "$HERE/probe/turns.ts"

# --- turn delivery survives losing a node ----------------------------------
section "turn delivery while a node dies"
probe cleanup >/dev/null 2>&1 || true
enq="$(probe enqueue "$TURNS" | field enqueued || true)"
expect_value "enqueued $TURNS turns through the real queue" "$enq" "$TURNS" "enqueued"

# Kill as soon as a node has claimed work, so the kill lands while turns are
# still moving. A suppressed turn is quick, so this is a race by nature: the
# count at kill time is reported, and the batch below is the deterministic half.
t0=$(date +%s)
claimed=0
done_at_kill=0
while (($(date +%s) - t0 < 120)); do
  st="$(probe status || true)"
  done_at_kill="$(echo "$st" | field withCompletionMarker || true)"
  active="$(echo "$st" | queue_sum active || true)"
  # Empty means the probe did not answer this round; keep polling rather than
  # treating an unmeasured round as "nothing claimed".
  if [[ -n "$active" && -n "$done_at_kill" ]] && ((active > 0 || done_at_kill > 0)); then claimed=1; break; fi
  sleep 2
done
expect "a node claimed the batch" "nothing was claimed within 120s" [ "$claimed" = 1 ]

victim="$(nodes | head -1)"
if crash_node "$victim"; then
  ok "killed ${victim#pod/} (${done_at_kill} of ${TURNS} turns already done)"
else
  bad "could not kill ${victim#pod/}"
fi
if [[ "$done_at_kill" == "$TURNS" ]]; then
  printf '  note  the batch finished before the kill landed; the phase below is what proves re-delivery\n'
fi

# Every enqueued turn must still complete, exactly once. The dead node's turn is
# re-delivered, then waits on that node's session lock until its TTL expires;
# the completion marker is per job, so a re-delivered turn cannot be counted
# twice.
t0=$(date +%s)
done_count=0
while (($(date +%s) - t0 < RECOVER_TIMEOUT)); do
  done_count="$(probe status | field withCompletionMarker || true)"
  [[ "$done_count" == "$TURNS" ]] && break
  sleep 5
done
recovered=$(( $(date +%s) - t0 ))
expect_value "all $TURNS turns completed after the kill (took ${recovered}s)" \
  "$done_count" "$TURNS" "turns carrying a completion marker after ${recovered}s"

# delayed counts too: a turn waiting on a dead node's session lock sits there,
# and calling the queue "drained" without it would hide exactly that.
left="$(probe status || true)"
pending="$(echo "$left" | queue_sum waiting active delayed || true)"
expect_value "nothing is left pending in the shared queue" \
  "$pending" "0" "waiting+active+delayed after all turns completed"
failed="$(echo "$left" | queue_sum failed || true)"
expect_value "no turn was abandoned as failed" "$failed" "0" "failed"

# --- delivery with a node down, deterministically ---------------------------
# No race here: the node is already gone, so every turn in this batch must be
# claimed and completed by the survivor.
section "turn delivery with one node already down"
probe cleanup >/dev/null 2>&1 || true
enq2="$(probe enqueue "$TURNS" | field enqueued || true)"
expect_value "enqueued $TURNS more turns while one node is down" "$enq2" "$TURNS" "enqueued"
t0=$(date +%s)
done2=0
while (($(date +%s) - t0 < RECOVER_TIMEOUT)); do
  done2="$(probe status | field withCompletionMarker || true)"
  [[ "$done2" == "$TURNS" ]] && break
  sleep 5
done
expect_value "the surviving node completed all $TURNS" \
  "$done2" "$TURNS" "completed on the survivor" \
  [ "$done2" = "$TURNS" ]

# --- one cron occurrence, two gateways -------------------------------------
# The occurrence is claimed before dispatch, so only one gateway can take it;
# before that, a leader dying mid-turn handed the same occurrence to the next.
section "cron fires once across two gateways"
probe cron >/dev/null
t0=$(date +%s)
cron_jobs=""
advanced=""
while (($(date +%s) - t0 < 150)); do
  st="$(probe cron-status || true)"
  advanced="$(echo "$st" | field scheduleAdvanced || true)"
  cron_jobs="$(echo "$st" | field jobsForSession || true)"
  [[ "$advanced" == "True" && -n "$cron_jobs" && "$cron_jobs" -ge 1 ]] && break
  sleep 5
done
expect_value "the occurrence was claimed (schedule advanced before the turn finished)" \
  "$advanced" "True" "scheduleAdvanced"
expect_value "exactly one turn was dispatched for the occurrence" \
  "$cron_jobs" "1" "jobsForSession"

# --- summary ---------------------------------------------------------------
section "result"
echo "  $pass passed, $fail failed"
((fail == 0))
