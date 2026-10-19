import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as CronJobs from "../../../src/db/cron-jobs";
import * as Envs from "../../../src/db/environments";
import * as OneOnOne from "../../../src/db/one-on-one";
import * as Remote from "../../../src/db/remote";
import { db } from "../../../src/db/schema";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { handleEnvCommand, endRemoteForThread, type EnvCommandDeps } from "../../../src/gateway/core/env-command";
import { decodeEnvOffer, encodeEnvOffer, envAddModal, envPickerBlocks, readEnvAddValues, ENV_ADD_VIEW, ENV_USE_ACTION } from "../../../src/gateway/core/env-form";
import { parseSlashCommand, AGENT_COMMANDS } from "../../../src/gateway/slack/commands";
import { activeRemoteTarget } from "../../../src/remote/active";
import { getKind, registerKind, unregisterKind } from "../../../src/remote/kinds";
import { fakeSandboxKind } from "../../remote/fake-sandbox";

let replies: string[], privately: string[], reloads: number, preflights: any[], cleanups: any[], pickers: any[], reloadedThreads: string[];
const ctx = (over: Partial<{ userId: string; isManager: boolean; threadTs: string }> = {}) => ({
  teamId: "T1", channelId: "C1", threadTs: over.threadTs ?? "1.0", userId: over.userId ?? "U_A", sessionId: "S1", isManager: over.isManager ?? false,
  reply: async (t: string) => { replies.push(t); },
  sayPrivately: async (t: string) => { privately.push(t); },
  reload: () => { reloads++; },
  reloadThread: async (c: string, t: string) => { reloadedThreads.push(`${c}/${t}`); },
});
let pfResult: (i: any) => any;
const deps = (): EnvCommandDeps => ({
  preflight: async (i) => { preflights.push(i); return pfResult(i); },
  cleanup: async (i) => { cleanups.push(i); },
  status: async () => "reachable",
  provision: (c, t) => import("../../../src/remote/env-runtime").then((m) => m.ensureProvisioned(c, t)),
  generateKeyPair: (c) => ({ privateKey: `PRIV-${c}`, publicKey: `ssh-ed25519 AAAA ${c}` }),
  validKey: (p) => !p.privateKey.startsWith("BROKEN"),
  listForeignThreadCrons: CronJobs.countForeignThreadJobs,
});
const allOut = () => [...replies, ...privately].join("\n");
const withKey = () => Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });

beforeEach(async () => {
  process.env.SLAUDE_REMOTE = "1";
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
  process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK = "1";
  __resetMasterKeyCache();
  await OneOnOne._wipeForTests();
  await Remote._wipeForTests();
  await db.run("DELETE FROM cron_jobs");
  replies = []; privately = []; reloads = 0; preflights = []; cleanups = []; pickers = []; reloadedThreads = [];
  pfResult = (i) => ({ ok: true, dir: `/abs${i.dir.replace(/^~/, "/home/a")}` });
});
afterEach(() => { delete process.env.SLAUDE_REMOTE; delete process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK; });

describe("/env parsing", () => {
  it("covers every sub-command", () => {
    expect(parseSlashCommand("/env")).toEqual({ kind: "env", action: "status" });
    expect(parseSlashCommand("/env list")).toEqual({ kind: "env", action: "list" });
    expect(parseSlashCommand("/env off")).toEqual({ kind: "env", action: "off" });
    expect(parseSlashCommand("/env key ssh")).toEqual({ kind: "env", action: "key", kindName: "ssh" });
    expect(parseSlashCommand("/env use Laptop ~/My Repo")).toEqual({ kind: "env", action: "use", name: "laptop", dir: "~/My Repo" });
    expect(parseSlashCommand("/env rm box")).toEqual({ kind: "env", action: "rm", name: "box" });
    expect(parseSlashCommand("/env add")).toEqual({ kind: "env", action: "add" });
    expect(parseSlashCommand("/env add ssh box host=h.example.com user=dev dir=~/r")).toEqual({
      kind: "env", action: "add", kindName: "ssh", name: "box", fields: { host: "h.example.com", user: "dev" }, dir: "~/r",
    });
    expect(parseSlashCommand("/env edit box port=2222 name=box2")).toEqual({ kind: "env", action: "edit", name: "box", fields: { port: "2222" }, newName: "box2" });
    expect(parseSlashCommand("/env use")).toBeNull();
    expect(parseSlashCommand("/env bogus")).toBeNull();
    expect(AGENT_COMMANDS.map((c) => c.usage).join(" ")).toContain("/env");
  });
});

describe("/env add + use (user-machine)", () => {
  it("text add of an ssh environment: saves, pins the host key, locks, binds; never echoes the host", async () => {
    await withKey();
    pfResult = (i) => ({ ok: true, dir: "/home/dev/r", hostKey: "SHA256:" + "A".repeat(43) });
    await handleEnvCommand({ kind: "env", action: "add", kindName: "ssh", name: "box", fields: { host: "127.0.0.1", user: "dev" }, dir: "~/r" }, ctx(), deps());
    expect(preflights[0].info.transport).toEqual({ kind: "ssh", host: "127.0.0.1", port: 22, username: "dev", hostKey: "" });
    const e = (await Envs.findEnvByName("T1", "U_A", "box"))!;
    expect(e.config.hostKey).toBe("SHA256:" + "A".repeat(43));
    expect(privately.join("\n")).toContain("Pinned");
    expect((await OneOnOne.find("C1", "1.0"))?.locked_user).toBe("U_A");
    const t = await activeRemoteTarget("C1", "1.0");
    expect(t?.env).toMatchObject({ kind: "ssh", name: "box", trust: "user-machine" });
    expect(t?.dir).toBe("/home/dev/r");
    expect(reloads).toBe(1);
    expect(replies.join("\n")).not.toContain("127.0.0.1");
  });

  it("a later use connects with the pinned key", async () => {
    await withKey();
    await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "box", kind: "ssh", config: { host: "127.0.0.1", user: "dev", port: "22", hostKey: "SHA256:" + "B".repeat(43) } });
    await handleEnvCommand({ kind: "env", action: "use", name: "box", dir: "/srv" }, ctx(), deps());
    expect(preflights[0].info.transport.hostKey).toBe("SHA256:" + "B".repeat(43));
  });

  it("refuses bad input before saving anything", async () => {
    await handleEnvCommand({ kind: "env", action: "add", kindName: "ssh", name: "Bad Name", fields: {} }, ctx(), deps());
    await handleEnvCommand({ kind: "env", action: "add", kindName: "ssh", name: "box", fields: { host: "-oProxy", user: "dev" } }, ctx(), deps());
    await handleEnvCommand({ kind: "env", action: "add", kindName: "nope", name: "box", fields: {} }, ctx(), deps());
    expect(await Envs.listEnvs("T1", "U_A")).toEqual([]);
    expect(replies).toHaveLength(3);
  });

  it("an ssh host the outbound rules refuse is never connected to", async () => {
    delete process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK;
    await withKey();
    await handleEnvCommand({ kind: "env", action: "add", kindName: "ssh", name: "box", fields: { host: "169.254.169.254", user: "dev" }, dir: "/r" }, ctx(), deps());
    expect(preflights).toHaveLength(0);
    expect(replies.join("\n")).toContain("may not reach");
    expect(await activeRemoteTarget("C1", "1.0")).toBeNull();
  });

  it("use without a directory and no default asks for one", async () => {
    await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "lap", kind: "tailcat", config: { addr: "tcA" } });
    await handleEnvCommand({ kind: "env", action: "use", name: "lap" }, ctx(), deps());
    expect(replies[0]).toContain("Which directory");
  });

  it("only the owner's environments, only in a thread not locked to someone else", async () => {
    await Envs.createEnv({ teamId: "T1", userId: "U_B", name: "theirs", kind: "tailcat", config: { addr: "tcB" } });
    await handleEnvCommand({ kind: "env", action: "use", name: "theirs", dir: "/r" }, ctx(), deps());
    expect(replies[0]).toContain("no environment named");
    await withKey();
    await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "lap", kind: "tailcat", config: { addr: "tcA" }, defaultDir: "/r" });
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_B", createdBy: "U_B" });
    await handleEnvCommand({ kind: "env", action: "use", name: "lap" }, ctx(), deps());
    expect(replies.at(-1)).toContain("only its owner");
    expect(preflights).toHaveLength(0);
  });

  it("switching environments releases the previous one's jobs and keeps the lock origin", async () => {
    await withKey();
    await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "one", kind: "tailcat", config: { addr: "tc1" }, defaultDir: "/r" });
    await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "two", kind: "tailcat", config: { addr: "tc2" }, defaultDir: "/r" });
    await handleEnvCommand({ kind: "env", action: "use", name: "one" }, ctx(), deps());
    await handleEnvCommand({ kind: "env", action: "use", name: "two" }, ctx(), deps());
    await Bun.sleep(20);
    expect(cleanups.map((c) => c.info.transport.addr)).toEqual(["tc1"]);
    expect((await Envs.findBinding("C1", "1.0"))?.lock_by_env).toBe(1);
    await handleEnvCommand({ kind: "env", action: "off" }, ctx(), deps());
    expect(await OneOnOne.find("C1", "1.0")).toBeNull();
  });
});

describe("/env status, list, edit, rm", () => {
  it("status off, then on with name and health, never the address; list is private", async () => {
    await handleEnvCommand({ kind: "env", action: "status" }, ctx(), deps());
    expect(replies[0]).toContain("*server*");
    await withKey();
    await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "lap", kind: "tailcat", config: { addr: "tcSecret" }, defaultDir: "/r" });
    await handleEnvCommand({ kind: "env", action: "use", name: "lap" }, ctx(), deps());
    await handleEnvCommand({ kind: "env", action: "status" }, { ...ctx(), offerPicker: async (envs) => { pickers.push(envs.map((e) => e.name)); } }, deps());
    expect(replies.at(-1)).toContain("*lap*");
    expect(replies.at(-1)).toContain("reachable");
    expect(pickers).toEqual([["lap"]]);
    await handleEnvCommand({ kind: "env", action: "list" }, ctx(), deps());
    expect(privately.at(-1)).toContain("*lap*");
    expect(allOut()).not.toContain("tcSecret");
  });

  it("edit re-validates, renames, drops a pin when the host changes, and reboots bound threads", async () => {
    await withKey();
    const e = await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "box", kind: "ssh", config: { host: "127.0.0.1", user: "dev", port: "22", hostKey: "SHA256:" + "C".repeat(43) } });
    await Envs.bind({ channelId: "C1", threadTs: "9.0", envId: e.id, dir: "/r", lockByEnv: false });
    await handleEnvCommand({ kind: "env", action: "edit", name: "box", fields: { port: "x" } }, ctx(), deps());
    expect(replies.at(-1)).toContain("port");
    await handleEnvCommand({ kind: "env", action: "edit", name: "box", fields: { host: "127.0.0.2" }, newName: "box2" }, ctx(), deps());
    const u = (await Envs.getEnv(e.id))!;
    expect(u.name).toBe("box2");
    expect(u.config.hostKey).toBeUndefined();
    expect(replies.at(-1)).toContain("pin was dropped");
    expect(reloadedThreads).toEqual(["C1/9.0"]);
  });

  it("rm unbinds every thread, releases locks it created, and deletes", async () => {
    await withKey();
    await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "lap", kind: "tailcat", config: { addr: "tcA" }, defaultDir: "/r" });
    await handleEnvCommand({ kind: "env", action: "use", name: "lap" }, ctx(), deps());
    await handleEnvCommand({ kind: "env", action: "use", name: "lap" }, ctx({ threadTs: "2.0" }), deps());
    await handleEnvCommand({ kind: "env", action: "rm", name: "lap" }, ctx(), deps());
    expect(await Envs.findEnvByName("T1", "U_A", "lap")).toBeNull();
    expect(await Envs.findBinding("C1", "1.0")).toBeNull();
    expect(await Envs.findBinding("C1", "2.0")).toBeNull();
    expect(await OneOnOne.find("C1", "1.0")).toBeNull();
    expect(await OneOnOne.find("C1", "2.0")).toBeNull();
    expect(reloadedThreads).toEqual(["C1/2.0"]);
    expect(replies.at(-1)).toContain("2 threads");
  });

  it("flag off: disabled", async () => {
    delete process.env.SLAUDE_REMOTE;
    await handleEnvCommand({ kind: "env", action: "list" }, ctx(), deps());
    expect(replies[0]).toContain("not enabled");
  });
});

describe("/env with a provisioned sandbox (trust class)", () => {
  let log: string[];
  beforeEach(() => { log = []; registerKind(fakeSandboxKind(log)); });
  afterEach(() => unregisterKind("sandbox"));

  it("binds without a lock, provisions, resolves the dir, and anyone admitted may switch it off", async () => {
    await handleEnvCommand({ kind: "env", action: "add", kindName: "sandbox", name: "sb", fields: { image: "img" }, dir: "/w" }, ctx(), deps());
    expect(await OneOnOne.find("C1", "1.0")).toBeNull();
    expect(log).toEqual(["provision:C1-1_0:1"]);
    expect(preflights[0].info.privateKey).toBe("SB-KEY-1");
    const t = await activeRemoteTarget("C1", "1.0");
    expect(t?.env?.trust).toBe("provisioned");
    expect(t?.dir).toBe("/abs/w");
    expect(Envs.readEndpoint((await Envs.findBinding("C1", "1.0"))!)).not.toBeNull();
    await handleEnvCommand({ kind: "env", action: "off" }, ctx({ userId: "U_GUEST" }), deps());
    await Bun.sleep(20);
    expect(await Envs.findBinding("C1", "1.0")).toBeNull();
    expect(log).toEqual(["provision:C1-1_0:1", "teardown:sb-1"]);
  });

  it("using the same sandbox again keeps it running; a bad directory then leaves it in place", async () => {
    await handleEnvCommand({ kind: "env", action: "add", kindName: "sandbox", name: "sb", fields: { image: "img" }, dir: "/w" }, ctx(), deps());
    await handleEnvCommand({ kind: "env", action: "use", name: "sb", dir: "/w2" }, ctx(), deps());
    expect((await Envs.findBinding("C1", "1.0"))?.dir).toBe("/abs/w2");
    pfResult = () => ({ ok: false, error: "no such dir" });
    await handleEnvCommand({ kind: "env", action: "use", name: "sb", dir: "/nope" }, ctx(), deps());
    expect(await Envs.findBinding("C1", "1.0")).not.toBeNull();
    expect(log).toEqual(["provision:C1-1_0:1"]);
  });

  it("in a thread locked to its owner, a guest cannot switch it off", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    await handleEnvCommand({ kind: "env", action: "add", kindName: "sandbox", name: "sb", fields: { image: "img" }, dir: "/w" }, ctx(), deps());
    await handleEnvCommand({ kind: "env", action: "off" }, ctx({ userId: "U_GUEST" }), deps());
    expect(replies.at(-1)).toContain("Only <@U_A>");
    expect(await Envs.findBinding("C1", "1.0")).not.toBeNull();
  });

  it("a failed pre-flight unbinds and tears the sandbox down", async () => {
    pfResult = () => ({ ok: false, error: "no such dir" });
    await handleEnvCommand({ kind: "env", action: "add", kindName: "sandbox", name: "sb", fields: { image: "img" }, dir: "/w" }, ctx(), deps());
    expect(replies.at(-1)).toContain("no such dir");
    expect(await Envs.findBinding("C1", "1.0")).toBeNull();
    expect(log).toEqual(["provision:C1-1_0:1", "teardown:sb-1"]);
  });

  it("a sandbox with secrets is personal: it locks the thread and needs the owner's key", async () => {
    await withKey();
    await handleEnvCommand({ kind: "env", action: "add", kindName: "sandbox", name: "sb", fields: { image: "img", token: "T0K" }, dir: "/w" }, ctx(), deps());
    expect(privately.join("\n")).toContain("treated as personal");
    expect(allOut()).not.toContain("T0K");
  });

  it("lock transitions leave a sandbox bound but end a personal environment", async () => {
    await handleEnvCommand({ kind: "env", action: "add", kindName: "sandbox", name: "sb", fields: { image: "img" }, dir: "/w" }, ctx(), deps());
    expect(await endRemoteForThread("C1", "1.0", { sessionId: "S1", userMachineOnly: true })).toEqual({ ended: false, lockByRemote: false });
    expect(await Envs.findBinding("C1", "1.0")).not.toBeNull();
  });
});

describe("/env form", () => {
  const offer = { sessionId: "S1", teamId: "T1", channelId: "C1", threadTs: "1.0", userId: "U_A", apiAppId: "A1", issuedAt: Date.now() };

  it("picker Use buttons carry the environment, bound to the user", async () => {
    const e = await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "lap", kind: "tailcat", config: { addr: "tcSecret" } });
    const blocks = envPickerBlocks(offer, [e]) as any[];
    const btn = blocks[1].accessory;
    expect(btn.action_id).toBe(ENV_USE_ACTION);
    expect(decodeEnvOffer(btn.value, "U_A")).toMatchObject({ ok: true, offer: { envId: e.id } });
    expect(decodeEnvOffer(btn.value, "U_B")).toEqual({ ok: false, reason: "invalid" });
    expect(JSON.stringify(blocks)).not.toContain("tcSecret");
  });

  it("the add modal shows the selected kind's fields and reads them back", () => {
    const m = envAddModal({ ...offer, kindName: "ssh" }) as any;
    expect(m.callback_id).toBe(ENV_ADD_VIEW);
    expect(decodeEnvOffer(m.private_metadata, "U_A")).toMatchObject({ ok: true, offer: { kindName: "ssh" } });
    const ids = m.blocks.map((b: any) => b.block_id);
    expect(ids).toContain("env_f_host");
    expect(ids).toContain("env_f_hostKey");
    const values = { env_name: { value: { value: " box " } }, env_f_host: { value: { value: "h.example.com" } }, env_f_user: { value: { value: "dev" } }, env_dir: { value: { value: "" } } };
    expect(readEnvAddValues({ state: { values } }, getKind("ssh")!)).toEqual({ name: "box", fields: { host: "h.example.com", user: "dev" } });
    expect(encodeEnvOffer(offer)).not.toContain("kindName");
  });
});
