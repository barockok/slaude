/**
 * The sandbox driver over the supervisor, without privileges: a fake backend
 * runs a "sandbox process" as a plain local process, so what is checked here
 * is the driver's own behaviour: what it refuses, what environment a boxed
 * spawn gets, what it starts and what it leaves behind. Also the mounts a
 * session's box is given.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_ENV_KEYS } from "../../src/agent/provider-env";
import { GATEWAY_ONLY_ENV_NAMES } from "../../src/config/gateway-only-env";
import { BoxdClient } from "../../src/box/boxd/client";
import { createBoxd, type Boxd, type SandboxBackend } from "../../src/box/boxd/server";
import { makeBwrapDriver } from "../../src/box/drivers/bwrap";
import { makeGvisorDriver } from "../../src/box/drivers/gvisor";
import type { ProviderRoute, SupervisedDriver } from "../../src/box/drivers/supervised";
import { BOX_CREDENTIAL_PLACEHOLDER } from "../../src/box/env";
import { defaultBoxPolicy } from "../../src/box/policy";
import { boxMounts, boxSessionSegment, buildBoxSpec } from "../../src/box/resolver";
import type { BoxSpec } from "../../src/box/sandbox";
import { BootFailure } from "../../src/gateway/core/failure-codes";
import { encodeProjectDir } from "../../src/storage/units";

const DIGEST = `sha256:${"c".repeat(64)}`;
const REAL = "real-provider-credential-0123456789";
let base: string;
let n = 0;

beforeAll(() => {
  base = realpathSync(mkdtempSync("/tmp/sbd-"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("a supervised sandbox driver", () => {
  let dir: string;
  let boxd: Boxd;
  let client: BoxdClient;
  let driver: SupervisedDriver;
  let route: ProviderRoute;
  let startFails = false;
  let created = 0;
  let upstream: ReturnType<typeof Bun.serve>;
  const seen: Array<Record<string, string>> = [];

  beforeAll(() => {
    upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push(Object.fromEntries(req.headers)), new Response("model says hi")) });
  });
  afterAll(() => upstream.stop(true));

  beforeEach(async () => {
    dir = join(base, `d${n++}`);
    for (const d of ["box", "data/ws", "data/config", "data/scratch", "init", "run"]) mkdirSync(join(dir, d), { recursive: true });
    startFails = false;
    created = 0;
    const backend: SandboxBackend = {
      tier: "gvisor",
      hostOwner: { uid: process.getuid!(), gid: process.getgid!() },
      probe: () => ({ ok: true, version: "fake" }),
      sweep() {},
      async start() {
        created++;
        if (startFails) throw new Error("the runtime said no");
      },
      exec: (_sb, req) => spawn(req.argv[0]!, req.argv.slice(1), { env: req.env, cwd: existsSync(req.cwd) ? req.cwd : "/", stdio: ["pipe", "pipe", "pipe"] }),
      signal: (_sb, _req, child, signal) => void child.kill(signal as NodeJS.Signals),
      async stop() {},
      cgroupDir: () => null,
    };
    boxd = createBoxd(
      { boxDir: join(dir, "box"), socketPath: join(dir, "run", "boxd.sock"), mountRoots: [join(dir, "data")], roRoots: [], initDir: join(dir, "init"), agentUid: process.getuid!(), tier: "gvisor", log: () => {} },
      { backends: { gvisor: backend, bwrap: { ...backend, tier: "bwrap" } }, images: { rootfsOf: () => join(dir, "rootfs"), has: () => true, digests: () => [DIGEST], importLayout: async () => ({ digest: DIGEST, image: "x", bytes: 0, pulledAt: 0, lastUsed: 0 }), remove: () => true } },
    );
    await boxd.listen();
    client = new BoxdClient({ socketPath: join(dir, "run", "boxd.sock") });
    route = { baseUrl: `http://127.0.0.1:${upstream.port}`, form: "api-key", credential: REAL };
    driver = makeGvisorDriver({
      client,
      boxDir: join(dir, "box"),
      egressRules: () => ({ allow: [], deny: [] }),
      provider: () => route,
      allowedCommands: () => ["/usr/bin/env", "/bin/sh"],
      log: () => {},
    });
  });
  afterEach(async () => {
    client.close();
    await boxd.close();
  });

  const spec = (over: Partial<BoxSpec> = {}): BoxSpec => ({
    sessionId: "sess-1",
    tenantId: "default",
    persona: "default",
    digest: DIGEST,
    policy: { ...defaultBoxPolicy(), env: { PROJECT_FLAG: "on" } },
    mounts: [
      { source: join(dir, "box", "sessions", "sess-1", "home"), target: "/home/agent", mode: "rw" },
      { source: join(dir, "data", "ws"), target: join(dir, "data", "ws"), mode: "rw" },
      { source: join(dir, "data", "config"), target: join(dir, "data", "config"), mode: "rw" },
    ],
    cwd: join(dir, "data", "ws"),
    configDir: join(dir, "data", "config"),
    scratchDir: join(dir, "data", "scratch"),
    ...over,
  });

  const output = (p: { stdout: NodeJS.ReadableStream; once: (e: "exit", l: (code: number | null) => void) => void }): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      let out = "";
      p.stdout.on("data", (d: Buffer) => (out += d.toString()));
      p.once("exit", (code) => setTimeout(() => resolve({ code, out }), 10));
    });

  test("the probe is the supervisor's answer for the driver's tier", async () => {
    expect(driver.tier).toBe("gvisor");
    expect(await driver.probe()).toEqual({ ok: true });
    expect(makeBwrapDriver({ client, boxDir: join(dir, "box"), egressRules: () => ({ allow: [], deny: [] }), provider: () => route, allowedCommands: () => [] }).tier).toBe("bwrap");
    client.close();
    const dead = makeGvisorDriver({ client: new BoxdClient({ socketPath: join(dir, "run", "nobody.sock") }), boxDir: join(dir, "box"), egressRules: () => ({ allow: [], deny: [] }), provider: () => route, allowedCommands: () => [] });
    const p = await dead.probe();
    expect(p.ok).toBe(false);
  });

  test("start refuses a config directory that holds a credentials file, before anything is started", async () => {
    writeFileSync(join(dir, "data", "config", ".credentials.json"), "{}");
    const sb = driver.create(spec());
    await expect(sb.start()).rejects.toBeInstanceOf(BootFailure);
    await expect(sb.start()).rejects.toThrow(/credential store/);
    expect(created).toBe(0);
    expect(existsSync(join(dir, "box", "sessions", "sess-1", "run"))).toBe(false);
  });

  test("start puts the two proxy sockets in the session's run directory; stop removes them", async () => {
    const sb = driver.create(spec());
    await sb.start();
    await sb.start(); // idempotent
    expect(created).toBe(1);
    const run = join(dir, "box", "sessions", "sess-1", "run");
    expect(existsSync(join(run, "egress.sock"))).toBe(true);
    expect(existsSync(join(run, "llm.sock"))).toBe(true);
    expect(driver.sessions()).toEqual(["sess-1"]);
    await sb.stop("idle");
    expect(existsSync(run)).toBe(false);
    expect(driver.sessions()).toEqual([]);
    expect(boxd.sandboxes()).toEqual([]);
  });

  test("a sandbox that does not start is a BootFailure and leaves no proxy behind", async () => {
    startFails = true;
    const sb = driver.create(spec());
    let err: unknown;
    try {
      await sb.start();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BootFailure);
    expect((err as BootFailure).code).toBe("BOX_UNAVAILABLE");
    expect(existsSync(join(dir, "box", "sessions", "sess-1", "run"))).toBe(false);
    // And spawning in it is refused: never an unboxed run.
    expect(() => sb.spawn({ command: "/usr/bin/env", args: [], env: {}, signal: new AbortController().signal })).toThrow(BootFailure);
  });

  test("a session with no provider route does not start", async () => {
    const d = makeGvisorDriver({
      client,
      boxDir: join(dir, "box"),
      egressRules: () => ({ allow: [], deny: [] }),
      provider: () => {
        throw new BootFailure("PROVIDER_CREDENTIALS_UNAVAILABLE", "no credential");
      },
      allowedCommands: () => ["/usr/bin/env"],
    });
    await expect(d.create(spec()).start()).rejects.toThrow(/no credential/);
    expect(created).toBe(0);
  });

  test("spawn runs only the agent's CLI", async () => {
    const sb = driver.create(spec());
    await sb.start();
    expect(() => sb.spawn({ command: "/bin/cat", args: ["/etc/passwd"], env: {}, signal: new AbortController().signal })).toThrow(/CLI and nothing else/);
    expect(() => sb.spawn({ command: "/usr/bin/env", args: [], env: { CLAUDE_CONFIG_DIR: "/somewhere/else" }, signal: new AbortController().signal })).toThrow(/config directory/);
    await sb.stop("idle");
  });

  test("a boxed spawn's environment holds no value of the node's: only placeholders for the provider form", async () => {
    const secret = (k: string) => `node-secret-value-of-${k}`;
    const names = [...PROVIDER_ENV_KEYS, ...GATEWAY_ONLY_ENV_NAMES, "SLAUDE_NODE_TOKEN", "SLAUDE_REDIS_URL", "SLAUDE_S3_ACCESS_KEY_ID", "SLAUDE_S3_SECRET_ACCESS_KEY", "SLAUDE_S3_ENDPOINT", "SLAUDE_BOX_REGISTRY_AUTH", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "NPM_TOKEN"];
    const sdkEnv: Record<string, string> = { PATH: "/node/own/path", HOME: "/root", CLAUDE_CONFIG_DIR: join(dir, "data", "config"), CLAUDE_CODE_ENTRYPOINT: "sdk-ts", ANTHROPIC_MODEL: "model-x" };
    for (const k of names) sdkEnv[k] = secret(k);
    const sb = driver.create(spec());
    await sb.start();
    const r = await output(sb.spawn({ command: "/usr/bin/env", args: [], env: sdkEnv, signal: new AbortController().signal }) as never);
    expect(r.code).toBe(0);
    const env = Object.fromEntries(r.out.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    for (const k of names) expect(r.out).not.toContain(secret(k));
    expect(r.out).not.toContain(REAL);
    expect(env.ANTHROPIC_API_KEY).toBe(BOX_CREDENTIAL_PLACEHOLDER);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3129");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:3128");
    expect(env.HOME).toBe("/home/agent");
    expect(env.TMPDIR).toBe(join(dir, "data", "scratch"));
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(dir, "data", "config"));
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts");
    expect(env.ANTHROPIC_MODEL).toBe("model-x");
    expect(env.PROJECT_FLAG).toBe("on");
    expect(env.PATH).not.toBe("/node/own/path");
    await sb.stop("idle");
  });

  test("the provider proxy of a started sandbox adds the real credential outside the box, and follows a rotation", async () => {
    const sb = driver.create(spec());
    await sb.start();
    const sock = join(dir, "box", "sessions", "sess-1", "run", "llm.sock");
    const call = () => fetch("http://box.invalid/v1/messages", { method: "POST", headers: { "x-api-key": BOX_CREDENTIAL_PLACEHOLDER }, body: "{}", unix: sock } as RequestInit);
    expect(await (await call()).text()).toBe("model says hi");
    expect(seen.at(-1)!["x-api-key"]).toBe(REAL);
    route = { ...route, form: "auth-token", credential: "rotated-credential-9876543210" };
    await call();
    expect(seen.at(-1)!.authorization).toBe("Bearer rotated-credential-9876543210");
    expect(seen.at(-1)!["x-api-key"]).toBeUndefined();
    await sb.stop("idle");
  });

  test("the SDK's abort signal ends the process", async () => {
    const sb = driver.create(spec());
    await sb.start();
    const ac = new AbortController();
    const p = sb.spawn({ command: "/bin/sh", args: ["-c", "sleep 60"], env: { CLAUDE_CONFIG_DIR: join(dir, "data", "config") }, signal: ac.signal });
    const exited = new Promise<void>((r) => p.once("exit", () => r()));
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    ac.abort();
    await exited;
    expect(Date.now() - t0).toBeLessThan(3_000);
    await sb.stop("idle");
  });

  test("stop ends what is still running", async () => {
    const sb = driver.create(spec());
    await sb.start();
    const p = sb.spawn({ command: "/bin/sh", args: ["-c", "sleep 60"], env: {}, signal: new AbortController().signal });
    const exited = new Promise<void>((r) => p.once("exit", () => r()));
    await new Promise((r) => setTimeout(r, 150));
    await sb.stop("evict");
    await exited;
    expect(p.exitCode === 0).toBe(false);
  });
});

describe("the mounts of a session's box", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(base, `m${n++}`);
    for (const d of ["home/workspaces/w1", "home/workspaces/other", "home/skills/s1", "home/.claude/projects", "home/.claude/plugins", "config/sess", "scratch/sess", "box/sessions/sess/home", "builtin/skills", "cli", "derived/skills", "persona-skills/p1"]) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, "home", "db.sqlite"), "x");
    symlinkSync(join(dir, "home", ".claude", "projects"), join(dir, "config", "sess", "projects"));
    symlinkSync(join(dir, "home", ".claude", "plugins"), join(dir, "config", "sess", "plugins"));
    symlinkSync(join(dir, "persona-skills", "p1"), join(dir, "derived", "skills", "p1"));
    writeFileSync(join(dir, "config", "sess", "settings.json"), "{}");
  });
  const input = () => ({
    sessionId: "sess",
    tenantId: "default",
    persona: "default",
    box: { digest: DIGEST, policy: defaultBoxPolicy() },
    homeDir: join(dir, "box", "sessions", "sess", "home"),
    cwd: join(dir, "home", "workspaces", "w1"),
    configDir: join(dir, "config", "sess"),
    scratchDir: join(dir, "scratch", "sess"),
    pluginDirs: [join(dir, "home"), join(dir, "builtin"), join(dir, "derived"), join(dir, "never-installed")],
    slaudeHome: join(dir, "home"),
    cliDir: join(dir, "cli"),
  });

  test("home, workspace, config and scratch are read-write; plugins and the CLI read-only; every path but the home is its own", () => {
    const m = boxMounts(input());
    const by = Object.fromEntries(m.map((x) => [x.target, x]));
    expect(by["/home/agent"]).toEqual({ source: join(dir, "box", "sessions", "sess", "home"), target: "/home/agent", mode: "rw" });
    for (const p of [join(dir, "home", "workspaces", "w1"), join(dir, "config", "sess"), join(dir, "scratch", "sess")]) expect(by[p]).toEqual({ source: p, target: p, mode: "rw" });
    for (const p of [join(dir, "builtin"), join(dir, "derived"), join(dir, "cli")]) expect(by[p]).toEqual({ source: p, target: p, mode: "ro" });
    expect(by[join(dir, "never-installed")]).toBeUndefined();
    for (const x of m) if (x.target !== "/home/agent") expect(x.source).toBe(x.target);
  });

  test("the slaude home is never mounted whole: its skills are, another session's workspace and its files are not", () => {
    const targets = boxMounts(input()).map((x) => x.target);
    expect(targets).not.toContain(join(dir, "home"));
    expect(targets).toContain(join(dir, "home", "skills"));
    expect(targets.some((t) => t.startsWith(join(dir, "home", "workspaces", "other")))).toBe(false);
    expect(targets.some((t) => t === join(dir, "home", "workspaces"))).toBe(false);
  });

  test("the transcript tree is not mounted whole: only this working directory's folder, read-write, created if missing", () => {
    const m = boxMounts(input());
    const mine = join(dir, "home", ".claude", "projects", encodeProjectDir(join(dir, "home", "workspaces", "w1")));
    expect(m.find((x) => x.target === mine)).toEqual({ source: mine, target: mine, mode: "rw" });
    expect(existsSync(mine)).toBe(true);
    expect(m.map((x) => x.target)).not.toContain(join(dir, "home", ".claude", "projects"));
    // The other link of the config directory (the shared plugin cache) is read-only.
    expect(m.find((x) => x.target === join(dir, "home", ".claude", "plugins"))!.mode).toBe("ro");
  });

  test("what a derived plugin directory links to is mounted read-only", () => {
    expect(boxMounts(input()).find((x) => x.target === join(dir, "persona-skills", "p1"))).toEqual({ source: join(dir, "persona-skills", "p1"), target: join(dir, "persona-skills", "p1"), mode: "ro" });
  });

  test("the spec carries the pinned digest, the policy and the two directories the driver needs", () => {
    const s = buildBoxSpec(input());
    expect(s.digest).toBe(DIGEST);
    expect(s.cwd).toBe(join(dir, "home", "workspaces", "w1"));
    expect(s.configDir).toBe(join(dir, "config", "sess"));
    expect(s.scratchDir).toBe(join(dir, "scratch", "sess"));
    expect(s.mounts.length).toBeGreaterThan(5);
  });

  test("a session id is one safe path segment, as the node's home directory names it", () => {
    expect(boxSessionSegment("5b1e6a0c-1111-4222-8333-444455556666")).toBe("5b1e6a0c-1111-4222-8333-444455556666");
    expect(boxSessionSegment("../../etc")).toMatch(/^[a-f0-9]+$/);
    expect(boxSessionSegment("a/b")).toMatch(/^[a-f0-9]+$/);
  });
});
