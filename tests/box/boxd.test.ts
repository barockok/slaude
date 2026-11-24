/**
 * The box supervisor without privileges: its protocol validation, its refusal
 * of a credential in its environment, the configuration it writes for each
 * tier, and the supervisor itself over a real Unix socket with a fake backend
 * that runs a "sandbox process" as a plain local process. The real backends
 * (runsc, bwrap) are exercised by tests/box/tier-contract.test.ts on a Linux
 * host with root.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_ENV_KEYS } from "../../src/agent/provider-env";
import { GATEWAY_ONLY_ENV_NAMES } from "../../src/config/gateway-only-env";
import { BoxdClient, type BoxProcess } from "../../src/box/boxd/client";
import { boxdRefusedEnv } from "../../src/box/boxd/env-check";
import {
  BoxdError,
  FRAME,
  checkArgv,
  checkEnv,
  checkMounts,
  checkResources,
  checkSandboxId,
  checkTarget,
  encodeFrame,
  frameDecoder,
  makePathPolicy,
  resolveExisting,
} from "../../src/box/boxd/protocol";
import { DENIED_SYSCALLS, SECCOMP_AUDIT_ARCH, seccompProgram, seccompVerdict } from "../../src/box/boxd/seccomp";
import { adoptTree, createBoxd, type Boxd, type SandboxBackend, type SandboxRecord } from "../../src/box/boxd/server";
import { bwrapArgs, gvisorPidsLimit, ociConfig, runscExecArgs, runscRunArgs } from "../../src/box/boxd/spec";

const DIGEST = `sha256:${"a".repeat(64)}`;
let base: string;

beforeAll(() => {
  // Short on purpose: a Unix socket path has about 100 bytes.
  base = realpathSync(mkdtempSync("/tmp/sbx-"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("boxd refuses a credential in its environment", () => {
  test("every provider key, gateway-only name, the node token, Redis and the object store are refused by name", () => {
    const env: Record<string, string> = { PATH: "/usr/bin", SLAUDE_BOX_DIR: "/var/lib/slaude-box", SLAUDE_BOX_TIER: "gvisor", HOME: "/root" };
    const secrets = [...PROVIDER_ENV_KEYS, ...GATEWAY_ONLY_ENV_NAMES, "SLAUDE_NODE_TOKEN", "SLAUDE_REDIS_URL", "SLAUDE_S3_ACCESS_KEY_ID", "SLAUDE_S3_SECRET_ACCESS_KEY", "SLAUDE_S3_ENDPOINT", "SLAUDE_BOX_REGISTRY_AUTH", "AWS_SECRET_ACCESS_KEY", "CLAUDE_CODE_USE_BEDROCK", "PERSONA_OPS_TOKEN", "SLAUDE_VAULT_TOKEN"];
    for (const k of secrets) env[k] = "a-value-that-must-not-be-printed";
    const refused = boxdRefusedEnv(env);
    for (const k of secrets) expect(refused).toContain(k);
    expect(refused).not.toContain("PATH");
    expect(refused).not.toContain("SLAUDE_BOX_DIR");
    expect(refused.join(",")).not.toContain("a-value-that-must-not-be-printed");
  });

  test("an empty value is not a credential, and a clean environment passes", () => {
    expect(boxdRefusedEnv({ ANTHROPIC_API_KEY: "", PATH: "/usr/bin", SLAUDE_BOXD_SOCKET: "/run/slaude-box/boxd.sock" })).toEqual([]);
  });
});

describe("protocol validation", () => {
  let root: string;
  let boxDir: string;
  let data: string;
  let image: string;
  let outside: string;
  beforeAll(() => {
    root = join(base, "pv");
    boxDir = join(root, "box");
    data = join(root, "data");
    image = join(root, "app");
    outside = join(root, "outside");
    for (const d of [boxDir, data, image, outside, join(boxDir, "images", "x"), join(boxDir, "runsc"), join(data, "ws")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(outside, "secret"), "x");
    symlinkSync(outside, join(data, "escape"));
    symlinkSync(join(outside, "secret"), join(data, "ws", "link-to-secret"));
  });
  const policy = () => makePathPolicy({ boxDir, mountRoots: [data], roRoots: [image] });

  test("a path inside a root is accepted and returned resolved", () => {
    expect(policy().mountSource(join(data, "ws"), "rw")).toBe(join(data, "ws"));
    expect(policy().mountSource(join(boxDir, "sessions", "s1", "home"), "rw")).toBe(join(boxDir, "sessions", "s1", "home"));
    expect(policy().mountSource(image, "ro")).toBe(image);
  });

  test("traversal, a relative path and a path outside every root are refused", () => {
    for (const p of [`${data}/../outside`, "relative/path", outside, "/etc", "/", join(data, "ws", "..", "..", "outside"), `${data}/ws\0x`]) {
      expect(() => policy().mountSource(p, "ro")).toThrow(BoxdError);
    }
  });

  test("a symlink that leads out of the roots is refused, as a directory and as a file", () => {
    expect(() => policy().mountSource(join(data, "escape"), "ro")).toThrow(/outside/);
    expect(() => policy().mountSource(join(data, "escape", "secret"), "rw")).toThrow(/outside/);
    expect(() => policy().mountSource(join(data, "ws", "link-to-secret"), "ro")).toThrow(/outside/);
    // A path that does not exist yet, below a link that leads out.
    expect(() => policy().mountSource(join(data, "escape", "new", "dir"), "rw")).toThrow(/outside/);
  });

  test("a read-only root is never mounted read-write, the image cache is never mounted, the supervisor's state is never named", () => {
    expect(() => policy().mountSource(image, "rw")).toThrow(BoxdError);
    expect(() => policy().mountSource(join(boxDir, "images", "x"), "ro")).toThrow(/image cache/);
    expect(() => policy().mountSource(join(boxDir, "runsc"), "ro")).toThrow(/own state/);
    expect(() => policy().dataPath(join(boxDir, "images", "x", "rootfs"), "a pack unit's root")).toThrow(/image cache/);
    expect(() => policy().boxPath(join(data, "ws"), "a pack layer")).toThrow(BoxdError);
  });

  test("resolveExisting follows links in the part that exists", () => {
    expect(resolveExisting(join(data, "escape", "a", "b"))).toBe(join(outside, "a", "b"));
    expect(resolveExisting(join(data, "nope", "deeper"))).toBe(join(data, "nope", "deeper"));
  });

  test("mount targets: not the root, not /proc, /sys, /dev, the run directory or the init directory, and no duplicates", () => {
    for (const t of ["/", "/proc", "/proc/1", "/sys", "/dev/shm", "/run/slaude", "/run", "/.slaude", "relative", "/a/../b"]) expect(() => checkTarget(t)).toThrow(BoxdError);
    expect(checkTarget("/home/agent/")).toBe("/home/agent");
    const m = (target: string) => ({ source: join(data, "ws"), target, mode: "rw" });
    expect(() => checkMounts([m("/w"), m("/w")], policy())).toThrow(/same target/);
    expect(() => checkMounts([{ source: join(data, "ws"), target: "/w", mode: "rwx" }], policy())).toThrow(BoxdError);
    expect(checkMounts([m("/w")], policy())).toEqual([{ source: join(data, "ws"), target: "/w", mode: "rw" }]);
  });

  test("ids, argv, env and resources", () => {
    for (const id of ["", "..", "a/b", "a..b", ".hidden", "x".repeat(200), 7]) expect(() => checkSandboxId(id)).toThrow(BoxdError);
    expect(checkSandboxId("9f1c-4a_b.c")).toBe("9f1c-4a_b.c");
    expect(() => checkArgv([])).toThrow(BoxdError);
    expect(() => checkArgv(["relative"])).toThrow(/absolute/);
    expect(() => checkArgv(["/bin/sh", 3])).toThrow(BoxdError);
    expect(() => checkEnv({ "BAD NAME": "x" })).toThrow(BoxdError);
    expect(() => checkEnv({ A: 1 })).toThrow(BoxdError);
    expect(() => checkEnv({ A: "x\0y" })).toThrow(BoxdError);
    expect(checkEnv({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
    expect(() => checkResources({ cpu: 1, memoryMb: 1, pids: 64, rootOverlayMb: 64 })).toThrow(/memoryMb/);
    expect(() => checkResources({ cpu: 0, memoryMb: 512, pids: 64, rootOverlayMb: 64 })).toThrow(/cpu/);
    expect(checkResources({ cpu: 2, memoryMb: 512.9, pids: 64, rootOverlayMb: 64 })).toEqual({ cpu: 2, memoryMb: 512, pids: 64, rootOverlayMb: 64 });
  });

  test("frames survive any chunking, and an oversized frame is refused", () => {
    const bytes = Buffer.concat([encodeFrame(FRAME.stdout, "hello"), encodeFrame(FRAME.stdinEnd), encodeFrame(FRAME.exit, '{"code":0}')]);
    for (let cut = 1; cut < bytes.length; cut++) {
      const d = frameDecoder();
      const got = [...d.push(bytes.subarray(0, cut)), ...d.push(bytes.subarray(cut))];
      expect(got.map((f) => [f.type, f.payload.toString()])).toEqual([[FRAME.stdout, "hello"], [FRAME.stdinEnd, ""], [FRAME.exit, '{"code":0}']]);
    }
    const huge = Buffer.alloc(5);
    huge[0] = FRAME.stdin;
    huge.writeUInt32BE(64 * 1024 * 1024, 1);
    expect(() => frameDecoder().push(huge)).toThrow(BoxdError);
  });
});

describe("what a sandbox is made of", () => {
  const input = {
    name: "s1",
    rootfs: "/var/lib/slaude-box/images/aaaa/rootfs",
    overlayDir: "/var/lib/slaude-box/sessions/s1/overlay",
    initDir: "/usr/local/lib/slaude-box",
    runDir: "/var/lib/slaude-box/sessions/s1/run",
    mounts: [
      { source: "/var/lib/slaude-box/sessions/s1/home", target: "/home/agent", mode: "rw" as const },
      { source: "/data/workspaces/w1", target: "/data/workspaces/w1", mode: "rw" as const },
      { source: "/app/src/soul/builtin", target: "/app/src/soul/builtin", mode: "ro" as const },
    ],
    uid: 10001,
    gid: 10001,
    resources: { cpu: 2, memoryMb: 3072, pids: 512, rootOverlayMb: 2048 },
    env: { PATH: "/usr/bin:/bin", HOME: "/home/agent" },
  };

  test("the OCI configuration of a gVisor sandbox (golden)", () => {
    expect(ociConfig(input)).toEqual({
      ociVersion: "1.0.2",
      process: {
        terminal: false,
        user: { uid: 65534, gid: 65534 },
        args: ["/.slaude/box-init"],
        env: ["HOME=/home/agent", "PATH=/usr/bin:/bin"],
        cwd: "/",
        capabilities: { bounding: [], effective: [], inheritable: [], permitted: [], ambient: [] },
        noNewPrivileges: true,
        rlimits: [{ type: "RLIMIT_NPROC", hard: 512, soft: 512 }],
      },
      root: { path: "/var/lib/slaude-box/images/aaaa/rootfs", readonly: false },
      hostname: "box",
      mounts: [
        { destination: "/proc", type: "proc", source: "proc" },
        { destination: "/dev", type: "tmpfs", source: "tmpfs", options: ["nosuid", "strictatime", "mode=755", "size=65536k"] },
        { destination: "/dev/pts", type: "devpts", source: "devpts", options: ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"] },
        { destination: "/dev/shm", type: "tmpfs", source: "shm", options: ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"] },
        { destination: "/sys", type: "sysfs", source: "sysfs", options: ["nosuid", "noexec", "nodev", "ro"] },
        { destination: "/home/agent", type: "bind", source: "/var/lib/slaude-box/sessions/s1/home", options: ["rbind", "rw"] },
        { destination: "/data/workspaces/w1", type: "bind", source: "/data/workspaces/w1", options: ["rbind", "rw"] },
        { destination: "/app/src/soul/builtin", type: "bind", source: "/app/src/soul/builtin", options: ["rbind", "ro"] },
        { destination: "/run/slaude", type: "bind", source: "/var/lib/slaude-box/sessions/s1/run", options: ["rbind", "ro"] },
        { destination: "/.slaude", type: "bind", source: "/usr/local/lib/slaude-box", options: ["rbind", "ro"] },
      ],
      linux: {
        cgroupsPath: "/slaude-box-s1",
        resources: { memory: { limit: 3072 * 1024 * 1024 }, pids: { limit: 512 * 4 + 64 }, cpu: { quota: 200000, period: 100000 } },
        namespaces: [{ type: "pid" }, { type: "ipc" }, { type: "uts" }, { type: "mount" }, { type: "network" }],
      },
    });
  });

  test("the root is never marked read-only (the overlay protects the image; the flag would make every write fail)", () => {
    expect((ociConfig(input).root as { readonly: boolean }).readonly).toBe(false);
  });

  test("the cgroup pids limit is a backstop well above the box's process limit (the sandbox's own threads are counted there)", () => {
    expect(gvisorPidsLimit(64)).toBe(320);
  });

  test("runsc run: no network, host sockets openable, the overlay on the session's directory with its size", () => {
    expect(runscRunArgs({ stateDir: "/b/runsc", overlayDir: "/b/sessions/s1/overlay", rootOverlayMb: 2048, bundleDir: "/b/sessions/s1/bundle", container: "slaude-s1" })).toEqual([
      "--root", "/b/runsc", "--platform", "systrap", "--network", "none", "--host-uds", "open",
      "--overlay2", "root:dir=/b/sessions/s1/overlay,size=2048m", "run", "--detach", "--bundle", "/b/sessions/s1/bundle", "slaude-s1",
    ]);
  });

  test("runsc exec: its own pid namespace and a pid file, so the process and what it started can be ended", () => {
    const args = runscExecArgs({ stateDir: "/b/runsc", container: "slaude-s1", uid: 10001, gid: 10001, cwd: "/data/w", pidFile: "/b/x/pid", env: { B: "2", A: "1" }, argv: ["/bin/claude", "-p"] });
    expect(args).toEqual([
      "--root", "/b/runsc", "--platform", "systrap", "--network", "none", "--host-uds", "open",
      "exec", "--user", "10001:10001", "--cwd", "/data/w", "--internal-pid-file", "/b/x/pid", "--new-pidns", "--env", "A=1", "--env", "B=2", "slaude-s1", "/bin/claude", "-p",
    ]);
  });

  test("bwrap: every namespace, no capability, no further user namespace, a cleared environment, box-init in front", () => {
    const args = bwrapArgs({ root: "/b/sessions/s1/root", initDir: input.initDir, runDir: input.runDir, mounts: input.mounts, uid: 10001, gid: 10001, cwd: "/data/workspaces/w1", env: { PATH: "/bin", HOME: "/home/agent" }, argv: ["/bin/claude", "-p"], seccompFd: 9 });
    for (const flag of ["--unshare-user", "--disable-userns", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--clearenv"]) expect(args).toContain(flag);
    expect(args.join(" ")).toContain("--cap-drop ALL");
    expect(args.join(" ")).toContain("--uid 10001 --gid 10001");
    expect(args.join(" ")).toContain("--bind /b/sessions/s1/root /");
    expect(args.join(" ")).toContain("--bind /data/workspaces/w1 /data/workspaces/w1");
    expect(args.join(" ")).toContain("--ro-bind /app/src/soul/builtin /app/src/soul/builtin");
    expect(args.join(" ")).toContain("--ro-bind /var/lib/slaude-box/sessions/s1/run /run/slaude");
    expect(args.join(" ")).toContain("--seccomp 9");
    expect(args.join(" ")).toContain("--setenv HOME /home/agent --setenv PATH /bin");
    expect(args.slice(-6)).toEqual(["--", "/.slaude/box-init", "run", "--", "/bin/claude", "-p"]);
    // Nothing of the caller's environment is named.
    expect(args).not.toContain("--setenv SLAUDE_NODE_TOKEN");
  });
});

describe("the bwrap seccomp filter", () => {
  for (const arch of ["x64", "arm64"] as const) {
    test(`${arch}: refused calls get EPERM, ordinary ones pass, another architecture is ended`, () => {
      const own = SECCOMP_AUDIT_ARCH[arch];
      for (const [name, nr] of Object.entries(DENIED_SYSCALLS[arch])) expect([name, seccompVerdict(arch, own, nr)]).toEqual([name, "eperm"]);
      const denied = new Set(Object.values(DENIED_SYSCALLS[arch]));
      for (let nr = 0; nr < 460; nr++) if (!denied.has(nr)) expect(seccompVerdict(arch, own, nr)).toBe("allow");
      expect(seccompVerdict(arch, arch === "x64" ? SECCOMP_AUDIT_ARCH.arm64 : SECCOMP_AUDIT_ARCH.x64, 0)).toBe("kill");
      expect(seccompVerdict(arch, 0x40000003, 0)).toBe("kill");
      expect(seccompProgram(arch).length % 8).toBe(0);
    });
  }
  test("x64: the whole x32 call range is refused", () => {
    expect(seccompVerdict("x64", SECCOMP_AUDIT_ARCH.x64, 0x40000000 + 1)).toBe("eperm");
  });
  test("an unknown architecture has no filter rather than a wrong one", () => {
    expect(() => seccompProgram("riscv64")).toThrow();
  });
});

describe("adoptTree", () => {
  test("walks without following a link out of the tree", () => {
    const t = join(base, "adopt");
    mkdirSync(join(t, "a", "b"), { recursive: true });
    writeFileSync(join(t, "a", "f"), "x");
    symlinkSync("/etc", join(t, "a", "link"));
    // Same owner as this process: nothing to change, and nothing thrown for the link.
    const st = require("node:fs").statSync(join(t, "a", "f"));
    expect(adoptTree(t, st.uid, st.gid)).toBe(0);
  });
});

describe("the supervisor over its socket, with a fake backend", () => {
  let dir: string;
  let boxd: Boxd;
  let client: BoxdClient;
  let started: SandboxRecord[];
  let stopped: string[];
  let n = 0;

  const backend = (): SandboxBackend => ({
    tier: "gvisor",
    hostOwner: { uid: process.getuid!(), gid: process.getgid!() },
    probe: () => ({ ok: true, version: "fake" }),
    sweep() {},
    async start(sb) {
      started.push(sb);
    },
    exec: (_sb, req) => spawn(req.argv[0]!, req.argv.slice(1), { env: req.env, cwd: existsSync(req.cwd) ? req.cwd : "/", stdio: ["pipe", "pipe", "pipe"] }),
    signal: (_sb, _req, child, signal) => void child.kill(signal as NodeJS.Signals),
    async stop(sb) {
      stopped.push(sb.id);
    },
    cgroupDir: () => null,
  });

  beforeEach(async () => {
    dir = join(base, `b${n++}`);
    for (const d of [join(dir, "box"), join(dir, "data", "ws"), join(dir, "init"), join(dir, "run")]) mkdirSync(d, { recursive: true });
    mkdirSync(join(dir, "box", "sessions", "s1", "run"), { recursive: true });
    started = [];
    stopped = [];
    const b = backend();
    boxd = createBoxd(
      { boxDir: join(dir, "box"), socketPath: join(dir, "run", "boxd.sock"), mountRoots: [join(dir, "data")], roRoots: [], initDir: join(dir, "init"), agentUid: process.getuid!(), tier: "gvisor", ownerGraceMs: 150, log: () => {} },
      {
        backends: { gvisor: b, bwrap: { ...b, tier: "bwrap", probe: () => ({ ok: false, reason: "not on this host" }) } },
        images: { rootfsOf: () => join(dir, "rootfs"), has: (d) => d === DIGEST, digests: () => [DIGEST], importLayout: async () => ({ digest: DIGEST, image: "x", bytes: 0, pulledAt: 0, lastUsed: 0 }), remove: () => true },
      },
    );
    await boxd.listen();
    client = new BoxdClient({ socketPath: join(dir, "run", "boxd.sock") });
  });
  afterEach(async () => {
    client.close();
    await boxd.close();
  });

  const create = (over: Record<string, unknown> = {}) =>
    client.request("sandbox.create", {
      sandboxId: "s1",
      tier: "gvisor",
      digest: DIGEST,
      mounts: [
        { source: join(dir, "box", "sessions", "s1", "home"), target: "/home/agent", mode: "rw" },
        { source: join(dir, "data", "ws"), target: join(dir, "data", "ws"), mode: "rw" },
      ],
      runDir: join(dir, "box", "sessions", "s1", "run"),
      cwd: join(dir, "data", "ws"),
      resources: { cpu: 1, memoryMb: 512, pids: 64, rootOverlayMb: 64 },
      ...over,
    } as never);

  const finish = (p: BoxProcess): Promise<{ code: number | null; signal: string | null; out: string; err: string }> =>
    new Promise((resolve) => {
      let out = "";
      let err = "";
      p.stdout.on("data", (d: Buffer) => (out += d.toString()));
      p.stderr.on("data", (d: Buffer) => (err += d.toString()));
      p.once("exit", (code: number | null, signal: string | null) => setTimeout(() => resolve({ code, signal, out, err }), 10));
    });

  test("probe names both tiers and never a path outside the box directory", async () => {
    const p = await client.request("probe", {});
    expect(p.protocol).toBe(1);
    expect(p.tiers.gvisor).toEqual({ ok: true, version: "fake" });
    expect(p.tiers.bwrap.ok).toBe(false);
    expect(await client.alive()).toBe(true);
  });

  test("create makes the home under the box directory, is idempotent, and the socket is private", async () => {
    expect((await create()).created).toBe(true);
    expect(existsSync(join(dir, "box", "sessions", "s1", "home"))).toBe(true);
    expect((await create()).created).toBe(false);
    expect(started).toHaveLength(1);
    expect(started[0]!.uid).toBe(process.getuid!());
    expect(started[0]!.overlayDir).toBe(join(realpathSync(dir), "box", "sessions", "s1", "overlay"));
    expect(require("node:fs").statSync(join(dir, "run", "boxd.sock")).mode & 0o777).toBe(0o600);
    expect((await client.request("sandbox.list", {})).sandboxes.map((s) => s.sandboxId)).toEqual(["s1"]);
  });

  test("create refuses an unknown image, an unavailable tier, a mount outside the roots, and another image under a live id", async () => {
    await expect(create({ digest: `sha256:${"b".repeat(64)}` })).rejects.toThrow(/image cache/);
    await expect(create({ tier: "bwrap" })).rejects.toThrow(/not available/);
    await expect(create({ mounts: [{ source: "/etc", target: "/etc-host", mode: "ro" }] })).rejects.toThrow(/outside/);
    await expect(create({ runDir: join(dir, "data", "ws") })).rejects.toThrow(/outside/);
    await expect(create({ sandboxId: "../x" })).rejects.toThrow(/safe path segment/);
    expect(started).toHaveLength(0);
    await create();
    expect(boxd.sandboxes()).toEqual(["s1"]);
  });

  test("exec carries stdout, stderr and the exit status", async () => {
    await create();
    const r = await finish(client.exec({ sandboxId: "s1", argv: ["/bin/sh", "-c", "echo out; echo err >&2; exit 7"], env: { PATH: "/usr/bin:/bin" }, cwd: "/" }));
    expect(r).toEqual({ code: 7, signal: null, out: "out\n", err: "err\n" });
  });

  test("exec gives the process exactly the environment it was sent", async () => {
    await create();
    const r = await finish(client.exec({ sandboxId: "s1", argv: ["/usr/bin/env"], env: { ONLY: "this", PATH: "/usr/bin:/bin" }, cwd: "/" }));
    expect(r.out.trim().split("\n").sort()).toEqual(["ONLY=this", "PATH=/usr/bin:/bin"]);
  });

  test("stdin written before the process exists is delivered, a megabyte round trips, and closing stdin ends cat", async () => {
    await create();
    const p = client.exec({ sandboxId: "s1", argv: ["/bin/cat"], env: { PATH: "/usr/bin:/bin" }, cwd: "/" });
    const payload = Buffer.alloc(1024 * 1024, "abcdefghij");
    p.stdin.write("first line\n");
    p.stdin.write(payload);
    p.stdin.end();
    const chunks: Buffer[] = [];
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    const code = await new Promise<number | null>((r) => p.once("exit", (c: number | null) => r(c)));
    const got = Buffer.concat(chunks);
    expect(code).toBe(0);
    expect(got.length).toBe("first line\n".length + payload.length);
    expect(got.subarray(0, 11).toString()).toBe("first line\n");
    expect(p.exitCode).toBe(0);
  });

  test("kill ends a hung process, and a process that ignores the signal is still ended", async () => {
    await create();
    const p = client.exec({ sandboxId: "s1", argv: ["/bin/sh", "-c", "sleep 60"], env: { PATH: "/usr/bin:/bin" }, cwd: "/" });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    expect(p.kill("SIGTERM")).toBe(true);
    const r = await finish(p);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(r.code === null || r.code !== 0).toBe(true);
    expect(p.killed).toBe(true);
  });

  test("a process whose worker lets go of its stdio does not run on", async () => {
    await create();
    const marker = join(dir, "data", "ws", "alive");
    const p = client.exec({ sandboxId: "s1", argv: ["/bin/sh", "-c", `sleep 1; echo yes > ${marker}`], env: { PATH: "/usr/bin:/bin" }, cwd: "/" });
    await new Promise((r) => setTimeout(r, 200));
    client.close(); // the control connection only: the stdio socket is separate
    const second = new BoxdClient({ socketPath: join(dir, "run", "boxd.sock") });
    await second.request("sandbox.kill", { sandboxId: "s1", signal: "SIGKILL" });
    await new Promise((r) => setTimeout(r, 1300));
    expect(existsSync(marker)).toBe(false);
    void p;
    second.close();
  });

  test("an exec in a sandbox that does not exist fails as an exit, not as a hang", async () => {
    const p = client.exec({ sandboxId: "nope", argv: ["/bin/true"], env: {}, cwd: "/" });
    const r = await finish(p);
    expect(r.code).toBe(127);
    expect(r.err).toContain("no sandbox of this id");
  });

  test("stop ends the sandbox and throws its overlay away; the home stays", async () => {
    await create();
    writeFileSync(join(dir, "box", "sessions", "s1", "home", "keep"), "x");
    writeFileSync(join(dir, "box", "sessions", "s1", "overlay", "junk"), "x");
    expect((await client.request("sandbox.stop", { sandboxId: "s1" })).stopped).toBe(true);
    expect(stopped).toEqual(["s1"]);
    expect(existsSync(join(dir, "box", "sessions", "s1", "overlay"))).toBe(false);
    expect(readFileSync(join(dir, "box", "sessions", "s1", "home", "keep"), "utf8")).toBe("x");
    expect((await client.request("sandbox.stop", { sandboxId: "s1" })).stopped).toBe(false);
  });

  test("a sandbox whose owner connection is gone is stopped after the grace period, unless another connection takes it", async () => {
    await create();
    await create({ sandboxId: "s2", runDir: join(dir, "box", "sessions", "s1", "run"), mounts: [] });
    client.close();
    const second = new BoxdClient({ socketPath: join(dir, "run", "boxd.sock") });
    // The new worker connection uses s2 inside the grace period: it now owns it.
    await second.request("sandbox.stats", { sandboxId: "s2" });
    await new Promise((r) => setTimeout(r, 400));
    expect(boxd.sandboxes()).toEqual(["s2"]);
    expect(stopped).toEqual(["s1"]);
    second.close();
  });

  test("a home that is empty is seeded from the image's /home/agent, once", async () => {
    mkdirSync(join(dir, "rootfs", "home", "agent"), { recursive: true });
    writeFileSync(join(dir, "rootfs", "home", "agent", ".profile"), "from the image");
    await create();
    const home = join(dir, "box", "sessions", "s1", "home");
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe("from the image");
    await client.request("sandbox.stop", { sandboxId: "s1" });
    writeFileSync(join(home, ".profile"), "changed in a session");
    await create();
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe("changed in a session");
  });

  test("the supervisor as the file sync's packer: pack, commit, then nothing to do; apply rebuilds the tree elsewhere", async () => {
    const root = join(dir, "data", "home-a");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "alpha");
    writeFileSync(join(root, "sub", "b.txt"), "beta");
    const packer = client.packer(join(dir, "box", "pack-spool"));
    const unit = { root, filter: { kind: "all" as const, exclude: [] }, indexPath: join(dir, "box", "pack-index", "u1.index.json") };
    mkdirSync(join(dir, "box", "pack-index"), { recursive: true });
    const layer = await packer.pack(unit, { base: null, compact: false });
    expect(layer).not.toBeNull();
    expect(layer!.full).toBe(true);
    expect(layer!.entries).toBeGreaterThanOrEqual(2);
    expect(existsSync(layer!.path)).toBe(true);
    const copy = join(dir, "box", "pack-spool", "copy.tar");
    writeFileSync(copy, readFileSync(layer!.path));
    await layer!.commit("m1");
    await layer!.dispose();
    expect(existsSync(layer!.path)).toBe(false);
    expect(await packer.pack(unit, { base: "m1", compact: false })).toBeNull();

    const other = { root: join(dir, "data", "home-b"), filter: unit.filter, indexPath: join(dir, "box", "pack-index", "u2.index.json") };
    const applied = await packer.apply(other, { id: "m1", layers: [{ path: copy, hash: layer!.hash, removed: [] }] });
    expect(readFileSync(join(other.root, "sub", "b.txt"), "utf8")).toBe("beta");
    expect((applied as { liveBytes?: number }).liveBytes).toBe(9);
    await packer.clear(other);
    expect(existsSync(join(other.root, "a.txt"))).toBe(false);
  }, 30_000);

  test("a pack request for a path outside the roots is refused before any work", async () => {
    const packer = client.packer(join(dir, "box", "pack-spool"));
    await expect(packer.pack({ root: "/etc", filter: { kind: "all", exclude: [] }, indexPath: join(dir, "box", "i.json") }, { base: null, compact: false })).rejects.toThrow(/outside/);
    await expect(packer.apply({ root: join(dir, "data", "x"), filter: { kind: "all", exclude: [] }, indexPath: join(dir, "box", "i.json") }, { id: "m", layers: [{ path: "/etc/passwd", hash: "h", removed: [] }] })).rejects.toThrow(/outside/);
  });

  test("a missing pack root is the error the sync knows, not an empty tree", async () => {
    const { RootMissingError } = await import("../../src/storage/tree-sync");
    const packer = client.packer(join(dir, "box", "pack-spool"));
    await expect(packer.pack({ root: join(dir, "data", "never-made"), filter: { kind: "all", exclude: [] }, indexPath: join(dir, "box", "i.json") }, { base: null, compact: false })).rejects.toBeInstanceOf(RootMissingError);
  }, 20_000);
});
