/**
 * deploy/k8s-local/verify-turns.sh against a stubbed kubectl and minikube.
 * Nothing here touches a cluster. The scenarios are the ones that used to end in
 * an unexplained exit: a probe that answers with something that is not JSON, a
 * probe whose exec fails, no running gateway. Each must say which probe and what
 * it received, on stdout AND in the named log file.
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// each run waits out several 1 s probe timeouts
setDefaultTimeout(60000);

const script = new URL("../../deploy/k8s-local/verify-turns.sh", import.meta.url).pathname;
let dir = "";

function freshDir() {
  dir = mkdtempSync(join(tmpdir(), "verify-turns-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "kubectl"),
    `#!/usr/bin/env bash
echo "$*" >>"$STUB_DIR/calls.log"
args="$*"
case "$args" in
  *"get hpa"*minReplicas*) echo 2 ;;
  *"get hpa"*"jsonpath={.spec.maxReplicas}"*) echo 3 ;;
  *"get hpa"*original-max-replicas*) ;;
  *"patch hpa"*) ;;
  *"deploy slaude-gateway"*readyReplicas*) echo 2 ;;
  *"deploy slaude-node"*readyReplicas*) echo "\${STUB_NODE_READY:-2}" ;;
  *"component=gateway"*"-o name"*) [[ -n "\${STUB_NO_GATEWAY:-}" ]] || echo pod/gw-1 ;;
  *"component=node-finance"*"-o name"*) [[ -n "\${STUB_FINANCE_SCALED:-}" && -f "$STUB_DIR/scaled0" ]] || echo pod/fin-1 ;;
  *"component=node"*"-o name"*) printf 'pod/node-1\\npod/node-2\\n' ;;
  *"deploy slaude-node-finance"*"{.spec.replicas}"*) echo 1 ;;
  *"scale deploy slaude-node-finance --replicas=0"*) touch "$STUB_DIR/scaled0" ;;
  *"bun /tmp/probe/turns.ts token"*) printf 'hdr-STUBTOKEN.payload.sig' ;;
  *"bun /tmp/probe/node.ts"*) cat >/dev/null; echo '{"status":403,"gate":true}' ;;
  *"bun /tmp/probe/turns.ts"*)
    if [[ "\${STUB_PROBE_MODE:-}" == fail ]]; then echo "boom: connection refused" >&2; exit 1; fi
    echo "this is not json"
    ;;
  *"jsonpath={.status.containerStatuses"*) echo "docker://abc123" ;;
  *"exec -i"*) cat >/dev/null ;;
esac
exit 0
`,
  );
  writeFileSync(
    join(dir, "minikube"),
    `#!/usr/bin/env bash
if [[ -n "\${STUB_KILL_FAIL:-}" ]]; then echo "Error: No such container: abc123" >&2; exit 1; fi
exit 0
`,
  );
  chmodSync(join(dir, "kubectl"), 0o755);
  chmodSync(join(dir, "minikube"), 0o755);
  // personas.sh and vault.sh stand-ins: they record their arguments and fail
  // (a refused sync, a failed rotation), so no real helper runs in a test.
  for (const helper of ["personas.sh", "vault.sh"]) {
    writeFileSync(join(dir, helper), `#!/usr/bin/env bash\necho "${helper} $*" >>"$STUB_DIR/helpers.log"\nexit 1\n`);
    chmodSync(join(dir, helper), 0o755);
  }
}
// Every directory a run used, removed at the end.
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A run takes a few seconds; the bound only turns a hang into a failure that
// says so. Note for laptops: a host that goes to idle sleep mid-run (observed:
// a 300 s gap in the system log, CPUs powered off) makes any timed test fail,
// so run long test loops under `caffeinate -i`.
const RUN_TIMEOUT_MS = 30000;
type Run = { dir: string; code: number | null; timedOut: boolean; out: string; err: string; log: string; calls: string; helpers: string };

function runFresh(env: Record<string, string>): Run {
  freshDir();
  const d = dir;
  const r = Bun.spawnSync(["bash", script], {
    stdin: "ignore",
    timeout: RUN_TIMEOUT_MS,
    env: {
      PATH: `${d}:${process.env.PATH}`,
      STUB_DIR: d,
      VERIFY_TURNS_LOG: join(d, "run.log"),
      TURNS: "2",
      CLAIM_TIMEOUT: "1",
      RECOVER_TIMEOUT: "1",
      CRON_TIMEOUT: "1",
      POLL_FAST: "0",
      POLL_SLOW: "0",
      SETTLE_TIMEOUT: "1",
      ROTATE_TIMEOUT: "1",
      UNSERVED_TIMEOUT: "1",
      HELPER_TIMEOUT: "10",
      PERSONAS_SH: join(d, "personas.sh"),
      VAULT_SH: join(d, "vault.sh"),
      ...env,
    },
  });
  const read = (f: string) => (existsSync(join(d, f)) ? readFileSync(join(d, f), "utf8") : "");
  const run: Run = {
    dir: d,
    code: r.exitCode,
    timedOut: r.exitedDueToTimeout === true,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
    log: read("run.log"),
    calls: read("calls.log"),
    helpers: read("helpers.log"),
  };
  expect(run.timedOut, `verify-turns.sh did not finish within ${RUN_TIMEOUT_MS} ms`).toBe(false);
  return run;
}

// Tests that need the same environment share one run (the script is
// deterministic against the stubs, and each run takes seconds).
const runs = new Map<string, Run>();
function run(env: Record<string, string> = {}): Run {
  const key = JSON.stringify(Object.entries(env).sort());
  if (!runs.has(key)) runs.set(key, runFresh(env));
  return runs.get(key)!;
}

test("names its log file at the start, and the log holds what was printed", () => {
  const r = run();
  expect(r.out.split("\n")[0]).toContain(join(r.dir, "run.log"));
  expect(r.log).toContain("preconditions");
  expect(r.log).toContain("FAIL");
});

test("a probe that answers with something other than JSON says which probe and what it got", () => {
  const r = run();
  expect(r.code).not.toBe(0);
  // on stdout, not only stderr, and in the log
  for (const text of [r.out, r.log]) {
    expect(text).toContain("!!");
    expect(text).toContain("probe 'enqueue'");
    expect(text).toContain("did not return JSON");
    expect(text).toContain("this is not json");
  }
  expect(r.err).not.toContain("this is not json");
  // and the assertion that depended on it is reported as unmeasured, pointing at the log
  expect(r.out).toContain("COULD NOT MEASURE");
});

test("a probe whose exec fails is reported on stdout with its exit status and output", () => {
  const r = run({ STUB_PROBE_MODE: "fail" });
  expect(r.code).not.toBe(0);
  for (const text of [r.out, r.log]) {
    expect(text).toContain("!! probe enqueue failed (exit 1) on gw-1");
    expect(text).toContain("connection refused");
  }
});

test("the HPA is pinned for the run and restored on the way out, even when the run fails", () => {
  const r = run();
  expect(r.code).not.toBe(0);
  const patches = r.calls.split("\n").filter((l) => l.includes("patch hpa"));
  expect(patches).toHaveLength(2);
  expect(patches[0]).toContain('"maxReplicas":2');
  expect(patches[1]).toContain('"maxReplicas":3');
});

test("cleanup with no running gateway says so instead of silently doing nothing", () => {
  const r = run({ STUB_NO_GATEWAY: "1" });
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("no running gateway pod");
  expect(r.log).toContain("no running gateway pod");
});

test("a failing cron trigger is a failure, not an ignored one", () => {
  const r = run({ STUB_PROBE_MODE: "fail" });
  expect(r.out).toMatch(/FAIL .*cron/);
});

test("it waits for the node deployment to settle at two after pinning, and says when it did not", () => {
  const r = run({ STUB_NODE_READY: "3" });
  expect(r.out).toContain("node deployment did not settle at two replicas within 1s");
  expect(r.log).toContain("did not settle");
});

test("the label sections report COULD NOT MEASURE when their probes cannot answer, never a zero", () => {
  const r = run();
  expect(r.out).toContain("node labels: a finance persona's turns run on finance nodes only");
  expect(r.out).toMatch(/FAIL\s+beta resolves to label finance .* COULD NOT MEASURE/);
  expect(r.out).toContain("finance routing — COULD NOT MEASURE");
  expect(r.out).toContain("provider rotation — COULD NOT MEASURE");
});

test("a job token reaches the node probe on stdin and is never logged or printed", () => {
  const r = run();
  // The stub node probe answers 403 with the gate flag: the default-node check passes on it.
  expect(r.out).toContain("PASS  a default node is refused beta's bundle (403)");
  expect(r.out + r.log).not.toContain("STUBTOKEN");
  expect(r.calls).not.toContain("STUBTOKEN");
});

test("stopping the finance nodes is undone on exit, even when the run fails", () => {
  const r = run();
  expect(r.code).not.toBe(0);
  const scales = r.calls.split("\n").filter((l) => l.includes("scale deploy slaude-node-finance"));
  expect(scales[0]).toContain("--replicas=0");
  expect(scales.at(-1)).toContain("--replicas=1");
});

test("the relabel step goes through personas.sh, bounded, and reports a refused sync as a failure", () => {
  const r = run();
  expect(r.helpers).toContain("personas.sh sync --relabel beta=default");
  expect(r.out).toContain("relabel — could not sync beta onto default");
});

test("every kubectl call carries a request timeout", () => {
  const r = run();
  for (const line of r.calls.split("\n").filter(Boolean)) expect(line).toContain("--request-timeout=");
});

test("a failed container kill reports the reason instead of discarding it", () => {
  const r = run({ STUB_KILL_FAIL: "1" });
  expect(r.out).toContain("could not kill");
  expect(r.out).toContain("No such container: abc123");
  expect(r.log).toContain("No such container: abc123");
});
