#!/usr/bin/env bash
# One command for the HA end-to-end suite: guard, bring the stack up when needed, run the
# cluster cases, collect diagnostics on failure, exit with the tests' status.
#
#   scripts/e2e-ha.sh [test-file...]     default: every e2e/ha/*.e2e.ts
#
# Environment:
#   SLAUDE_LOCAL_PROFILE  minikube profile; must match /^slaude-e2e/ (default slaude-e2e)
#   E2E_ARTIFACTS         diagnostics directory on failure (default dist/e2e-artifacts)
#   E2E_FORCE_UP=1        run e2e/up.sh even when every deployment is already Ready. Without it
#                         the bring-up is skipped when the cluster is Ready, so an iteration loop
#                         stays fast. up.sh rebuilds the images and rolls gateway and node.
#   E2E_SANITY=1          run deploy/k8s-local/verify-ha.sh and verify-turns.sh first, against the
#                         e2e profile. RISK: both SIGKILL gateway/node containers and verify-ha
#                         deletes pods; the stack recovers by itself, but run them only on a cluster
#                         you can afford to disturb (the workflow does; they take several minutes).
#                         They are not run by default.
#   E2E_TEARDOWN=1        afterwards run deploy/k8s-local/down.sh for this profile. Refused unless
#                         the profile matches /^slaude-e2e/. Off by default.
#
# Never touches any other minikube profile. If another profile is Running it refuses and prints
# the command for you to run: the suite leaves a `claude` process (~150-200 MB) per case on a node,
# and two running VMs starve it. No credentials are read or printed; secrets are never dumped.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2
PROFILE="${SLAUDE_LOCAL_PROFILE:-slaude-e2e}"
NS="slaude-scale"
ARTIFACTS="${E2E_ARTIFACTS:-dist/e2e-artifacts}"
export SLAUDE_LOCAL_PROFILE="$PROFILE"

die() { printf 'e2e-ha: %s\n' "$*" >&2; exit 2; }
k() { kubectl --context "$PROFILE" -n "$NS" "$@"; }

[[ "$PROFILE" =~ ^slaude-e2e ]] || die "profile '$PROFILE' does not match /^slaude-e2e/; refusing to touch it"
for tool in minikube kubectl bun curl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
done

# --- guard: no other minikube profile may be Running ---------------------------------------------
running_others="$(minikube profile list -o json 2>/dev/null | bun -e '
  const raw = await Bun.stdin.text();
  const list = JSON.parse(raw || "{\"valid\":[]}").valid ?? [];
  const probe = (n) => Bun.spawnSync(["minikube", "-p", n, "status", "--format", "{{.Host}}"]).stdout.toString().trim();
  for (const p of list) if (p.Name !== process.argv[1] && probe(p.Name) === "Running") console.log(p.Name);
' "$PROFILE")"
if [[ -n "$running_others" ]]; then
  printf 'e2e-ha: another minikube profile is Running; the suite needs the memory. Stop it yourself:\n' >&2
  while read -r other; do printf '  minikube stop -p %s\n' "$other" >&2; done <<<"$running_others"
  exit 2
fi

# --- free VM memory ------------------------------------------------------------------------------
if minikube -p "$PROFILE" status --format '{{.Host}}' 2>/dev/null | grep -q Running; then
  printf 'e2e-ha: free VM memory (MB, available): %s\n' \
    "$(minikube -p "$PROFILE" ssh -- "free -m | awk 'NR==2{print \$7}'" 2>/dev/null | tr -d '\r')"
fi

# --- bring-up only when something is not Ready ---------------------------------------------------
cluster_ready() {
  local out want
  want="slaude-gateway slaude-node mock-llm fake-slack dev-redis dev-postgres"
  # shellcheck disable=SC2086
  out="$(k get deploy $want -o jsonpath='{range .items[*]}{.status.readyReplicas}/{.spec.replicas} {end}' 2>/dev/null)" || return 1
  [[ -n "$out" ]] || return 1
  local pair
  for pair in $out; do
    [[ "${pair%/*}" == "${pair#*/}" && "${pair%/*}" != "" && "${pair%/*}" != "0" ]] || return 1
  done
  return 0
}

if [[ "${E2E_FORCE_UP:-}" == "1" ]] || ! cluster_ready; then
  echo "e2e-ha: bringing the stack up (e2e/up.sh)"
  "$ROOT/e2e/up.sh" || die "e2e/up.sh failed"
else
  echo "e2e-ha: cluster Ready, skipping bring-up (E2E_FORCE_UP=1 to force)"
fi

status=0

if [[ "${E2E_SANITY:-}" == "1" ]]; then
  echo "e2e-ha: cluster sanity (verify-ha.sh, verify-turns.sh)"
  "$ROOT/deploy/k8s-local/verify-ha.sh" || status=$?
  if ((status == 0)); then "$ROOT/deploy/k8s-local/verify-turns.sh" || status=$?; fi
  ((status == 0)) || echo "e2e-ha: sanity checks failed (exit $status); not running the cases"
fi

# --- the cases -----------------------------------------------------------------------------------
files=("$@")
if ((${#files[@]} == 0)); then
  shopt -s nullglob
  for f in e2e/ha/*.e2e.ts; do files+=("./$f"); done
  shopt -u nullglob
fi
for i in "${!files[@]}"; do
  case "${files[$i]}" in /* | ./*) ;; *) files[i]="./${files[$i]}" ;; esac
done

if ((status == 0)); then
  if ((${#files[@]} == 0)); then die "no e2e/ha/*.e2e.ts files found"; fi
  printf 'e2e-ha: running %s\n' "${files[*]}"
  bun test "${files[@]}" --timeout 300000
  status=$?
fi

# --- diagnostics on failure ----------------------------------------------------------------------
collect_artifacts() {
  local dir="$ARTIFACTS" pf_pids=() sel="app.kubernetes.io/name=slaude" comp
  rm -rf "$dir" && mkdir -p "$dir"
  echo "e2e-ha: collecting diagnostics into $dir"
  k get pods -o wide >"$dir/pods.txt" 2>&1
  # describe only pods that are not Ready; describe prints events and spec, never Secret values
  k get pods --no-headers 2>/dev/null | awk '{split($2,a,"/"); if (a[1]!=a[2] || $3!="Running") print $1}' |
    while read -r pod; do k describe pod "$pod" >"$dir/describe-$pod.txt" 2>&1; done
  for comp in gateway node; do
    k logs -l "$sel,app.kubernetes.io/component=$comp" --all-containers --prefix --tail=-1 --max-log-requests=10 >"$dir/logs-$comp.txt" 2>&1
  done
  for comp in mock-llm fake-slack; do
    k logs "deploy/$comp" --all-containers --prefix --tail=-1 >"$dir/logs-$comp.txt" 2>&1
  done

  local mock_port=$((20000 + RANDOM % 20000)) fake_port=$((40000 + RANDOM % 20000))
  k port-forward svc/mock-llm "$mock_port:8080" >/dev/null 2>&1 & pf_pids+=($!)
  k port-forward svc/fake-slack "$fake_port:8080" >/dev/null 2>&1 & pf_pids+=($!)
  local i
  for i in $(seq 1 40); do
    if curl -fsS -m 1 "http://127.0.0.1:$mock_port/__mock/journal" >/dev/null 2>&1 &&
      curl -fsS -m 1 "http://127.0.0.1:$fake_port/healthz" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  curl -sS -m 10 "http://127.0.0.1:$mock_port/__mock/journal" >"$dir/mock-journal.json" 2>&1
  curl -sS -m 10 "http://127.0.0.1:$fake_port/__fake/calls" >"$dir/fake-calls.json" 2>&1
  # the fake has no channel listing; every channel a call mentioned is read back
  local channels ch
  channels="$(bun -e '
    const calls = JSON.parse(await Bun.file(process.argv[1]).text()).calls ?? [];
    const ids = new Set();
    for (const c of calls) {
      const v = c.args?.channel ?? c.detail?.channel;
      if (typeof v === "string" && /^[A-Za-z0-9_-]+$/.test(v)) ids.add(v);
    }
    console.log([...ids].join("\n"));
  ' "$dir/fake-calls.json" 2>/dev/null)"
  while read -r ch; do
    [[ -n "$ch" ]] || continue
    curl -sS -m 10 "http://127.0.0.1:$fake_port/__fake/messages?channel=$ch" >"$dir/fake-messages-$ch.json" 2>&1
  done <<<"$channels"
  for i in "${pf_pids[@]}"; do kill "$i" 2>/dev/null; done
  wait 2>/dev/null
  echo "e2e-ha: artifacts: $(find "$dir" -type f | wc -l | tr -d ' ') files in $dir"
}

if ((status != 0)); then collect_artifacts; fi

# --- teardown (opt-in) ---------------------------------------------------------------------------
if [[ "${E2E_TEARDOWN:-}" == "1" ]]; then
  if [[ "$PROFILE" =~ ^slaude-e2e ]]; then
    echo "e2e-ha: tearing down profile $PROFILE"
    SLAUDE_LOCAL_PROFILE="$PROFILE" "$ROOT/deploy/k8s-local/down.sh" || echo "e2e-ha: down.sh failed" >&2
  else
    echo "e2e-ha: refusing teardown for profile $PROFILE" >&2
  fi
fi

exit "$status"
