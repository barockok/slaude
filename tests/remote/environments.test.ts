import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { connect } from "node:net";
import * as Envs from "../../src/db/environments";
import * as OneOnOne from "../../src/db/one-on-one";
import * as Remote from "../../src/db/remote";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { activeRemoteTarget, envHash } from "../../src/remote/active";
import { ensureProvisioned, sweepIdleSandboxes, connectInfoForBinding } from "../../src/remote/env-runtime";
import { sessionConfigFp } from "../../src/remote/fingerprint";
import { getKind, registerKind, trustOf, unregisterKind } from "../../src/remote/kinds";
import { checkSshHost, __setSshResolverForTests } from "../../src/remote/kinds/ssh";
import { preflight } from "../../src/remote/preflight";
import { hostKeyFingerprint } from "../../src/remote/transport";
import { startTestSshServer, testKeyPair } from "./ssh-test-server";
import { fakeSandboxKind } from "./fake-sandbox";

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await OneOnOne._wipeForTests();
  await Remote._wipeForTests();
});

describe("environments store", () => {
  it("creates, lists by owner, refuses a duplicate name, and keeps secrets encrypted", async () => {
    const e = await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "box", kind: "ssh", config: { host: "h", user: "u", port: "22" }, secrets: { pw: "SECRET-VALUE" } });
    expect(e.secrets).toEqual({ pw: "SECRET-VALUE" });
    await expect(Envs.createEnv({ teamId: "T1", userId: "U_A", name: "box", kind: "ssh", config: {} })).rejects.toBeInstanceOf(Envs.EnvNameTakenError);
    await Envs.createEnv({ teamId: "T1", userId: "U_B", name: "box", kind: "ssh", config: {} });
    expect((await Envs.listEnvs("T1", "U_A")).map((x) => x.name)).toEqual(["box"]);
    const raw = await db.one<{ secrets: string }>("SELECT secrets FROM environments WHERE id = ?", [e.id]);
    expect(raw!.secrets).not.toContain("SECRET-VALUE");
  });

  it("an update moves updated_at, so the environment's hash changes", async () => {
    const e = await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "box", kind: "tailcat", config: { addr: "tcA" } });
    const u = await Envs.updateEnv(e.id, { config: { addr: "tcB" } });
    expect(u!.updatedAt).toBeGreaterThan(e.updatedAt);
    expect(envHash(u!)).not.toBe(envHash(e));
  });

  it("freeName counts up past taken names", async () => {
    expect(await Envs.freeName("T1", "U_A", "tailcat")).toBe("tailcat");
    await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "tailcat", kind: "tailcat", config: { addr: "a" } });
    await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "tailcat-2", kind: "tailcat", config: { addr: "b" } });
    expect(await Envs.freeName("T1", "U_A", "tailcat")).toBe("tailcat-3");
  });

  it("converts a pre-environment remote_targets row on first read, reusing a same-address environment", async () => {
    await db.run(
      "INSERT INTO remote_targets (channel_id, thread_ts, team_id, user_id, addr, dir, lock_by_remote, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["C1", "1.0", "T1", "U_A", "tcOld", "/r", 1, 5],
    );
    await db.run(
      "INSERT INTO remote_targets (channel_id, thread_ts, team_id, user_id, addr, dir, lock_by_remote, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["C1", "2.0", "T1", "U_A", "tcOld", "/s", 0, 6],
    );
    const b = await Envs.findBinding("C1", "1.0");
    expect(b).toMatchObject({ dir: "/r", lock_by_env: 1 });
    const b2 = await Envs.findBinding("C1", "2.0");
    expect(b2!.env_id).toBe(b!.env_id);
    expect((await Envs.getEnv(b!.env_id))).toMatchObject({ kind: "tailcat", name: "tailcat", config: { addr: "tcOld" } });
    expect(await db.one("SELECT * FROM remote_targets")).toBeNull();
  });

  it("a migrated tailcat binding keeps its pre-environment session fingerprint", async () => {
    await Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r", lockByRemote: true });
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    const t = (await activeRemoteTarget("C1", "1.0"))!;
    const lock = { user: "U_A", openScope: null };
    const before = sessionConfigFp({ runAs: "U_A", lock, remote: { addr: "tcA", dir: "/r" } });
    expect(sessionConfigFp({ runAs: "U_A", lock, remote: { addr: t.addr, dir: t.dir, env: t.env } })).toBe(before);
  });

  it("other kinds are fingerprinted by environment and hash, so an edit reboots", async () => {
    const e = await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "box", kind: "ssh", config: { host: "h", user: "u", port: "22" } });
    const ref = (h: string) => ({ addr: "", dir: "/r", env: { id: e.id, kind: "ssh", trust: "user-machine" as const, name: "box", hash: h } });
    expect(sessionConfigFp({ runAs: "U_A", lock: null, remote: ref("h1") })).not.toBe(sessionConfigFp({ runAs: "U_A", lock: null, remote: ref("h2") }));
  });
});

describe("kinds", () => {
  it("tailcat validates the address like /remote did", () => {
    const k = getKind("tailcat")!;
    expect(k.parse({ addr: "tcAbc" }).ok).toBe(true);
    expect(k.parse({ addr: "--serve" }).ok).toBe(false);
  });

  it("ssh validates host, user, port and an optional fingerprint, never echoing values", () => {
    const k = getKind("ssh")!;
    expect(k.parse({ host: "box.example.com", user: "dev" })).toEqual({ ok: true, config: { host: "box.example.com", user: "dev", port: "22" } });
    expect(k.parse({ host: "203.0.113.4", user: "dev", port: "2222" }).ok).toBe(true);
    for (const bad of <Record<string, string>[]>[
      { host: "-oProxyCommand=x", user: "dev" },
      { host: "box", user: "dev; rm" },
      { host: "box", user: "dev", port: "70000" },
      { host: "box", user: "dev", hostKey: "md5:aa" },
    ]) {
      const r = k.parse(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toContain("ProxyCommand");
    }
  });

  it("trustOf: a provisioned environment that carries secrets is treated as personal", () => {
    registerKind(fakeSandboxKind());
    try {
      expect(trustOf({ kind: "sandbox", secrets: {} })).toBe("provisioned");
      expect(trustOf({ kind: "sandbox", secrets: { token: "x" } })).toBe("user-machine");
      expect(trustOf({ kind: "tailcat", secrets: {} })).toBe("user-machine");
      expect(trustOf({ kind: "gone", secrets: {} })).toBe("user-machine");
    } finally {
      unregisterKind("sandbox");
    }
  });

  it("registry refuses a provisioned kind without a provisioner and protects built-ins", () => {
    expect(() => registerKind({ ...fakeSandboxKind(), provision: undefined })).toThrow();
    expect(() => unregisterKind("ssh")).toThrow();
  });
});

describe("ssh host policy", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    __setSshResolverForTests(null);
  });

  it("refuses metadata, link-local and private/loopback by default, naming no address", async () => {
    __setSshResolverForTests(async (h) => (h === "meta.test" ? ["169.254.169.254"] : h === "lan.test" ? ["10.1.2.3"] : ["93.184.216.34"]));
    await expect(checkSshHost("meta.test")).rejects.toThrow(/meta\.test resolves to a (metadata|link-local) address/);
    await expect(checkSshHost("lan.test")).rejects.toThrow("private");
    await expect(checkSshHost("127.0.0.1")).rejects.toThrow("loopback");
    expect(await checkSshHost("pub.test")).toBe("93.184.216.34");
    try { await checkSshHost("lan.test"); } catch (e) { expect((e as Error).message).not.toContain("10.1.2.3"); }
  });

  it("admits private ranges when the operator allows them, never metadata", async () => {
    __setSshResolverForTests(async (h) => (h === "meta.test" ? ["169.254.169.254"] : ["10.1.2.3"]));
    process.env.SLAUDE_ENV_SSH_ALLOW_PRIVATE = "1";
    expect(await checkSshHost("lan.test")).toBe("10.1.2.3");
    await expect(checkSshHost("meta.test")).rejects.toThrow();
    delete process.env.SLAUDE_ENV_SSH_ALLOW_PRIVATE;
    process.env.SLAUDE_OUTBOUND_INTERNAL_HOSTS = "lan.test";
    expect(await checkSshHost("lan.test")).toBe("10.1.2.3");
  });
});

describe("ssh host key pinning", () => {
  it("records the host key on first pre-flight, accepts it pinned, and refuses another", async () => {
    const pair = testKeyPair();
    const srv = await startTestSshServer({ authorizedPublicKey: pair.public });
    try {
      const transport = (hostKey: string) => ({ kind: "ssh" as const, host: "127.0.0.1", port: srv.port, username: "dev", hostKey });
      const first = await preflight({ info: { transport: transport(""), privateKey: pair.private }, dir: "/" });
      expect(first.ok).toBe(true);
      const pin = first.ok ? first.hostKey! : "";
      expect(pin).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
      const again = await preflight({ info: { transport: transport(pin), privateKey: pair.private }, dir: "/" });
      expect(again).toEqual({ ok: true, dir: "/" });
      const wrong = await preflight({ info: { transport: transport(hostKeyFingerprint(Buffer.from("other"))), privateKey: pair.private }, dir: "/", socket: () => connect(srv.port, "127.0.0.1") });
      expect(wrong.ok).toBe(false);
      if (!wrong.ok) expect(wrong.error).toContain("REMOTE_HOST_CHANGED");
    } finally {
      await srv.stop();
    }
  });
});

describe("provisioned lifecycle", () => {
  let log: string[];
  beforeEach(() => { log = []; registerKind(fakeSandboxKind(log)); });
  afterEach(() => unregisterKind("sandbox"));

  const sandboxBound = async () => {
    const e = await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "sb", kind: "sandbox", config: { image: "img" } });
    await Envs.bind({ channelId: "C1", threadTs: "1.0", envId: e.id, dir: "/w", lockByEnv: false });
    return e;
  };

  it("is an active target without any lock, and its hash moves with each provision", async () => {
    await sandboxBound();
    const t0 = (await activeRemoteTarget("C1", "1.0"))!;
    expect(t0.env).toMatchObject({ trust: "provisioned", kind: "sandbox", name: "sb" });
    await ensureProvisioned("C1", "1.0");
    const t1 = (await activeRemoteTarget("C1", "1.0"))!;
    expect(t1.env!.hash).not.toBe(t0.env!.hash);
    expect(log).toEqual(["provision:C1-1_0:1"]);
  });

  it("provisions once, then only touches; connect info fails closed while there is no sandbox", async () => {
    await sandboxBound();
    let b = (await Envs.findBinding("C1", "1.0"))!;
    await expect(connectInfoForBinding(b, (await Envs.getEnv(b.env_id))!)).rejects.toThrow("not running");
    await ensureProvisioned("C1", "1.0");
    await ensureProvisioned("C1", "1.0");
    expect(log).toHaveLength(1);
    b = (await Envs.findBinding("C1", "1.0"))!;
    expect((await connectInfoForBinding(b, (await Envs.getEnv(b.env_id))!)).privateKey).toBe("SB-KEY-1");
  });

  it("concurrent callers provision one sandbox between them", async () => {
    await sandboxBound();
    await Promise.all([ensureProvisioned("C1", "1.0", 5_000), ensureProvisioned("C1", "1.0", 5_000), ensureProvisioned("C1", "1.0", 5_000)]);
    expect(log.filter((l) => l.startsWith("provision"))).toHaveLength(1);
  });

  it("the idle sweep tears down once, and the next message provisions a new sandbox", async () => {
    await sandboxBound();
    await ensureProvisioned("C1", "1.0");
    const torn: string[] = [];
    expect(await sweepIdleSandboxes(60_000, (c, t) => torn.push(`${c}/${t}`))).toBe(0);
    expect(await sweepIdleSandboxes(-1, (c, t) => torn.push(`${c}/${t}`))).toBe(1);
    expect(await sweepIdleSandboxes(-1)).toBe(0);
    expect(torn).toEqual(["C1/1.0"]);
    expect(log).toEqual(["provision:C1-1_0:1", "teardown:sb-1"]);
    await ensureProvisioned("C1", "1.0");
    expect(log.at(-1)).toBe("provision:C1-1_0:2");
  });
});
