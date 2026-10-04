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
# turn it held waits for that lock's TTL before another node can run it (10
# minutes by default, 45 s in the local overlay), and BullMQ's stall detection
# has to fire as well. Nothing is lost or duplicated — it is a latency bound, and
# the run reports how long it actually took.
#
# The probe's turns are suppressed, so the full lifecycle runs (claim, session
# lock, completion marker, ack) without a model call. Costs no provider tokens.
#
# Every diagnostic ("!!" lines) goes to stdout AND to a log file named on the
# first line of output (VERIFY_TURNS_LOG overrides its path). Redirecting or
# tee-ing stdout therefore keeps them.
#
# The node HPA is pinned (maxReplicas = minReplicas) for the run and restored on
# exit, so ordinary turn load cannot scale the deployment to three nodes.
set -uo pipefail

PROFILE="${MINIKUBE_PROFILE:-slaude-local}"
NS="${NAMESPACE:-slaude-scale}"
TURNS="${TURNS:-6}"
# A killed node cannot release its session lock, so the turn it was running is
# blocked until that lock's TTL expires. The local overlay sets a short TTL
# (SLAUDE_SESSION_LOCK_TTL_MS) so this is quick; production's default is 10
# minutes. The turn is never lost or duplicated either way — it waits.
RECOVER_TIMEOUT="${RECOVER_TIMEOUT:-240}"
CLAIM_TIMEOUT="${CLAIM_TIMEOUT:-120}"
CRON_TIMEOUT="${CRON_TIMEOUT:-150}"
SETTLE_TIMEOUT="${SETTLE_TIMEOUT:-120}"
POLL_FAST="${POLL_FAST:-2}"
POLL_SLOW="${POLL_SLOW:-5}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib.sh"

# --- output -----------------------------------------------------------------
# fd 3 is the script's own stdout. Helpers that run inside $(...) (probe, field)
# write through it, so their diagnostics reach the terminal and the log instead
# of being captured as a "value".
LOG="${VERIFY_TURNS_LOG:-$(mktemp "${TMPDIR:-/tmp}/verify-turns-log.XXXXXX")}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-turns-work.XXXXXX")"
: >"$LOG"
exec 3>&1
say() { printf '%s\n' "$*" | tee -a "$LOG" >&3; }
diag() { say "$*"; }
say "verify-turns: log file: $LOG"

pass=0
fail=0
ok() { say "  PASS  $*"; pass=$((pass + 1)); }
bad() { say "  FAIL  $*"; fail=$((fail + 1)); }
section() { say ""; say "--- $*"; }
expect() { # <label> <failure-detail> <test...>
  local label="$1" detail="$2"; shift 2
  if "$@"; then ok "$label"; else bad "$label — $detail"; fi
}

# Every call into the cluster is bounded. An unbounded `kubectl exec` hangs
# forever when the apiserver stops answering mid-run — observed stalling this
# script for 34 minutes inside `probe cron`, with no output to say why.
PROBE_TIMEOUT="${PROBE_TIMEOUT:-60s}"

k() { kubectl --context "$PROFILE" -n "$NS" "$@"; }
gateway() { k get pod -l app.kubernetes.io/component=gateway --field-selector=status.phase=Running -o name --request-timeout="$PROBE_TIMEOUT" 2>/dev/null | head -1; }
nodes() { k get pod -l app.kubernetes.io/component=node --field-selector=status.phase=Running -o name; }

# Run the in-pod probe.
#
# On any failure this says so (stdout and log, via diag) and returns non-zero,
# printing NOTHING to the caller's pipe. That distinction is the point: `field`
# used to turn both a failed exec and a genuine zero into an empty string, so an
# unreachable pod was reported as "only  of 6 turns completed" — infrastructure
# trouble wearing a product failure's clothes, which is worse than no result at
# all.
#
# The probe's name is left in $WORK/last_probe (this runs in a subshell, so a
# variable would not survive) for `field` and `queue_sum` to quote.
probe() {
  local pod out rc
  printf '%s' "${1:-?}" >"$WORK/last_probe"
  pod="$(gateway)"
  if [[ -z "$pod" ]]; then
    diag "  !! probe ${1:-?}: no running gateway pod to exec into"
    return 1
  fi
  out="$(k exec --request-timeout="$PROBE_TIMEOUT" "$pod" -- bun /tmp/probe/turns.ts "$@" 2>&1)"
  rc=$?
  if ((rc != 0)); then
    diag "  !! probe ${1:-?} failed (exit $rc) on ${pod#pod/}: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
    return "$rc"
  fi
  printf 'probe %s -> %s\n' "${1:-?}" "$(printf '%s\n' "$out" | tail -1)" >>"$LOG"
  printf '%s\n' "$out" | tail -1
}

# Say why a probe's output could not be used. Exit codes come from the python
# readers below: 3 empty, 4 not JSON, 5 key or shape missing.
explain() { # <consumer> <rc> <raw>
  local name raw="$3"
  name="$(cat "$WORK/last_probe" 2>/dev/null || echo '?')"
  case "$2" in
    3) diag "  !! $1: probe '$name' produced no output (it failed, or printed nothing)" ;;
    4) diag "  !! $1: probe '$name' did not return JSON; got: ${raw:0:200}" ;;
    *) diag "  !! $1: probe '$name' returned JSON without what was asked for; got: ${raw:0:200}" ;;
  esac
}

# Pull one field out of the probe's JSON. Prints nothing and returns non-zero
# when the input is empty, unparseable, or lacks the key — and says which probe
# and what it received — so a failed probe cannot be read as a number.
field() {
  local raw rc val
  raw="$(cat)"
  val="$(python3 -c '
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    sys.exit(3)
try:
    doc = json.loads(raw)
except json.JSONDecodeError:
    sys.exit(4)
if not isinstance(doc, dict) or sys.argv[1] not in doc:
    sys.exit(5)
print(doc[sys.argv[1]])
' "$1" <<<"$raw")"
  rc=$?
  if ((rc != 0)); then
    explain "field $1" "$rc" "$raw"
    return "$rc"
  fi
  printf '%s\n' "$val"
}

# Sum one or more counters out of the probe's `shared` queue snapshot. Same
# contract as `field`.
queue_sum() { # <counter...>
  local raw rc val
  raw="$(cat)"
  val="$(python3 -c '
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    sys.exit(3)
try:
    doc = json.loads(raw)
except json.JSONDecodeError:
    sys.exit(4)
try:
    q = doc["shared"]
    total = sum(int(q.get(k, 0)) for k in sys.argv[1:])
except (KeyError, TypeError, AttributeError, ValueError):
    sys.exit(5)
print(total)
' "$@" <<<"$raw")"
  rc=$?
  if ((rc != 0)); then
    explain "queue_sum $*" "$rc" "$raw"
    return "$rc"
  fi
  printf '%s\n' "$val"
}

# Assert on a value the probe measured. An empty actual means no measurement was
# ever obtained, which is reported as such: "could not measure" and "measured
# the wrong number" have different causes and different fixes, and conflating
# them is what made three of this script's past failures misleading.
expect_value() { # <label> <actual> <want> <context>
  local label="$1" actual="$2" want="$3" ctx="$4"
  if [[ -z "$actual" ]]; then
    bad "$label — COULD NOT MEASURE ($ctx); see the !! lines above for why the probe failed (all of them are in $LOG)"
  elif [[ "$actual" == "$want" ]]; then
    ok "$label"
  else
    bad "$label — $ctx: got '$actual', want '$want'"
  fi
}

# Kill a node's container outright — no SIGTERM, no drain — the way verify-ha
# simulates a lost worker.
crash_node() { # <pod>
  local pod="${1#pod/}" id out
  id="$(k get pod "$pod" -o jsonpath='{.status.containerStatuses[0].containerID}' | sed 's|.*/||')"
  [[ -n "$id" ]] || { diag "  !! crash_node: no container id for $pod"; return 1; }
  if ! out="$(minikube -p "$PROFILE" ssh -- docker kill --signal=KILL "$id" 2>&1)"; then
    diag "  !! docker kill of $pod failed: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
    return 1
  fi
}

cleanup() {
  local pod
  # The probe's stdout is a JSON ack nobody needs; its failures go through diag.
  probe cleanup >/dev/null || diag "  !! cleanup: the probe's own cleanup failed; its rows and markers may remain"
  pod="$(gateway)"
  if [[ -z "$pod" ]]; then
    diag "  !! cleanup: no running gateway pod; /tmp/probe and /tmp/verify-turns-ids.json were not removed"
  elif ! k exec --request-timeout="$PROBE_TIMEOUT" "$pod" -- rm -rf /tmp/probe /tmp/verify-turns-ids.json >/dev/null 2>&1; then
    diag "  !! cleanup: could not remove /tmp/probe from ${pod#pod/}"
  fi
  restore_node_hpa
  rm -rf "$WORK"
  say "verify-turns: log file: $LOG"
}
trap cleanup EXIT

# --- preconditions ---------------------------------------------------------
section "preconditions"
# Pin the node HPA first: left alone it scales the deployment to three under
# turn load and holds it there for its ten-minute scale-down window.
if pin_node_hpa; then
  # The HPA scales a third node away on its own sync period; give it time.
  wait_deploy_ready slaude-node 2 "$SETTLE_TIMEOUT" ||
    diag "  note  node deployment did not settle at two replicas within ${SETTLE_TIMEOUT}s; the assertions below accept more than two nodes"
else
  diag "  note  node HPA not pinned; the assertions below accept more than two nodes"
fi

gw_ready="$(k get deploy slaude-gateway -o jsonpath='{.status.readyReplicas}' 2>/dev/null)"
node_ready="$(k get deploy slaude-node -o jsonpath='{.status.readyReplicas}' 2>/dev/null)"
# At least two of each: every assertion below holds with more than two.
expect "at least two gateway replicas ready" "gateway ready=$gw_ready, want >= 2" [ "${gw_ready:-0}" -ge 2 ]
expect "at least two node replicas ready" "node ready=$node_ready, want >= 2" [ "${node_ready:-0}" -ge 2 ]
if ((fail > 0)); then
  say "cluster is not at two gateways and two nodes; run up.sh first"
  exit 2
fi

gw_pod="$(gateway)"
if [[ -z "$gw_pod" ]]; then
  say "  !! no running gateway pod to copy the probe into"
  exit 2
fi
if ! k exec -i "$gw_pod" -- sh -c 'mkdir -p /tmp/probe && cat > /tmp/probe/turns.ts' < "$HERE/probe/turns.ts"; then
  say "  !! could not copy probe/turns.ts into ${gw_pod#pod/}"
  exit 2
fi

# --- turn delivery survives losing a node ----------------------------------
section "turn delivery while a node dies"
probe cleanup >/dev/null || true
enq="$(probe enqueue "$TURNS" | field enqueued || true)"
expect_value "enqueued $TURNS turns through the real queue" "$enq" "$TURNS" "enqueued"

# Kill as soon as a node has claimed work, so the kill lands while turns are
# still moving. A suppressed turn is quick, so this is a race by nature: the
# count at kill time is reported, and the batch below is the deterministic half.
t0=$(date +%s)
claimed=0
done_at_kill=0
while (($(date +%s) - t0 < CLAIM_TIMEOUT)); do
  st="$(probe status || true)"
  done_at_kill="$(echo "$st" | field withCompletionMarker || true)"
  active="$(echo "$st" | queue_sum active || true)"
  # Empty means the probe did not answer this round; keep polling rather than
  # treating an unmeasured round as "nothing claimed".
  if [[ -n "$active" && -n "$done_at_kill" ]] && ((active > 0 || done_at_kill > 0)); then claimed=1; break; fi
  sleep "$POLL_FAST"
done
expect "a node claimed the batch" "nothing was claimed within ${CLAIM_TIMEOUT}s" [ "$claimed" = 1 ]

victim="$(nodes | head -1)"
if crash_node "$victim"; then
  ok "killed ${victim#pod/} (${done_at_kill} of ${TURNS} turns already done)"
else
  bad "could not kill ${victim#pod/}"
fi
if [[ "$done_at_kill" == "$TURNS" ]]; then
  say "  note  the batch finished before the kill landed; the phase below is what proves re-delivery"
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
  sleep "$POLL_SLOW"
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
probe cleanup >/dev/null || true
enq2="$(probe enqueue "$TURNS" | field enqueued || true)"
expect_value "enqueued $TURNS more turns while one node is down" "$enq2" "$TURNS" "enqueued"
t0=$(date +%s)
done2=0
while (($(date +%s) - t0 < RECOVER_TIMEOUT)); do
  done2="$(probe status | field withCompletionMarker || true)"
  [[ "$done2" == "$TURNS" ]] && break
  sleep "$POLL_SLOW"
done
expect_value "the surviving node completed all $TURNS" \
  "$done2" "$TURNS" "completed on the survivor"

# --- one cron occurrence, two gateways -------------------------------------
# The occurrence is claimed before dispatch, so only one gateway can take it;
# before that, a leader dying mid-turn handed the same occurrence to the next.
section "cron fires once across two gateways"
if probe cron >/dev/null; then
  ok "inserted one already-due cron job"
else
  bad "could not insert the cron job — see the !! line above"
fi
t0=$(date +%s)
cron_jobs=""
advanced=""
while (($(date +%s) - t0 < CRON_TIMEOUT)); do
  st="$(probe cron-status || true)"
  advanced="$(echo "$st" | field scheduleAdvanced || true)"
  cron_jobs="$(echo "$st" | field jobsForSession || true)"
  [[ "$advanced" == "True" && -n "$cron_jobs" && "$cron_jobs" -ge 1 ]] && break
  sleep "$POLL_SLOW"
done
expect_value "the occurrence was claimed (schedule advanced before the turn finished)" \
  "$advanced" "True" "scheduleAdvanced"
expect_value "exactly one turn was dispatched for the occurrence" \
  "$cron_jobs" "1" "jobsForSession"

# --- summary ---------------------------------------------------------------
section "result"
say "  $pass passed, $fail failed"
((fail == 0))
