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
gateway() { k get pod -l app.kubernetes.io/component=gateway --field-selector=status.phase=Running -o name | head -1; }
nodes() { k get pod -l app.kubernetes.io/component=node --field-selector=status.phase=Running -o name; }
probe() { k exec "$(gateway)" -- bun /tmp/probe/turns.ts "$@" 2>/dev/null | tail -1; }
field() { python3 -c 'import json,sys;print(json.loads(sys.stdin.read() or "{}").get(sys.argv[1], ""))' "$1"; }

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
enq="$(probe enqueue "$TURNS" | field enqueued)"
expect "enqueued $TURNS turns through the real queue" "enqueued=$enq" [ "$enq" = "$TURNS" ]

# Kill as soon as a node has claimed work, so the kill lands while turns are
# still moving. A suppressed turn is quick, so this is a race by nature: the
# count at kill time is reported, and the batch below is the deterministic half.
t0=$(date +%s)
claimed=0
done_at_kill=0
while (($(date +%s) - t0 < 120)); do
  st="$(probe status)"
  done_at_kill="$(echo "$st" | field withCompletionMarker)"
  active="$(echo "$st" | python3 -c 'import json,sys;print(json.load(sys.stdin)["shared"].get("active",0))')"
  if [[ "$active" -gt 0 || "$done_at_kill" -gt 0 ]]; then claimed=1; break; fi
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
  done_count="$(probe status | field withCompletionMarker)"
  [[ "$done_count" == "$TURNS" ]] && break
  sleep 5
done
recovered=$(( $(date +%s) - t0 ))
expect "all $TURNS turns completed after the kill (took ${recovered}s)" \
  "only $done_count of $TURNS turns carry a completion marker after ${recovered}s" \
  [ "$done_count" = "$TURNS" ]

# delayed counts too: a turn waiting on a dead node's session lock sits there,
# and calling the queue "drained" without it would hide exactly that.
left="$(probe status)"
pending="$(echo "$left" | python3 -c 'import json,sys;q=json.load(sys.stdin)["shared"];print(sum(int(q.get(k,0)) for k in ("waiting","active","delayed")))')"
expect "nothing is left pending in the shared queue" \
  "waiting+active+delayed=$pending after all turns completed" \
  [ "$pending" = 0 ]
failed="$(echo "$left" | python3 -c 'import json,sys;print(int(json.load(sys.stdin)["shared"].get("failed",0)))')"
expect "no turn was abandoned as failed" "failed=$failed" [ "$failed" = 0 ]

# --- delivery with a node down, deterministically ---------------------------
# No race here: the node is already gone, so every turn in this batch must be
# claimed and completed by the survivor.
section "turn delivery with one node already down"
probe cleanup >/dev/null 2>&1 || true
enq2="$(probe enqueue "$TURNS" | field enqueued)"
expect "enqueued $TURNS more turns while one node is down" "enqueued=$enq2" [ "$enq2" = "$TURNS" ]
t0=$(date +%s)
done2=0
while (($(date +%s) - t0 < RECOVER_TIMEOUT)); do
  done2="$(probe status | field withCompletionMarker)"
  [[ "$done2" == "$TURNS" ]] && break
  sleep 5
done
expect "the surviving node completed all $TURNS" \
  "only $done2 of $TURNS completed on the survivor" \
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
  st="$(probe cron-status)"
  advanced="$(echo "$st" | field scheduleAdvanced)"
  cron_jobs="$(echo "$st" | field jobsForSession)"
  [[ "$advanced" == "True" && -n "$cron_jobs" && "$cron_jobs" -ge 1 ]] && break
  sleep 5
done
expect "the occurrence was claimed (schedule advanced before the turn finished)" \
  "scheduleAdvanced=$advanced" \
  [ "$advanced" = "True" ]
expect "exactly one turn was dispatched for the occurrence" \
  "jobsForSession=$cron_jobs, want 1" \
  [ "$cron_jobs" = 1 ]

# --- summary ---------------------------------------------------------------
section "result"
echo "  $pass passed, $fail failed"
((fail == 0))
