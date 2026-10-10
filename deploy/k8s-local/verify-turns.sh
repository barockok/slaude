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
# Then the node-label topology (the local persona set must be synced: up.sh does
# it, personas.sh sync redoes it): a turn for `beta` lands on a `finance` node and
# never on a `default` one; the label gate refuses a node another label's bundle
# while it holds a valid job token; a rotated Vault key reaches the next new
# thread; a bridged MCP tool answers through the gateway; with every `finance`
# node stopped a `beta` turn waits and the label is reported unserved, then runs
# once a node is back; a relabelled persona's next turn goes to its new label.
# Everything it changes (the finance replica count, beta's label, beta's Vault
# key) is put back on exit.
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
# A Vault rotation reaches a new bundle within the gateway's Vault cache TTL
# (SLAUDE_VAULT_CACHE_TTL, 10 s in the local overlay).
ROTATE_TIMEOUT="${ROTATE_TIMEOUT:-90}"
# slaude_label_unserved needs waiting work and no live node for longer than
# SLAUDE_LABEL_UNSERVED_SECS (20 s locally), plus a reaper pass (30 s).
UNSERVED_TIMEOUT="${UNSERVED_TIMEOUT:-150}"
POLL_FAST="${POLL_FAST:-2}"
POLL_SLOW="${POLL_SLOW:-5}"
# The helper scripts the label sections call (overridable, so the script's own
# tests can stand them in), each bounded by HELPER_TIMEOUT seconds.
HELPER_TIMEOUT="${HELPER_TIMEOUT:-300}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PERSONAS_SH="${PERSONAS_SH:-$HERE/personas.sh}"
VAULT_SH="${VAULT_SH:-$HERE/vault.sh}"
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

# Every call is bounded (PROBE_TIMEOUT), including the ones that look instant.
k() { kubectl --context "$PROFILE" -n "$NS" --request-timeout="$PROBE_TIMEOUT" "$@"; }
gateway() { k get pod -l app.kubernetes.io/component=gateway --field-selector=status.phase=Running -o name --request-timeout="$PROBE_TIMEOUT" 2>/dev/null | head -1; }
gateways() { k get pod -l app.kubernetes.io/component=gateway --field-selector=status.phase=Running -o name --request-timeout="$PROBE_TIMEOUT" 2>/dev/null; }
# The `default` label's nodes (slaude-node), and the `finance` label's.
nodes() { k get pod -l app.kubernetes.io/component=node --field-selector=status.phase=Running -o name; }
finance_nodes() { k get pod -l app.kubernetes.io/component=node-finance --field-selector=status.phase=Running -o name --request-timeout="$PROBE_TIMEOUT" 2>/dev/null; }

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
  local pod
  printf '%s' "${1:-?}" >"$WORK/last_probe"
  pod="$(gateway)"
  if [[ -z "$pod" ]]; then
    diag "  !! probe ${1:-?}: no running gateway pod to exec into"
    return 1
  fi
  probe_in "$pod" "$@"
}

# The same, in a named gateway pod (the probe must have been installed there).
probe_in() { # <pod> <args...>
  local pod="$1" out rc
  shift
  printf '%s' "${1:-?}" >"$WORK/last_probe"
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

# Copy a probe script into a pod once per run. Non-zero (and says why) on failure.
install_in() { # <pod> <script under probe/>
  local pod="${1#pod/}"
  grep -qxF "$pod $2" "$WORK/installed" 2>/dev/null && return 0
  if ! k exec -i --request-timeout="$PROBE_TIMEOUT" "$pod" -- sh -c "mkdir -p /tmp/probe && cat > /tmp/probe/$2" \
    <"$HERE/probe/$2" >/dev/null 2>&1; then
    diag "  !! could not copy probe/$2 into $pod"
    return 1
  fi
  echo "$pod $2" >>"$WORK/installed"
}

# The node-side probe (probe/node.ts) in a node pod, as that node. Same contract
# as `probe`: on failure it says so and prints nothing. stdin passes through
# (the job token, for runtime and mcpx).
node_probe() { # <pod> <args...>
  local pod="${1#pod/}" out rc
  shift
  printf 'node %s' "${1:-?}" >"$WORK/last_probe"
  install_in "$pod" node.ts || return 1
  out="$(k exec -i --request-timeout="$PROBE_TIMEOUT" "$pod" -- bun /tmp/probe/node.ts "$@" 2>&1)"
  rc=$?
  if ((rc != 0)); then
    diag "  !! node probe ${1:-?} failed (exit $rc) on $pod: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
    return "$rc"
  fi
  printf 'node probe %s on %s -> %s\n' "${1:-?}" "$pod" "$(printf '%s\n' "$out" | tail -1)" >>"$LOG"
  printf '%s\n' "$out" | tail -1
}

# A job token for one fresh session of <persona>, signed for <label> (or `live`:
# the persona's current label). Printed for a pipe into node_probe, never logged.
job_token() { # <persona> <label|live>
  local pod out
  pod="$(gateway)"
  [[ -n "$pod" ]] || { diag "  !! job token: no running gateway pod"; return 1; }
  out="$(k exec --request-timeout="$PROBE_TIMEOUT" "$pod" -- bun /tmp/probe/turns.ts token 1 --persona "$1" --label "$2" 2>/dev/null)"
  if [[ ! "$out" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]; then
    diag "  !! could not mint a job token for persona $1 (label $2); is the local persona set synced?"
    return 1
  fi
  printf '%s' "$out"
}

# The node probe's answer for <persona>'s bundle, with a fresh job token (a new
# thread). Prints the probe's JSON line, or nothing.
runtime_as() { # <node pod> <persona> <label|live>
  local tok
  tok="$(job_token "$2" "$3")" || return 1
  printf '%s' "$tok" | node_probe "$1" runtime "$2"
}

# Every session-boot line of the given pods' logs. Non-zero (and silent) if ANY
# pod's logs could not be read, so a missing pod is never read as "no line".
boot_lines() { # <pod...>
  local p out all=""
  (($# > 0)) || return 1
  for p in "$@"; do
    out="$(k logs --request-timeout="$PROBE_TIMEOUT" "$p" 2>/dev/null)" || return 1
    all+="$(grep -E 'session=[^ ]+ persona=' <<<"$out" || true)"$'\n'
  done
  printf '%s' "$all"
}

# How many of <sessions> booted on <pods>: "n" (0..), or nothing when the logs
# could not be read.
sessions_booted_on() { # "<session ids>" <pod...>
  local ids="$1" lines n=0 id
  shift
  lines="$(boot_lines "$@")" || return 1
  for id in $ids; do grep -qF "session=$id persona=" <<<"$lines" && n=$((n + 1)); done
  printf '%s\n' "$n"
}

# Wait (bounded) until the probe's tracked turns all carry a completion marker.
# Prints the last count read, or nothing if never measured.
wait_done() { # <want> <seconds> [probe status args...]
  local want="$1" secs="$2" v="" cur t0
  shift 2
  t0=$(date +%s)
  while (($(date +%s) - t0 < secs)); do
    cur="$(probe status "$@" | field withCompletionMarker || true)"
    [[ -n "$cur" ]] && v="$cur"
    [[ "$v" == "$want" ]] && break
    sleep "$POLL_SLOW"
  done
  printf '%s' "$v"
}

# Run a command with a wall-clock bound, without coreutils `timeout` (absent on
# macOS). The watchdog's output goes to /dev/null so it never holds the pipe of a
# $(...) that captures the command. Returns the command's status (143 if killed).
bounded() { # <seconds> <command...>
  local secs="$1" pid w rc
  shift
  # <&0: a backgrounded command in a non-interactive bash otherwise gets /dev/null,
  # which dropped the key piped into `vault.sh rotate`. Callers that want no input
  # redirect </dev/null themselves.
  "$@" <&0 &
  pid=$!
  (sleep "$secs" && kill -TERM "$pid") >/dev/null 2>&1 &
  w=$!
  wait "$pid"
  rc=$?
  kill "$w" >/dev/null 2>&1
  wait "$w" 2>/dev/null
  return "$rc"
}

# The local helper scripts, bounded, with no terminal on stdin.
helper() { # personas|vault <args...>
  local script="$VAULT_SH"
  [[ "$1" == personas ]] && script="$PERSONAS_SH"
  shift
  SLAUDE_LOCAL_PROFILE="$PROFILE" bounded "$HELPER_TIMEOUT" "$script" "$@" </dev/null
}

# Kill a node's container outright — no SIGTERM, no drain — the way verify-ha
# simulates a lost worker.
crash_node() { # <pod>
  local pod="${1#pod/}" id out
  id="$(k get pod "$pod" -o jsonpath='{.status.containerStatuses[0].containerID}' | sed 's|.*/||')"
  [[ -n "$id" ]] || { diag "  !! crash_node: no container id for $pod"; return 1; }
  # minikube has no request timeout of its own; bound it by PROBE_TIMEOUT's seconds.
  local secs="${PROBE_TIMEOUT%s}"
  [[ "$secs" =~ ^[0-9]+$ ]] || secs=60
  if ! out="$(bounded "$secs" minikube -p "$PROFILE" ssh -- docker kill --signal=KILL "$id" 2>&1 </dev/null)"; then
    diag "  !! docker kill of $pod failed: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
    return 1
  fi
}

cleanup() {
  local pod
  # Put back what the label sections changed, before anything else.
  if [[ -n "${FINANCE_REPLICAS:-}" ]]; then
    k scale deploy slaude-node-finance --replicas="$FINANCE_REPLICAS" >/dev/null 2>&1 \
      || diag "  !! cleanup: could not scale slaude-node-finance back to $FINANCE_REPLICAS; do it by hand"
  fi
  if [[ -n "${RELABELED:-}" ]]; then
    helper personas sync >/dev/null 2>&1 \
      || diag "  !! cleanup: could not re-sync the persona set; beta may still run on default (personas.sh sync)"
  fi
  if [[ -n "${ROTATED:-}" ]]; then
    helper vault reseed beta >/dev/null 2>&1 \
      || diag "  !! cleanup: could not restore beta's Vault secret (vault.sh reseed beta)"
  fi
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

# --- node labels: routing ----------------------------------------------------
# The persona's label is resolved the way dispatch resolves it (`--label live`:
# runsOnFor over the live persona rows), and the turns' session boots are looked
# for in the node logs: on a `finance` node, and on no `default` node.
section "node labels: a finance persona's turns run on finance nodes only"
probe cleanup >/dev/null || true
# shellcheck disable=SC2207 # pod names contain no whitespace
fin_pods=($(finance_nodes))
# shellcheck disable=SC2207
def_pods=($(nodes))
enq_out="$(probe enqueue 2 --persona beta --label live || true)"
beta_label="$(field label <<<"$enq_out" || true)"
expect_value "beta resolves to label finance (is the persona set synced? personas.sh sync)" "$beta_label" "finance" "label"
beta_sessions="$(python3 -c 'import json,sys; print(" ".join(json.loads(sys.argv[1])["sessions"]))' "$enq_out" 2>/dev/null || true)"
if [[ "$beta_label" != finance || -z "$beta_sessions" ]]; then
  bad "finance routing — COULD NOT MEASURE (no beta turns were enqueued on finance)"
elif ((${#fin_pods[@]} == 0)); then
  bad "finance routing — COULD NOT MEASURE (no running finance node)"
else
  done_b="$(wait_done 2 "$RECOVER_TIMEOUT" 0 --label finance)"
  expect_value "both beta turns completed" "$done_b" "2" "turns carrying a completion marker"
  on_fin=""
  t0=$(date +%s)
  while (($(date +%s) - t0 < 30)); do
    on_fin="$(sessions_booted_on "$beta_sessions" "${fin_pods[@]}" || true)"
    [[ "$on_fin" == 2 ]] && break
    sleep "$POLL_FAST"
  done
  expect_value "both beta sessions booted on a finance node" "$on_fin" "2" "sessions found in finance node logs"
  on_def="$(sessions_booted_on "$beta_sessions" "${def_pods[@]}" || true)"
  expect_value "no beta session booted on a default node" "$on_def" "0" "sessions found in default node logs"
fi

# --- the label gate ------------------------------------------------------------
# A valid job token is not enough: a node without the persona's label is refused
# the persona's bundle (403), whatever token it presents.
section "the label gate"
if ((${#fin_pods[@]} == 0 || ${#def_pods[@]} == 0)); then
  bad "label gate — COULD NOT MEASURE (needs a running finance node and a running default node)"
else
  got="$(runtime_as "${def_pods[0]}" beta finance | field status || true)"
  expect_value "a default node is refused beta's bundle (403) while holding beta's job token" "$got" "403" "runtime status"
  got="$(runtime_as "${fin_pods[0]}" beta finance | field status || true)"
  expect_value "a finance node gets beta's bundle" "$got" "200" "runtime status"
  got="$(runtime_as "${fin_pods[0]}" alpha default | field status || true)"
  expect_value "a finance node is refused alpha's bundle (403)" "$got" "403" "runtime status"
fi

# --- provider rotation ---------------------------------------------------------
# A new thread fetches a fresh bundle; the gateway resolves the persona's Vault
# reference again once its cache entry is older than SLAUDE_VAULT_CACHE_TTL.
# Only a sha256 prefix of the key is ever compared, never the key.
section "provider rotation: a new thread uses the new key"
if ((${#fin_pods[@]} == 0)); then
  bad "provider rotation — COULD NOT MEASURE (no running finance node)"
else
  before="$(runtime_as "${fin_pods[0]}" beta live | field keySha || true)"
  if [[ -z "$before" || "$before" == None ]]; then
    bad "provider rotation — COULD NOT MEASURE (beta's bundle carries no provider key; is Vault seeded? vault.sh seed)"
  else
    rot_out="$(printf 'local-rotated-%s-%s\n' "$(date +%s)" "$RANDOM" | SLAUDE_LOCAL_PROFILE="$PROFILE" bounded "$HELPER_TIMEOUT" "$VAULT_SH" rotate beta 2>&1)" && ROTATED=1
    want="$(sed -n 's/.* sha=\([0-9a-f]\{12\}\)$/\1/p' <<<"$rot_out")"
    if [[ -z "$want" ]]; then
      bad "provider rotation — could not rotate beta's key: ${rot_out:0:200}"
    else
      after=""
      t0=$(date +%s)
      while (($(date +%s) - t0 < ROTATE_TIMEOUT)); do
        after="$(runtime_as "${fin_pods[0]}" beta live | field keySha || true)"
        [[ "$after" == "$want" ]] && break
        sleep "$POLL_SLOW"
      done
      took=$(($(date +%s) - t0))
      expect_value "a new thread's bundle carries the rotated key (after ${took}s)" "$after" "$want" "key hash in a fresh bundle"
    fi
  fi
fi

# --- MCP bridge ----------------------------------------------------------------
# beta's `mockmcp` server is bridged: the node lists and calls it through the
# gateway, which holds the configuration and the credential. alpha does not
# bridge it, so the same route answers 404 for alpha's token.
section "MCP bridge"
if ((${#fin_pods[@]} == 0 || ${#def_pods[@]} == 0)); then
  bad "MCP bridge — COULD NOT MEASURE (needs a running finance node and a running default node)"
else
  tok="$(job_token beta live || true)"
  if [[ -z "$tok" ]]; then
    bad "MCP bridge — COULD NOT MEASURE (no job token for beta)"
  else
    listed="$(printf '%s' "$tok" | node_probe "${fin_pods[0]}" mcpx mockmcp list | field tools || true)"
    expect_value "beta lists the bridged server's tools" "$listed" "['echo']" "tools"
    word="verify-$(date +%s)-$RANDOM"
    called="$(printf '%s' "$tok" | node_probe "${fin_pods[0]}" mcpx mockmcp call "$word" | field text || true)"
    expect_value "beta's call reaches the upstream and comes back" "$called" "echo: $word" "tool result text"
  fi
  tok_a="$(job_token alpha live || true)"
  got=""
  if [[ -n "$tok_a" ]]; then
    got="$(printf '%s' "$tok_a" | node_probe "${def_pods[0]}" mcpx mockmcp list | field status || true)"
  fi
  expect_value "alpha, which does not bridge mockmcp, gets 404 for it" "$got" "404" "status"
fi

# --- an unserved label ---------------------------------------------------------
# Stop every finance node: a beta turn must wait (not fail, not run elsewhere),
# the reaper leader must report the label unserved, and the turn must run once
# a finance node is back. The replica count is restored on exit in any case.
section "unserved label: a finance turn waits for a finance node"
orig="$(k get deploy slaude-node-finance -o jsonpath='{.spec.replicas}' 2>/dev/null)"
gws=()
for g in $(gateways); do install_in "$g" turns.ts && gws+=("$g"); done
if [[ ! "$orig" =~ ^[1-9][0-9]*$ ]]; then
  bad "unserved label — COULD NOT MEASURE (slaude-node-finance replicas '${orig}', want 1 or more)"
elif ((${#gws[@]} == 0)); then
  bad "unserved label — COULD NOT MEASURE (no gateway pod to read the metric from)"
elif ! k scale deploy slaude-node-finance --replicas=0 >/dev/null; then
  bad "unserved label — could not scale slaude-node-finance to 0"
else
  FINANCE_REPLICAS="$orig"
  t0=$(date +%s)
  while [[ -n "$(finance_nodes)" ]] && (($(date +%s) - t0 < SETTLE_TIMEOUT)); do sleep "$POLL_FAST"; done
  probe cleanup >/dev/null || true
  enq="$(probe enqueue 1 --persona beta --label live | field label || true)"
  expect_value "a beta turn was enqueued on finance with no finance node" "$enq" "finance" "label"
  seen=""
  t0=$(date +%s)
  while [[ "$enq" == finance ]] && (($(date +%s) - t0 < UNSERVED_TIMEOUT)); do
    for g in "${gws[@]}"; do
      v="$(probe_in "${g#pod/}" unserved finance | field value || true)"
      [[ "$v" == 1 ]] && { seen=1; break 2; }
      [[ -n "$v" ]] && seen="${seen:-0}"
    done
    sleep "$POLL_SLOW"
  done
  expect_value "slaude_label_unserved{label=\"finance\"} is 1 on the reaper leader (after $(($(date +%s) - t0))s)" "$seen" "1" "gauge"
  st="$(probe status 0 --label finance || true)"
  expect_value "the turn did not run while finance was unserved" "$(field withCompletionMarker <<<"$st" || true)" "0" "turns completed"
  expect_value "the turn is still waiting on turns.label.finance" "$(queue_sum waiting delayed <<<"$st" || true)" "1" "waiting+delayed"
  if k scale deploy slaude-node-finance --replicas="$orig" >/dev/null; then
    FINANCE_REPLICAS=""
    resumed="$(wait_done 1 "$RECOVER_TIMEOUT" 0 --label finance)"
    expect_value "the waiting turn ran once a finance node was back" "$resumed" "1" "turns completed"
  else
    bad "could not scale slaude-node-finance back to $orig"
  fi
fi

# --- relabel -------------------------------------------------------------------
# A sync that moves beta to `default` sends its next turn to a default node. An
# in-flight turn's one re-dispatch (LABEL_MISMATCH) is done by the gateway that
# dispatched it, which a probe-enqueued turn has none of: that half is the
# real-Slack runbook's (README.md).
section "relabel: the next turn follows the persona's new label"
if ! sync_out="$(helper personas sync --relabel beta=default 2>&1)"; then
  bad "relabel — could not sync beta onto default: ${sync_out:0:200}"
else
  RELABELED=1
  probe cleanup >/dev/null || true
  enq_out="$(probe enqueue 1 --persona beta --label live || true)"
  expect_value "beta now resolves to label default" "$(field label <<<"$enq_out" || true)" "default" "label"
  sess="$(field session <<<"$enq_out" || true)"
  done_r="$(wait_done 1 "$RECOVER_TIMEOUT")"
  expect_value "the relabelled persona's turn completed" "$done_r" "1" "turns completed"
  # shellcheck disable=SC2207
  def_pods=($(nodes))
  on_def=""
  t0=$(date +%s)
  while [[ -n "$sess" ]] && (($(date +%s) - t0 < 30)); do
    on_def="$(sessions_booted_on "$sess" "${def_pods[@]}" || true)"
    [[ "$on_def" == 1 ]] && break
    sleep "$POLL_FAST"
  done
  expect_value "it booted on a default node" "$on_def" "1" "session found in default node logs"
  if helper personas sync >/dev/null 2>&1; then
    RELABELED=""
    expect_value "after the set is synced again, beta is back on finance" \
      "$(probe enqueue 1 --persona beta --label live | field label || true)" "finance" "label"
    probe cleanup >/dev/null || true
  else
    bad "could not sync the persona set back; beta still runs on default"
  fi
fi

# --- summary ---------------------------------------------------------------
section "result"
say "  $pass passed, $fail failed"
((fail == 0))
