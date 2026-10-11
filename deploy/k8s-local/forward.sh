#!/usr/bin/env bash
# A port-forward that heals itself.
#
#   forward.sh gateway     svc/slaude-gateway  -> localhost:$SLAUDE_LOCAL_PORT           (8080)
#   forward.sh keycloak    svc/keycloak        -> localhost:$SLAUDE_LOCAL_KEYCLOAK_PORT  (8180)
#   forward.sh mock-mcp    svc/mock-mcp        -> localhost:$SLAUDE_LOCAL_MOCK_MCP_PORT  (9000)
#
# Plain `kubectl port-forward svc/...` picks ONE pod and keeps talking to it.
# When that pod is replaced (any rollout, any crash) the forward goes quiet, and
# whatever was using it (a browser, a tunnel to Slack) fails with nothing to say
# why. This script forwards to one named pod and, every few seconds, checks that
#
#   - the forward process is still running,
#   - the pod it is bound to is still a ready endpoint of the Service, and
#   - the forwarded endpoint answers,
#
# and when any of those fails it tears the forward down and binds a fresh pod.
#
# It refuses to start when the local port is already taken: a second forward on
# a busy port can quietly bind another loopback address while the old listener
# keeps answering, which looks exactly like a working forward.
#
# Environment (all optional):
#   SLAUDE_LOCAL_PROFILE        kube context / minikube profile   (default slaude-local)
#   SLAUDE_LOCAL_PORT           gateway local port                (default 8080)
#   SLAUDE_LOCAL_KEYCLOAK_PORT  Keycloak local port               (default 8180)
#   SLAUDE_LOCAL_MOCK_MCP_PORT  mock MCP local port               (default 9000)
#   SLAUDE_FORWARD_INTERVAL     seconds between checks            (default 3)
#   SLAUDE_FORWARD_STARTUP      seconds to wait for a new forward to answer (default 15)
#
# Stop it with Ctrl-C. Run one per target, in its own terminal.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib.sh"

PROFILE="${SLAUDE_LOCAL_PROFILE:-slaude-local}"
NS="slaude-scale"
INTERVAL="${SLAUDE_FORWARD_INTERVAL:-3}"
STARTUP="${SLAUDE_FORWARD_STARTUP:-15}"

log() { printf '%s forward[%s]: %s\n' "$(date +%H:%M:%S)" "${TARGET:-?}" "$*"; }
die() { printf 'forward: %s\n' "$*" >&2; exit 1; }

TARGET="${1:-}"
case "$TARGET" in
  gateway)  SVC=slaude-gateway; PORT="${SLAUDE_LOCAL_PORT:-8080}";          HEALTH=/healthz ;;
  keycloak) SVC=keycloak;       PORT="${SLAUDE_LOCAL_KEYCLOAK_PORT:-8180}"; HEALTH=/realms/slaude-dev/.well-known/openid-configuration ;;
  # The mock MCP has no health route; any HTTP answer shows the forward is alive.
  mock-mcp) SVC=mock-mcp;       PORT="${SLAUDE_LOCAL_MOCK_MCP_PORT:-9000}"; HEALTH=ANY ;;
  *) die "usage: forward.sh gateway|keycloak|mock-mcp" ;;
esac
[[ "$PORT" =~ ^[0-9]+$ ]] || die "the local port for $TARGET is not a number: '$PORT'"

kc() { kubectl --context "$PROFILE" -n "$NS" "$@"; }

# Ready endpoints of the Service: pod names, one per line.
endpoint_pods() {
  kc get endpoints "$SVC" -o jsonpath='{range .subsets[*].addresses[*]}{.targetRef.name}{"\n"}{end}' 2>/dev/null
}
# The container port the Service resolves to.
endpoint_port() {
  kc get endpoints "$SVC" -o jsonpath='{.subsets[0].ports[0].port}' 2>/dev/null
}

healthy() {
  local code
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$PORT${HEALTH/ANY/}" 2>/dev/null)" || return 1
  if [[ "$HEALTH" == ANY ]]; then [[ "$code" != 000 ]]; else [[ "$code" =~ ^[23] ]]; fi
}

who_holds_port() {
  command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -3
}

FWD_PID=""
FWD_POD=""
ERRFILE="$(mktemp "${TMPDIR:-/tmp}/forward-err.XXXXXX")"

stop_forward() {
  local i
  if [[ -n "$FWD_PID" ]]; then
    kill "$FWD_PID" 2>/dev/null
    # A hung forward may ignore TERM, and a forward we are recycling is by
    # definition not behaving: escalate rather than wait on it.
    for ((i = 0; i < 8; i++)); do
      kill -0 "$FWD_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -9 "$FWD_PID" 2>/dev/null
    wait "$FWD_PID" 2>/dev/null
    FWD_PID=""
  fi
  FWD_POD=""
}
cleanup() { stop_forward; rm -f "$ERRFILE"; }
trap cleanup EXIT
trap 'log "stopping"; exit 0' INT TERM

port_in_use "$PORT" && die "localhost:$PORT is already in use$(who_holds_port | sed 's/^/\n  /'); free it or set the port variable for $TARGET"

start_forward() { # returns non-zero when there is nothing to forward to yet
  local pod cport i
  pod="$(endpoint_pods | head -1)"
  cport="$(endpoint_port)"
  if [[ -z "$pod" || ! "$cport" =~ ^[0-9]+$ ]]; then
    log "no ready endpoint for svc/$SVC yet"
    return 1
  fi
  # The previous forward may still be releasing the port.
  for ((i = 0; i < 20; i++)); do
    port_in_use "$PORT" || break
    sleep 0.25
  done
  if port_in_use "$PORT"; then
    log "localhost:$PORT is held by something else; giving up rather than binding beside it"
    who_holds_port
    exit 1
  fi
  : >"$ERRFILE"
  # kubectl itself is backgrounded, not the kc wrapper: a function runs in a
  # subshell, and killing that would leave the real forward holding the port.
  kubectl --context "$PROFILE" -n "$NS" port-forward "pod/$pod" "$PORT:$cport" >/dev/null 2>"$ERRFILE" &
  FWD_PID=$!
  FWD_POD="$pod"
  # Wait for the new forward to answer before the loop judges it.
  for ((i = 0; i < STARTUP * 4; i++)); do
    kill -0 "$FWD_PID" 2>/dev/null || break
    healthy && { log "forwarding localhost:$PORT -> pod/$pod:$cport"; return 0; }
    sleep 0.25
  done
  if kill -0 "$FWD_PID" 2>/dev/null; then
    log "forward to pod/$pod did not answer within ${STARTUP}s: $(tail -n 2 "$ERRFILE" | tr '\n' ' ')"
  else
    log "forward to pod/$pod exited: $(tail -n 2 "$ERRFILE" | tr '\n' ' ')"
  fi
  stop_forward
  return 1
}

while true; do
  if [[ -z "$FWD_PID" ]]; then
    start_forward || sleep "$INTERVAL"
    continue
  fi
  reason=""
  if ! kill -0 "$FWD_PID" 2>/dev/null; then
    reason="the forward process exited: $(tail -n 2 "$ERRFILE" | tr '\n' ' ')"
  elif ! endpoint_pods | grep -qx "$FWD_POD"; then
    reason="pod/$FWD_POD is no longer a ready endpoint of svc/$SVC"
  elif ! healthy; then
    reason="localhost:$PORT stopped answering"
  fi
  if [[ -n "$reason" ]]; then
    log "recycling: $reason"
    stop_forward
    continue
  fi
  sleep "$INTERVAL"
done
