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

// each run waits out several 1 s probe timeouts, and may be repeated once
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
// Every directory a run used, removed at the end (an abandoned run may still
// be writing to its own).
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A run normally takes a few seconds. On some hosts the OS occasionally stalls
// the creation of a process for about 300 s: a bare loop that writes a stub and
// runs it 3750 times showed one such stall, with no slaude code involved. A
// process stuck there cannot be signalled until it is released, so the run is
// started asynchronously, abandoned after RUN_TIMEOUT_MS (it keeps running in
// its own temporary directory), and repeated once in a fresh directory.
const RUN_TIMEOUT_MS = 20000;
type Run = { dir: string; code: number | null; timedOut: boolean; out: string; err: string; log: string; calls: string; helpers: string };

async function runOnce(env: Record<string, string>): Promise<Run> {
  const d = dir;
  const proc = Bun.spawn(["bash", "-c", 'exec bash "$0" >"$1" 2>"$2"', script, join(d, "out.txt"), join(d, "err.txt")], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      STUB_DIR: dir,
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([
    proc.exited,
    new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), RUN_TIMEOUT_MS))),
  ]);
  clearTimeout(timer);
  if (code === null) proc.kill(9);
  const read = (f: string) => (existsSync(join(d, f)) ? readFileSync(join(d, f), "utf8") : "");
  return {
    dir: d,
    code,
    timedOut: code === null,
    out: read("out.txt"),
    err: read("err.txt"),
    log: read("run.log"),
    calls: read("calls.log"),
    helpers: read("helpers.log"),
  };
}

// Tests that need the same environment share one run: each run launches a few
// hundred processes, and every launch is a chance of the stall above.
const runs = new Map<string, Promise<Run>>();
function run(env: Record<string, string> = {}): Promise<Run> {
  const key = JSON.stringify(Object.entries(env).sort());
  if (!runs.has(key)) runs.set(key, runFresh(env));
  return runs.get(key)!;
}

async function runFresh(env: Record<string, string>): Promise<Run> {
  freshDir();
  const first = await runOnce(env);
  if (!first.timedOut) return first;
  console.warn("[verify-turns.test] a run timed out (a stalled process launch); repeating it once in a fresh directory");
  freshDir();
  const second = await runOnce(env);
  expect(second.timedOut, "the run timed out twice").toBe(false);
  return second;
}

test("names its log file at the start, and the log holds what was printed", async () => {
  const r = await run();
  expect(r.out.split("\n")[0]).toContain(join(r.dir, "run.log"));
  expect(r.log).toContain("preconditions");
  expect(r.log).toContain("FAIL");
});

test("a probe that answers with something other than JSON says which probe and what it got", async () => {
  const r = await run();
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

test("a probe whose exec fails is reported on stdout with its exit status and output", async () => {
  const r = await run({ STUB_PROBE_MODE: "fail" });
  expect(r.code).not.toBe(0);
  for (const text of [r.out, r.log]) {
    expect(text).toContain("!! probe enqueue failed (exit 1) on gw-1");
    expect(text).toContain("connection refused");
  }
});

test("the HPA is pinned for the run and restored on the way out, even when the run fails", async () => {
  const r = await run();
  expect(r.code).not.toBe(0);
  const patches = r.calls.split("\n").filter((l) => l.includes("patch hpa"));
  expect(patches).toHaveLength(2);
  expect(patches[0]).toContain('"maxReplicas":2');
  expect(patches[1]).toContain('"maxReplicas":3');
});

test("cleanup with no running gateway says so instead of silently doing nothing", async () => {
  const r = await run({ STUB_NO_GATEWAY: "1" });
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("no running gateway pod");
  expect(r.log).toContain("no running gateway pod");
});

test("a failing cron trigger is a failure, not an ignored one", async () => {
  const r = await run({ STUB_PROBE_MODE: "fail" });
  expect(r.out).toMatch(/FAIL .*cron/);
});

test("it waits for the node deployment to settle at two after pinning, and says when it did not", async () => {
  const r = await run({ STUB_NODE_READY: "3" });
  expect(r.out).toContain("node deployment did not settle at two replicas within 1s");
  expect(r.log).toContain("did not settle");
});

test("the label sections report COULD NOT MEASURE when their probes cannot answer, never a zero", async () => {
  const r = await run();
  expect(r.out).toContain("node labels: a finance persona's turns run on finance nodes only");
  expect(r.out).toMatch(/FAIL\s+beta resolves to label finance .* COULD NOT MEASURE/);
  expect(r.out).toContain("finance routing — COULD NOT MEASURE");
  expect(r.out).toContain("provider rotation — COULD NOT MEASURE");
});

test("a job token reaches the node probe on stdin and is never logged or printed", async () => {
  const r = await run();
  // The stub node probe answers 403 with the gate flag: the default-node check passes on it.
  expect(r.out).toContain("PASS  a default node is refused beta's bundle (403)");
  expect(r.out + r.log).not.toContain("STUBTOKEN");
  expect(r.calls).not.toContain("STUBTOKEN");
});

test("stopping the finance nodes is undone on exit, even when the run fails", async () => {
  const r = await run();
  expect(r.code).not.toBe(0);
  const scales = r.calls.split("\n").filter((l) => l.includes("scale deploy slaude-node-finance"));
  expect(scales[0]).toContain("--replicas=0");
  expect(scales.at(-1)).toContain("--replicas=1");
});

test("the relabel step goes through personas.sh, bounded, and reports a refused sync as a failure", async () => {
  const r = await run();
  expect(r.helpers).toContain("personas.sh sync --relabel beta=default");
  expect(r.out).toContain("relabel — could not sync beta onto default");
});

test("every kubectl call carries a request timeout", async () => {
  const r = await run();
  for (const line of r.calls.split("\n").filter(Boolean)) expect(line).toContain("--request-timeout=");
});

test("a failed container kill reports the reason instead of discarding it", async () => {
  const r = await run({ STUB_KILL_FAIL: "1" });
  expect(r.out).toContain("could not kill");
  expect(r.out).toContain("No such container: abc123");
  expect(r.log).toContain("No such container: abc123");
});
