/**
 * deploy/k8s-local/forward.sh against a stubbed kubectl. The stub's
 * `port-forward` is a real local listener, so the script's health check, pod
 * tracking and port-in-use guard run for real; only the cluster is faked.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../../deploy/k8s-local/forward.sh", import.meta.url).pathname;
let dir = "";
const procs: ReturnType<typeof Bun.spawn>[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forward-"));
  writeFileSync(join(dir, "endpoints"), "gw-a\n");
  writeFileSync(join(dir, "cport"), "8080");
  // A listener that answers 200 to anything, until killed.
  writeFileSync(
    join(dir, "listen.ts"),
    `Bun.serve({ port: Number(process.argv[2]), hostname: "127.0.0.1", fetch: () => new Response("ok") });`,
  );
  writeFileSync(
    join(dir, "kubectl"),
    `#!/usr/bin/env bash
case "$*" in
  *"get endpoints"*"ports[0]"*) cat "$STUB_DIR/cport" ;;
  *"get endpoints"*) cat "$STUB_DIR/endpoints" ;;
  *port-forward*)
    # args: ... port-forward pod/<name> <local>:<container>
    pod="\${@: -2:1}"; ports="\${@: -1}"
    if [[ -f "$STUB_DIR/pf_fail" ]]; then echo "error: lost connection to pod" >&2; exit 1; fi
    echo "$pod" >>"$STUB_DIR/forwards.log"
    echo $$ >"$STUB_DIR/pf.pid"
    exec bun "$STUB_DIR/listen.ts" "\${ports%%:*}"
    ;;
esac
`,
  );
  chmodSync(join(dir, "kubectl"), 0o755);
});
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
  try {
    process.kill(Number(readFileSync(join(dir, "pf.pid"), "utf8")));
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const env = (port: number, extra: Record<string, string> = {}) => ({
  PATH: `${dir}:${process.env.PATH}`,
  STUB_DIR: dir,
  SLAUDE_LOCAL_PORT: String(port),
  SLAUDE_FORWARD_INTERVAL: "0.2",
  SLAUDE_FORWARD_STARTUP: "10",
  ...extra,
});
const forwards = () => (existsSync(join(dir, "forwards.log")) ? readFileSync(join(dir, "forwards.log"), "utf8").trim().split("\n") : []);
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await Bun.sleep(100);
  }
  const out = existsSync(join(dir, "out.log")) ? readFileSync(join(dir, "out.log"), "utf8") : "";
  throw new Error(`timed out waiting for: ${what}\nforwards: ${forwards().join(",")}\nscript output:\n${out}`);
}
const answers = async (port: number) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
  } catch {
    return false;
  }
};

test("refuses to start on a port that is taken, before starting any forward", async () => {
  const port = await freePort();
  const holder = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("someone else") });
  try {
    const r = Bun.spawnSync(["bash", script, "gateway"], { env: env(port) });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain(`localhost:${port} is already in use`);
    expect(forwards()).toEqual([]);
  } finally {
    holder.stop(true);
  }
});

test("rejects an unknown target and a non-numeric port", () => {
  expect(Bun.spawnSync(["bash", script, "nope"], { env: env(1) }).exitCode).not.toBe(0);
  const r = Bun.spawnSync(["bash", script, "gateway"], { env: env(1, { SLAUDE_LOCAL_PORT: "abc" }) });
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("not a number");
});

test("follows its pod: rebinds when the endpoint changes, and when the forward dies", async () => {
  const port = await freePort();
  const p = Bun.spawn(["bash", "-c", `exec bash "${script}" gateway >"${dir}/out.log" 2>&1`], { env: env(port) });
  procs.push(p);

  await until(() => forwards().length === 1 && forwards()[0] === "pod/gw-a", "first forward to pod/gw-a");
  await until(() => answers(port), "the forwarded port to answer");

  // a rollout replaces the pod the forward is bound to
  writeFileSync(join(dir, "endpoints"), "gw-b\n");
  await until(() => forwards().at(-1) === "pod/gw-b", "rebind to pod/gw-b");
  await until(() => answers(port), "the new forward to answer");

  // the forward process is killed (the pod went away under it)
  const before = forwards().length;
  process.kill(Number(readFileSync(join(dir, "pf.pid"), "utf8")), "SIGKILL");
  await until(() => forwards().length > before, "a fresh forward after the kill");
  await until(() => answers(port), "the recycled forward to answer");
  expect(forwards().at(-1)).toBe("pod/gw-b");
});

test("recycles a forward that is alive but no longer answers", async () => {
  const port = await freePort();
  const p = Bun.spawn(["bash", "-c", `exec bash "${script}" gateway >"${dir}/out.log" 2>&1`], { env: env(port) });
  procs.push(p);
  // the script itself must have judged the forward healthy before it is frozen
  await until(() => existsSync(join(dir, "out.log")) && readFileSync(join(dir, "out.log"), "utf8").includes("forwarding localhost"), "the script to report the forward up");
  // freeze the listener: process alive, port open, no answers
  const pid = Number(readFileSync(join(dir, "pf.pid"), "utf8"));
  process.kill(pid, "SIGSTOP");
  try {
    await until(() => forwards().length >= 2, "a recycle after the health check failed");
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await until(() => answers(port), "the replacement forward to answer");
}, 30_000);

test("waits instead of failing when the Service has no ready endpoint yet", async () => {
  const port = await freePort();
  writeFileSync(join(dir, "endpoints"), "");
  const p = Bun.spawn(["bash", "-c", `exec bash "${script}" gateway >"${dir}/out.log" 2>&1`], { env: env(port) });
  procs.push(p);
  await Bun.sleep(600);
  expect(forwards()).toEqual([]);
  writeFileSync(join(dir, "endpoints"), "gw-a\n");
  await until(() => forwards().length === 1, "a forward once an endpoint appears");
});

test("a forward that exits at once is reported as exited, not as slow to answer", async () => {
  const port = await freePort();
  writeFileSync(join(dir, "pf_fail"), "");
  const p = Bun.spawn(["bash", "-c", `exec bash "${script}" gateway >"${dir}/out.log" 2>&1`], { env: env(port) });
  procs.push(p);
  await until(() => existsSync(join(dir, "out.log")) && readFileSync(join(dir, "out.log"), "utf8").includes("exited"), "an 'exited' report");
  const out = readFileSync(join(dir, "out.log"), "utf8");
  expect(out).toContain("lost connection to pod");
  expect(out).not.toContain("did not answer");
});
