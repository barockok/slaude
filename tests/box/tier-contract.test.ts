/**
 * The sandbox contract, on a real tier. ONE file for both tiers: what a box
 * guarantees does not depend on how it is made.
 *
 * Gated on SLAUDE_BOX_TEST_TIER=gvisor|bwrap and skipped otherwise, like the
 * Redis-gated suites. It needs Linux, root, the tier's runtime (runsc or
 * bwrap), and two things prepared beforehand (scripts/smoke/box-smoke.sh does
 * both):
 *
 *   SLAUDE_BOX_TEST_LAYOUT    an OCI layout of a box image (scripts/smoke/box/Dockerfile)
 *   SLAUDE_BOX_TEST_INIT_DIR  a directory holding the compiled box-init
 *
 * The supervisor runs in this process with its real backends. Nothing here
 * talks to a model.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoxdClient, type BoxProcess } from "../../src/box/boxd/client";
import { createBoxd, defaultCgroupRoot, delegateCgroup, type Boxd } from "../../src/box/boxd/server";
import { makeSupervisedDriver, type SupervisedDriver } from "../../src/box/drivers/supervised";
import { BOX_CREDENTIAL_PLACEHOLDER } from "../../src/box/env";
import { BOX_AGENT_UID, cliImageRunner, makeImageStore } from "../../src/box/image";
import { defaultBoxPolicy, type BoxPolicy } from "../../src/box/policy";
import type { BoxSpec, SessionSandbox } from "../../src/box/sandbox";
import { BootFailure } from "../../src/gateway/core/failure-codes";

const TIER = process.env.SLAUDE_BOX_TEST_TIER;
const armed = (TIER === "gvisor" || TIER === "bwrap") && process.platform === "linux";
const tier = (TIER === "bwrap" ? "bwrap" : "gvisor") as "gvisor" | "bwrap";
/** What the host says about the sandboxes' cgroups, printed when the memory limit did not hold (a hosted runner failed it once). */
function memoryDiagnostic(): void {
  const read = (f: string) => {
    try {
      return readFileSync(f, "utf8").trim().replace(/\s+/g, " ").slice(0, 200);
    } catch (e) {
      return `(${e instanceof Error ? e.message.slice(0, 60) : "unreadable"})`;
    }
  };
  const root = defaultCgroupRoot();
  const lines = [`[diag] cgroup root ${root}; controllers ${read(join(root, "cgroup.controllers"))}; subtree ${read(join(root, "cgroup.subtree_control"))}`];
  lines.push(`[diag] ${read("/proc/version").slice(0, 90)}; swaps ${read("/proc/swaps")}; ${read("/proc/meminfo").slice(0, 120)}`);
  try {
    for (const dir of readdirSync(root).filter((n) => n.startsWith("slaude-box-"))) {
      const c = join(root, dir);
      lines.push(`[diag] ${dir}: memory.max=${read(join(c, "memory.max"))} swap.max=${read(join(c, "memory.swap.max"))} current=${read(join(c, "memory.current"))} peak=${read(join(c, "memory.peak"))} events=${read(join(c, "memory.events"))} procs=${read(join(c, "cgroup.procs")).split(" ").length}`);
    }
  } catch (e) {
    lines.push(`[diag] no box cgroups listed: ${e instanceof Error ? e.message.slice(0, 80) : ""}`);
  }
  console.log(lines.join("\n"));
}

const d = describe.skipIf(!armed);

const REAL = "real-provider-credential-for-the-tier-contract";
const NODE_SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: REAL,
  SLAUDE_NODE_TOKEN: "node-token-value-must-not-enter-a-box",
  SLAUDE_REDIS_URL: "redis://:redis-password-must-not-enter@redis.internal.example:6379",
  SLAUDE_S3_SECRET_ACCESS_KEY: "s3-secret-must-not-enter-a-box",
  SLAUDE_MASTER_KEY: "master-key-must-not-enter-a-box",
  GITHUB_TOKEN: "code-host-token-must-not-enter-a-box",
};

let root: string;
let boxDir: string;
let boxd: Boxd;
let client: BoxdClient;
let driver: SupervisedDriver;
let digest = "";
let upstream: ReturnType<typeof Bun.serve>;
const upstreamSeen: Array<Record<string, string>> = [];
let egress = { allow: [] as string[], deny: [] as string[] };
const SH = "/bin/sh";

d(`the sandbox contract on tier ${tier}`, () => {
  beforeAll(async () => {
    const layout = process.env.SLAUDE_BOX_TEST_LAYOUT;
    const initDir = process.env.SLAUDE_BOX_TEST_INIT_DIR;
    if (!layout || !initDir) throw new Error("SLAUDE_BOX_TEST_LAYOUT and SLAUDE_BOX_TEST_INIT_DIR must be set (see scripts/smoke/box-smoke.sh)");
    if (process.getuid?.() !== 0) throw new Error("the tier-gated suite needs root");
    // What the supervisor's entry point does first: in a container with its own cgroup namespace no sandbox can be
    // given a limited cgroup until the container's processes are moved aside. A no-op on a plain host.
    const cg = delegateCgroup();
    if (cg) throw new Error(`cgroup delegation failed: ${cg}`);
    // On the machine's own disk (never a container's overlay: the bwrap tier mounts an overlay on it), and short: a
    // Unix socket path has about 100 bytes.
    root = mkdtempSync(join(process.env.SLAUDE_BOX_TEST_WORKDIR || "/var/tmp", "sbt-"));
    chmodSync(root, 0o755);
    boxDir = join(root, "box");
    for (const p of [boxDir, join(root, "data"), join(root, "run")]) mkdirSync(p, { recursive: true });
    const images = makeImageStore({ dir: boxDir, runner: cliImageRunner(), budgetMb: 0, log: () => {} });
    digest = (await images.importLayout(layout)).digest;
    boxd = createBoxd({ boxDir, socketPath: join(root, "run", "boxd.sock"), mountRoots: [join(root, "data")], roRoots: [], initDir, agentUid: BOX_AGENT_UID, tier, log: () => {} });
    await boxd.listen();
    client = new BoxdClient({ socketPath: join(root, "run", "boxd.sock") });
    upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (upstreamSeen.push(Object.fromEntries(req.headers)), new Response("the provider answered")) });
    driver = makeSupervisedDriver(tier, {
      client,
      boxDir,
      egressRules: () => egress,
      provider: () => ({ baseUrl: `http://127.0.0.1:${upstream.port}`, form: "api-key", credential: REAL }),
      refuseHosts: ["gateway.internal.example"],
      // The tests drive a shell where a session would drive the CLI.
      allowedCommands: () => [SH],
      log: () => {},
    });
  }, 300_000);

  afterAll(async () => {
    client?.close();
    await boxd?.close();
    upstream?.stop(true);
    if (root) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (e) {
        console.error(`the test directory ${root} could not be removed: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    }
  }, 120_000);

  const dirs = (name: string) => {
    const ws = join(root, "data", name, "ws");
    const config = join(root, "data", name, "config");
    const scratch = join(root, "data", name, "scratch");
    for (const p of [ws, config, scratch]) mkdirSync(p, { recursive: true });
    return { ws, config, scratch, home: join(boxDir, "sessions", name, "home") };
  };

  const spec = (name: string, policy: Partial<BoxPolicy["resources"]> = {}): BoxSpec => {
    const p = dirs(name);
    const base = defaultBoxPolicy();
    return {
      sessionId: name,
      tenantId: "default",
      persona: "default",
      digest,
      policy: { ...base, resources: { ...base.resources, memoryMb: 1024, pids: 256, rootOverlayMb: 256, ...policy } },
      mounts: [
        { source: p.home, target: "/home/agent", mode: "rw" },
        { source: p.ws, target: p.ws, mode: "rw" },
        { source: p.config, target: p.config, mode: "rw" },
        { source: p.scratch, target: p.scratch, mode: "rw" },
      ],
      cwd: p.ws,
      configDir: p.config,
      scratchDir: p.scratch,
    };
  };

  /** Run a shell command in a sandbox the way the CLI would be run: through the driver's spawn, with a node's environment as the SDK's. */
  const sh = (sb: SessionSandbox, s: BoxSpec, script: string, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ code: number | null; out: string; err: string; ms: number }> =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const p = sb.spawn({ command: SH, args: ["-c", script], cwd: s.cwd, env: { ...NODE_SECRETS, CLAUDE_CONFIG_DIR: s.configDir!, PATH: "/node/path" }, signal: o.signal ?? new AbortController().signal }) as unknown as BoxProcess;
      let out = "";
      let err = "";
      p.stdout.on("data", (c: Buffer) => (out += c.toString()));
      p.stderr.on("data", (c: Buffer) => (err += c.toString()));
      const timer = setTimeout(() => p.kill("SIGKILL"), o.timeoutMs ?? 60_000);
      p.once("exit", (code: number | null) => {
        clearTimeout(timer);
        setTimeout(() => resolve({ code, out, err, ms: Date.now() - t0 }), 20);
      });
    });

  let a: SessionSandbox;
  let aSpec: BoxSpec;

  test("start, exec, stats: the process is the agent user in the image, at the session's working directory", async () => {
    aSpec = spec("a");
    a = driver.create(aSpec);
    await a.start();
    expect(a.tier).toBe(tier);
    const r = await sh(a, aSpec, "id -u; id -g; pwd; echo $HOME; cat /etc/os-release | head -1; cat /home/agent/.box-seed; echo $PATH");
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines[0]).toBe(String(BOX_AGENT_UID));
    expect(lines[1]).toBe(String(BOX_AGENT_UID));
    expect(lines[2]).toBe(aSpec.cwd);
    expect(lines[3]).toBe("/home/agent");
    expect(lines[4]).toContain("Debian");
    expect(lines[5]).toBe("seeded from the image");
    // The image's own search path, not the node's and not a default.
    expect(lines[6]).toBe("/opt/box-smoke/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    const st = await a.stats();
    expect(st.memoryBytes).toBeGreaterThan(0);
  }, 120_000);

  test("no capability, and no way to gain one", async () => {
    const r = await sh(a, aSpec, "grep -E 'CapEff|CapPrm|NoNewPrivs' /proc/self/status; if mount -t tmpfs none /mnt 2>/dev/null; then echo MOUNTED; else echo mount-refused; fi; if echo x > /usr/local/x 2>/dev/null; then echo WROTE-SYSTEM; else echo system-dir-refused; fi");
    expect(r.out).toMatch(/CapEff:\s+0000000000000000/);
    expect(r.out).toMatch(/CapPrm:\s+0000000000000000/);
    expect(r.out).toMatch(/NoNewPrivs:\s+1/);
    expect(r.out).toContain("mount-refused");
    // gVisor: the agent user owns its home and nothing of the system, so a system directory is not writable at all.
    // bwrap: the image's files belong to the supervisor's uid, which IS the agent's inside the box's user namespace, so
    // the agent may write them (into the throwaway overlay, never into the image: see the stop and start test).
    expect(r.out).toContain(tier === "gvisor" ? "system-dir-refused" : "WROTE-SYSTEM");
  }, 60_000);

  test.skipIf(tier !== "bwrap")("bwrap: the seccomp filter is loaded (a call that needs no privilege is still refused)", async () => {
    // keyctl(KEYCTL_GET_KEYRING_ID, ...) needs no capability: without the filter it answers with a key error, with
    // it EPERM. gVisor has no such filter: its sandbox does not hand system calls to the host kernel at all.
    const r = await sh(a, aSpec, `nr=$( [ "$(uname -m)" = x86_64 ] && echo 250 || echo 219 ); perl -e '$r = syscall($ARGV[0], 0, -3, 0, 0, 0); print "keyctl=$r errno=", $!+0, "\\n"' $nr; grep Seccomp: /proc/self/status`);
    expect(r.out).toContain("keyctl=-1 errno=1\n");
    expect(r.out).toMatch(/Seccomp:\s+2/);
  }, 60_000);

  test("the environment and every process's environ hold no credential of the node", async () => {
    const r = await sh(a, aSpec, "env; echo ---; for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' < $f 2>/dev/null; done; echo ---; cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' '");
    expect(r.code).toBe(0);
    for (const v of Object.values(NODE_SECRETS)) expect(r.out).not.toContain(v);
    expect(r.out).toContain(`ANTHROPIC_API_KEY=${BOX_CREDENTIAL_PLACEHOLDER}`);
    expect(r.out).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:3129");
    expect(r.out).toContain("HTTPS_PROXY=http://127.0.0.1:3128");
    expect(r.out).not.toContain("SLAUDE_NODE_TOKEN");
    expect(r.out).not.toContain("SLAUDE_REDIS_URL");
    expect(r.out).not.toContain("/node/path");
    // And nothing of them is written where a box can read it.
    const files = await sh(a, aSpec, `grep -rIl -e '${REAL}' -e 'node-token-value' /run/slaude /home/agent ${aSpec.cwd} ${aSpec.configDir} 2>/dev/null | head -5; echo done`);
    expect(files.out.trim()).toBe("done");
  }, 60_000);

  test("there is no network: a direct connection has no route", async () => {
    const r = await sh(a, aSpec, "curl -sS --noproxy '*' -m 8 -o /dev/null -w 'http=%{http_code}' https://example.com 2>&1; echo; curl -sS --noproxy '*' -m 8 -o /dev/null http://93.184.216.34/ 2>&1; echo rc=$?");
    expect(r.out).not.toContain("http=200");
    expect(r.out).toMatch(/Could not resolve|unreachable|Couldn't connect|Failed to connect|timed out/i);
    expect(r.out).not.toContain("rc=0");
  }, 60_000);

  test("through the proxy, a host that is not on the allowlist gets the 403 and its one sentence", async () => {
    egress = { allow: [], deny: [] };
    const plain = await sh(a, aSpec, "curl -sS -m 10 -w '\\nhttp=%{http_code}' http://not-on-the-list.example.com/ 2>&1");
    expect(plain.out).toContain("http=403");
    expect(plain.out).toContain("not-on-the-list.example.com is not on this box's allowlist");
    const tls = await sh(a, aSpec, "curl -sS -m 10 -o /dev/null -w 'http=%{http_code}' https://not-on-the-list.example.com/ 2>&1; rc=$?; echo; echo rc=$rc");
    expect(tls.out).toMatch(/403/);
    expect(tls.out).not.toContain("rc=0");
  }, 60_000);

  test("the node's own services and private addresses are refused even when the list allows them", async () => {
    egress = { allow: ["gateway.internal.example:*", "127.0.0.1:*", "169.254.169.254"], deny: [] };
    const r = await sh(
      a,
      aSpec,
      `curl -sS -m 10 -o /dev/null -w 'gw=%{http_code}\\n' http://gateway.internal.example:8080/v1/health 2>&1; curl -sS -m 10 -o /dev/null -w 'loop=%{http_code}\\n' --noproxy '' -x http://127.0.0.1:3128 http://127.0.0.1:${upstream.port}/ 2>&1; curl -sS -m 10 -o /dev/null -w 'meta=%{http_code}\\n' http://169.254.169.254/latest/meta-data/ 2>&1`,
    );
    expect(r.out).toContain("gw=403");
    expect(r.out).toContain("loop=403");
    expect(r.out).toContain("meta=403");
    egress = { allow: [], deny: [] };
  }, 60_000);

  test("the provider is reached through its relay, with the real credential added outside the box", async () => {
    const before = upstreamSeen.length;
    const r = await sh(a, aSpec, "curl -sS -m 10 --noproxy '*' -H \"x-api-key: $ANTHROPIC_API_KEY\" -X POST -d '{}' $ANTHROPIC_BASE_URL/v1/messages");
    expect(r.out).toBe("the provider answered");
    expect(upstreamSeen.length).toBe(before + 1);
    expect(upstreamSeen.at(-1)!["x-api-key"]).toBe(REAL);
    expect(r.out + r.err).not.toContain(REAL);
  }, 60_000);

  test("a second sandbox cannot see the first's home or workspace", async () => {
    await sh(a, aSpec, `echo a-home-secret > /home/agent/only-a; echo a-work-secret > ${aSpec.cwd}/only-a`);
    const bSpec = spec("b");
    const b = driver.create(bSpec);
    await b.start();
    try {
      const r = await sh(b, bSpec, `ls /home/agent/only-a 2>&1; cat ${aSpec.cwd}/only-a 2>&1; ls ${join(boxDir, "sessions", "a")} 2>&1; ls ${join(root, "data")} 2>&1; echo listed`);
      expect(r.out).not.toContain("a-home-secret");
      expect(r.out).not.toContain("a-work-secret");
      expect(r.out).toMatch(/No such file or directory/);
      // The first sandbox's files are there on the node, and in the first sandbox.
      expect(readFileSync(join(boxDir, "sessions", "a", "home", "only-a"), "utf8").trim()).toBe("a-home-secret");
      expect((await sh(a, aSpec, "cat /home/agent/only-a")).out.trim()).toBe("a-home-secret");
      // And the two do not share processes.
      const ps = await sh(b, bSpec, "ps -eo args 2>/dev/null | head -40");
      expect(ps.out).not.toContain(aSpec.cwd);
    } finally {
      await b.stop("idle");
    }
  }, 120_000);

  test("a write outside home and workspace (the root overlay) is gone after stop and start; a home and a workspace write are not", async () => {
    const w = await sh(a, aSpec, `echo sys > /var/tmp/marker && echo kept > /home/agent/kept && echo work > ${aSpec.cwd}/work && cat /var/tmp/marker`);
    expect(w.out.trim()).toBe("sys");
    await a.stop("idle");
    expect(statSync(join(boxDir, "sessions", "a", "home", "kept")).isFile()).toBe(true);
    expect(existsSync(join(boxDir, "sessions", "a", "overlay"))).toBe(false);
    a = driver.create(aSpec);
    await a.start();
    const r = await sh(a, aSpec, `cat /var/tmp/marker 2>&1; cat /home/agent/kept; cat ${aSpec.cwd}/work`);
    expect(r.out).toMatch(/No such file or directory/);
    expect(r.out).toContain("kept");
    expect(r.out).toContain("work");
    // The image itself was never written.
    const rootfs = join(boxDir, "images", digest.slice(7), "rootfs");
    expect(existsSync(join(rootfs, "var", "tmp", "marker"))).toBe(false);
  }, 120_000);

  test("what the node writes into a live workspace is seen at once, and what the box writes is readable by the node", async () => {
    writeFileSync(join(aSpec.cwd, "from-node.txt"), "staged by the node");
    const r = await sh(a, aSpec, `cat ${aSpec.cwd}/from-node.txt; echo from-box > ${aSpec.cwd}/from-box.txt`);
    expect(r.out).toBe("staged by the node");
    expect(readFileSync(join(aSpec.cwd, "from-box.txt"), "utf8").trim()).toBe("from-box");
  }, 60_000);

  test("abort ends the process and everything it started, within seconds", async () => {
    // Counted by the supervisor, not from inside: a process of a box sees only its own pid namespace. The count of a
    // process that just ended lingers for a moment (it is the cgroup's), so the idle count is the lowest of a few reads.
    const pids = async (): Promise<number> => (await a.stats()).pids;
    let baseline = await pids();
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 200));
      baseline = Math.min(baseline, await pids());
    }
    const ac = new AbortController();
    const running = sh(a, aSpec, "sleep 300 & sleep 300 & echo started; wait", { signal: ac.signal, timeoutMs: 120_000 });
    await new Promise((r) => setTimeout(r, 2_500));
    const before = await pids();
    expect(before).toBeGreaterThanOrEqual(baseline + 3);
    const t0 = Date.now();
    ac.abort();
    const r = await running;
    const took = Date.now() - t0;
    expect(r.out).toContain("started");
    expect(r.code === 0).toBe(false);
    expect(took).toBeLessThan(8_000);
    // Nothing of it is left: the count is back to idle within a few seconds.
    let after = await pids();
    for (let i = 0; i < 40 && after > baseline; i++) {
      await new Promise((res) => setTimeout(res, 250));
      after = await pids();
    }
    // A count that stays up with no process to show for it is a zombie nobody reaped: the supervisor is running as
    // pid 1 of a container without an init (bwrap leaves its ended processes for pid 1 to reap). See boxd/main.ts.
    expect(after).toBeLessThanOrEqual(baseline);
  }, 120_000);

  test("the process limit holds: a fork loop is refused, and the box still answers", async () => {
    const s = spec("pids", { pids: 48 });
    const sb = driver.create(s);
    await sb.start();
    try {
      const r = await sh(sb, s, "n=0; for i in $(seq 1 400); do (sleep 20 &) 2>/dev/null && n=$((n+1)) || break; done; echo forked=$n; sleep 1", { timeoutMs: 60_000 });
      const after = await sh(sb, s, "echo still-answers", { timeoutMs: 20_000 });
      console.log(`[tier ${tier}] fork loop under pids=48: ${JSON.stringify((r.out + r.err).trim().slice(-200))}; afterwards: ${JSON.stringify((after.out + after.err).trim().slice(0, 120))}`);
      expect(r.out).not.toContain("forked=400");
      // Refused inside: the box is not taken down by its own fork loop.
      expect(after.out).toContain("still-answers");
    } finally {
      await sb.stop("idle");
    }
  }, 120_000);

  test("the memory limit holds: a process that grows past it is ended, and the node is not", async () => {
    const s = spec("mem", { memoryMb: 128 });
    const sb = driver.create(s);
    await sb.start();
    try {
      const r = await sh(sb, s, "perl -e '$x = \"a\" x 600000000; print \"allocated=\", length($x), \"\\n\"'; echo rc=$?", { timeoutMs: 90_000 });
      if (r.out.includes("rc=0")) memoryDiagnostic(); // the limit did not hold: say what the host's cgroups looked like
      expect(r.out).not.toContain("allocated=600000000");
      expect(r.out).not.toContain("rc=0");
    } finally {
      await sb.stop("idle");
    }
  }, 180_000);

  test.skipIf(tier !== "gvisor")("the root overlay's size limit holds (gVisor; the bwrap tier's overlay has no limit of its own)", async () => {
    const s = spec("ovl", { rootOverlayMb: 32 });
    const sb = driver.create(s);
    await sb.start();
    try {
      const r = await sh(sb, s, "dd if=/dev/zero of=/var/tmp/big bs=1M count=100 2>&1 | tail -6", { timeoutMs: 90_000 });
      expect(r.out).toMatch(/No space left on device/);
    } finally {
      await sb.stop("idle");
    }
  }, 180_000);

  test("a config directory that holds a credentials file is refused at start", async () => {
    const s = spec("cred");
    writeFileSync(join(s.configDir!, ".credentials.json"), "{}");
    await expect(driver.create(s).start()).rejects.toBeInstanceOf(BootFailure);
    expect(boxd.sandboxes()).not.toContain("cred");
  }, 60_000);

  test("stop leaves no process, no overlay and no socket; the supervisor lists nothing", async () => {
    await a.stop("drain");
    expect(boxd.sandboxes()).toEqual([]);
    expect(existsSync(join(boxDir, "sessions", "a", "overlay"))).toBe(false);
    expect(existsSync(join(boxDir, "sessions", "a", "run"))).toBe(false);
    expect(existsSync(join(boxDir, "sessions", "a", "home", "kept"))).toBe(true);
  }, 60_000);
});
