#!/usr/bin/env bash
# One command for the HA end-to-end suite: guard, bring the stack up when needed, run the
# cluster cases, then (E2E_SANITY=1) the sanity scripts, collect diagnostics on failure.
# Exit status: a failed bring-up or failed cases win (the sanity scripts do not run after them);
# when the cases pass and a sanity script then fails, the exit status is that script's, non-zero.
#
#   scripts/e2e-ha.sh [test-file...]     default: every e2e/ha/*.e2e.ts
#
# Environment:
#   SLAUDE_LOCAL_PROFILE  minikube profile; must match /^slaude-e2e/ (default slaude-e2e)
#   E2E_ARTIFACTS         diagnostics directory on failure (default dist/e2e-artifacts)
#   E2E_FORCE_UP=1        run e2e/up.sh even when every deployment is already Ready. Without it
#                         the bring-up is skipped when the cluster is Ready, so an iteration loop
#                         stays fast. up.sh rebuilds the images and rolls gateway and node.
#                         A Ready cluster keeps the image and manifests it was built with, so
#                         after pulling changes to the app code (src/), deploy/ or e2e/k8s, run
#                         once with E2E_FORCE_UP=1 (or tear the e2e profile down). A cluster built
#                         from older code fails the seed on an import error; the script then
#                         prints this hint.
#   E2E_SANITY=1          run deploy/k8s-local/verify-ha.sh and verify-turns.sh AFTER the cases
#                         pass, against the e2e profile. RISK: both SIGKILL gateway/node containers
#                         and verify-ha deletes pods; the stack recovers by itself, but run them
#                         only on a cluster you can afford to disturb (the workflow does; they take
#                         several minutes). They are not run by default. verify-ha.sh leaves the
#                         tenant synced as personas as code, and the cases refuse to seed such a
#                         tenant, so the cases cannot be re-run on that cluster afterwards: bring up
#                         a fresh one (deploy/k8s-local/down.sh with this profile, then e2e/up.sh).
#                         Both profile variables the two scripts read (SLAUDE_LOCAL_PROFILE and
#                         MINIKUBE_PROFILE) are set to the e2e profile; the run is refused if a
#                         script selects a cluster through any other *PROFILE* variable.
#   E2E_DRY_RUN=1         after the guards, print what would run (with the profile variables) and
#                         exit without running the bring-up, the sanity scripts or the tests.
#   E2E_TEARDOWN=1       afterwards run deploy/k8s-local/down.sh for this profile. Refused unless
#                         the profile matches /^slaude-e2e/. Off by default.
#
# Never touches any other minikube profile. If another profile is Running it refuses and prints
# the command for you to run: the suite leaves a `claude` process (~150-200 MB) per case on a node,
# and two running VMs starve it. No credentials are read or printed; Secrets are never dumped and
# the diagnostics carry no env lists. A failed bring-up, sanity run or case all collect diagnostics.
# E2E_ARTIFACTS is deleted before use, so it must be under this repo's dist/ or the temp dir.
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
# jq strips env lists from the failure diagnostics (GitHub's ubuntu-latest runner ships it).
for tool in minikube kubectl bun curl jq; do
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

status=0

if [[ "${E2E_FORCE_UP:-}" == "1" ]] || ! cluster_ready; then
  echo "e2e-ha: bringing the stack up (e2e/up.sh)"
  if [[ "${E2E_DRY_RUN:-}" == "1" ]]; then
    echo "e2e-ha: dry run, would run: SLAUDE_LOCAL_PROFILE=$PROFILE $ROOT/e2e/up.sh"
  else
    "$ROOT/e2e/up.sh"
    status=$?
    ((status == 0)) || echo "e2e-ha: e2e/up.sh failed (exit $status); not running the cases"
  fi
else
  echo "e2e-ha: cluster Ready, skipping bring-up (E2E_FORCE_UP=1 to force)"
fi

# The sanity scripts SIGKILL containers of whatever profile they select. Each reads its profile from
# a different variable (verify-ha.sh: SLAUDE_LOCAL_PROFILE, verify-turns.sh: MINIKUBE_PROFILE), so
# BOTH are set to the e2e profile, and the run is refused if a script now selects a cluster through
# any other *PROFILE* variable (e2e/harness/verify-scripts.test.ts fails on the same condition).
SANITY_SCRIPTS=("$ROOT/deploy/k8s-local/verify-ha.sh" "$ROOT/deploy/k8s-local/verify-turns.sh")
ALLOWED_PROFILE_VARS=" MINIKUBE_PROFILE SLAUDE_LOCAL_PROFILE "
sanity_env_ok() {
  local s name
  for s in "${SANITY_SCRIPTS[@]}"; do
    while read -r name; do
      [[ -n "$name" ]] || continue
      case "$ALLOWED_PROFILE_VARS" in *" $name "*) ;; *)
        printf 'e2e-ha: %s selects a cluster through %s, which this wrapper does not set; refusing\n' "${s##*/}" "$name" >&2
        return 1 ;;
      esac
    done < <(grep -oE '\$\{[A-Z_]*PROFILE[A-Z_]*' "$s" | sed 's/^\${//' | sort -u)
  done
}

# Checked before anything runs, so a refusal never follows a finished case run.
if ((status == 0)) && [[ "${E2E_SANITY:-}" == "1" ]]; then
  sanity_env_ok || die "sanity scripts not run"
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

# When the cases' output shows the in-pod seed failing to import from the image's /app/src, the
# cluster runs an image older than this checkout (a Ready cluster skips the bring-up).
stale_image_hint() { # <cases log>
  grep -qE "Export named '[^']+' not found in module '/app/src/|Cannot find module '/app/src/" "$1" 2>/dev/null || return 0
  echo "e2e-ha: the persona seed could not import from the cluster's image (/app/src): the cluster was built"
  echo "e2e-ha: from older code. Re-run with E2E_FORCE_UP=1 to rebuild it, or tear the e2e profile down."
}

if ((status == 0)); then
  if ((${#files[@]} == 0)); then die "no e2e/ha/*.e2e.ts files found"; fi
  printf 'e2e-ha: running %s\n' "${files[*]}"
  if [[ "${E2E_DRY_RUN:-}" == "1" ]]; then
    echo "e2e-ha: dry run, would run: bun test ${files[*]} --timeout 300000"
  else
    cases_log="$(mktemp "${TMPDIR:-/tmp}/e2e-ha-cases.XXXXXX")"
    bun test "${files[@]}" --timeout 300000 2>&1 | tee "$cases_log"
    status=${PIPESTATUS[0]}
    ((status == 0)) || stale_image_hint "$cases_log"
    rm -f "$cases_log"
  fi
fi

# A sanity failure after green cases, said plainly in the job summary when there is one.
sanity_failed_summary() { # <exit status>
  echo "e2e-ha: the cases passed; the sanity checks failed (exit $1)"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "HA e2e: the cases passed; the cluster sanity scripts failed (exit $1)" >>"$GITHUB_STEP_SUMMARY"
  fi
}

# --- cluster sanity, AFTER the cases -------------------------------------------------------------
# verify-ha.sh syncs personas as code, which leaves tenant 'default' managed: the gateway then takes
# its souls from the database and ignores the SOUL.md and soul cache the cases seed (the seed
# refuses such a tenant). So the cases run first, on the never-synced tenant of a fresh cluster.
# Skipped when the cases failed, so the diagnostics show the cluster the cases left, not one the
# sanity scripts have since disturbed.
if ((status == 0)) && [[ "${E2E_SANITY:-}" == "1" ]]; then
  export MINIKUBE_PROFILE="$PROFILE" SLAUDE_LOCAL_PROFILE="$PROFILE"
  echo "e2e-ha: cluster sanity (verify-ha.sh, verify-turns.sh)"
  if [[ "${E2E_DRY_RUN:-}" == "1" ]]; then
    for s in "${SANITY_SCRIPTS[@]}"; do
      echo "e2e-ha: dry run, would run: MINIKUBE_PROFILE=$MINIKUBE_PROFILE SLAUDE_LOCAL_PROFILE=$SLAUDE_LOCAL_PROFILE $s"
    done
  else
    "${SANITY_SCRIPTS[0]}" || status=$?
    if ((status == 0)); then "${SANITY_SCRIPTS[1]}" || status=$?; fi
    ((status == 0)) || sanity_failed_summary "$status"
  fi
fi

# --- diagnostics on failure ----------------------------------------------------------------------
# The directory is deleted before use, so it must be a path we can be sure is scratch: under this
# repo's dist/ or the system temp dir, absolute after resolution, with no `..` component.
safe_artifacts_dir() {
  local d="$1" tmp="${TMPDIR:-/tmp}"
  tmp="${tmp%/}"
  [[ -n "$d" ]] || { echo "e2e-ha: E2E_ARTIFACTS is empty" >&2; return 1; }
  [[ "$d" == /* ]] || d="$ROOT/$d"
  case "/$d/" in */../*) echo "e2e-ha: E2E_ARTIFACTS must not contain '..': $d" >&2; return 1 ;; esac
  case "$d" in
    "$ROOT/dist"/* | /tmp/* | /private/tmp/* | "$tmp"/* | /var/folders/*/*/T/*) ;;
    *) echo "e2e-ha: E2E_ARTIFACTS must be under $ROOT/dist or the temp dir: $d" >&2; return 1 ;;
  esac
  [[ "$d" != "$HOME" && "$d" != "/" ]] || return 1
  ARTIFACTS="$d"
}
collect_artifacts() {
  local dir="$ARTIFACTS" pf_pids=() sel="app.kubernetes.io/name=slaude" comp
  safe_artifacts_dir "$dir" || { echo "e2e-ha: not collecting diagnostics" >&2; return; }
  dir="$ARTIFACTS"
  rm -rf "$dir" && mkdir -p "$dir"
  echo "e2e-ha: collecting diagnostics into $dir"
  k get pods -o wide >"$dir/pods.txt" 2>&1
  k get events --sort-by=.lastTimestamp >"$dir/events.txt" 2>&1
  # Pods that are not Ready, as JSON with every env list removed (literal env values can be
  # sensitive); the container statuses and conditions are what diagnose a stuck pod.
  k get pods --no-headers 2>/dev/null | awk '{split($2,a,"/"); if (a[1]!=a[2] || $3!="Running") print $1}' |
    while read -r pod; do
      k get pod "$pod" -o json 2>&1 | jq 'del(.spec.containers[]?.env, .spec.initContainers[]?.env, .metadata.managedFields)' >"$dir/pod-$pod.json" 2>&1
    done
  for comp in gateway node; do
    k logs -l "$sel,app.kubernetes.io/component=$comp" --all-containers --prefix --tail=-1 --max-log-requests=10 >"$dir/logs-$comp.txt" 2>&1
  done
  for comp in mock-llm fake-slack; do
    k logs "deploy/$comp" --all-containers --prefix --tail=-1 >"$dir/logs-$comp.txt" 2>&1
  done

  local mock_port=$((20000 + RANDOM % 20000)) fake_port=$((40000 + RANDOM % 20000))
  # kubectl itself is backgrounded (not the k() wrapper, whose subshell would take the kill and
  # leave the port-forward running)
  kubectl --context "$PROFILE" -n "$NS" port-forward svc/mock-llm "$mock_port:8080" >/dev/null 2>&1 & pf_pids+=($!)
  kubectl --context "$PROFILE" -n "$NS" port-forward svc/fake-slack "$fake_port:8080" >/dev/null 2>&1 & pf_pids+=($!)
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
  if [[ "${E2E_DRY_RUN:-}" == "1" ]]; then
    echo "e2e-ha: dry run, would run: SLAUDE_LOCAL_PROFILE=$PROFILE $ROOT/deploy/k8s-local/down.sh"
  elif [[ "$PROFILE" =~ ^slaude-e2e ]]; then
    echo "e2e-ha: tearing down profile $PROFILE"
    SLAUDE_LOCAL_PROFILE="$PROFILE" "$ROOT/deploy/k8s-local/down.sh" || echo "e2e-ha: down.sh failed" >&2
  else
    echo "e2e-ha: refusing teardown for profile $PROFILE" >&2
  fi
fi

exit "$status"
