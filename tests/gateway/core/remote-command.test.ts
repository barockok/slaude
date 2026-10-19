import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as OneOnOne from "../../../src/db/one-on-one";
import * as Remote from "../../../src/db/remote";
import * as CronJobs from "../../../src/db/cron-jobs";
import { db } from "../../../src/db/schema";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import {
  handleRemoteCommand,
  endRemoteForThread,
  remoteStatusOn,
  decodeRemoteOffer,
  encodeRemoteOffer,
  readRemoteConnectValues,
  remoteConnectModal,
  remoteOfferBlocks,
  REMOTE_CONNECT_VIEW,
  REMOTE_OFFER_TTL_MS,
  REMOTE_OPEN_ACTION,
  type RemoteCommandDeps,
} from "../../../src/gateway/core/remote-command";

let replies: string[], privately: string[], reloads: number, preflights: any[], cleanups: any[];
const ctx = (over: Partial<{ userId: string; isManager: boolean }> = {}) => ({
  teamId: "T1", channelId: "C1", threadTs: "1.0", userId: over.userId ?? "U_A", sessionId: "S1", isManager: over.isManager ?? false,
  reply: async (t: string) => { replies.push(t); },
  sayPrivately: async (t: string) => { privately.push(t); },
  reload: () => { reloads++; },
});
/** The pre-environment shapes, so the expectations below read as before. */
const flatPf = (i: any) => ({ addr: i.info.transport.addr, dir: i.dir, privateKey: i.info.privateKey });
const flatCleanup = (i: any) => ({ addr: i.info.transport.addr, privateKey: i.info.privateKey, sessionKey: i.sessionKey });
const deps = (ok = true): RemoteCommandDeps => ({
  preflight: async (i) => { preflights.push(flatPf(i)); return ok ? { ok: true, dir: "/abs/repo" } : { ok: false, error: "REMOTE_UNREACHABLE: no route" }; },
  status: async () => "direct",
  provision: async () => {},
  cleanup: async (i) => { cleanups.push(flatCleanup(i)); },
  generateKeyPair: (c) => ({ privateKey: `PRIV-${c}`, publicKey: `ssh-ed25519 AAAA ${c}` }),
  validKey: (p) => !p.privateKey.startsWith("BROKEN"),
  listForeignThreadCrons: CronJobs.countForeignThreadJobs,
});
const addCron = (createdBy: string, over: { target?: "thread" | "channel"; threadTs?: string } = {}) =>
  CronJobs.create({
    slackTeamId: "T1", slackChannelId: "C1", slackThreadTs: over.threadTs ?? "1.0", channelId: "C1", threadTs: over.threadTs ?? "1.0",
    createdBy, cronExpr: "0 9 * * *", prompt: "SECRET-PROMPT", nextRunAt: Date.now() + 60_000, target: over.target,
  });
const allOut = () => [...replies, ...privately].join("\n");

beforeEach(async () => {
  process.env.SLAUDE_REMOTE = "1";
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
  __resetMasterKeyCache();
  await OneOnOne._wipeForTests();
  await Remote._wipeForTests();
  await db.run("DELETE FROM cron_jobs");
  replies = []; privately = []; reloads = 0; preflights = []; cleanups = [];
});
afterEach(() => { delete process.env.SLAUDE_REMOTE; });

describe("/remote", () => {
  it("flag off → disabled reply, nothing stored", async () => {
    delete process.env.SLAUDE_REMOTE;
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    expect(replies[0]).toContain("not enabled");
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
  });

  it("first use without a key: generates one, sends setup privately, stores no target", async () => {
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    expect(privately[0]).toContain("tailcat serve");
    expect(privately[0]).toContain("ssh-ed25519 AAAA");
    expect(await Remote.getKey("T1", "U_A")).not.toBeNull();
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
    expect(preflights).toHaveLength(0);
  });

  it("with a key: preflight, auto-lock, store the RESOLVED dir, reload; never echoes the address", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcSecretAddr", dir: "~/repo" }, ctx(), deps());
    expect(preflights[0]).toEqual({ addr: "tcSecretAddr", dir: "~/repo", privateKey: "PRIV" });
    const t = await Remote.findTarget("C1", "1.0");
    expect(t?.dir).toBe("/abs/repo");
    expect(t?.lock_by_remote).toBe(1);
    expect((await OneOnOne.find("C1", "1.0"))?.locked_user).toBe("U_A");
    expect(reloads).toBe(1);
    expect(allOut()).not.toContain("tcSecretAddr");
  });

  it("failed preflight: reply with reason, no lock, no target, no reload", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps(false));
    expect(replies[0]).toContain("REMOTE_UNREACHABLE");
    expect(await OneOnOne.find("C1", "1.0")).toBeNull();
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
    expect(reloads).toBe(0);
  });

  it("rejects a flag-looking address and a relative dir before connecting", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "--serve", dir: "/r" }, ctx(), deps());
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "repo" }, ctx(), deps());
    expect(preflights).toHaveLength(0);
    expect(replies.join("\n")).toContain("address");
    expect(replies.join("\n")).toContain("absolute");
  });

  it("a manager cannot point someone else's locked thread at the manager's machine", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    await Remote.putKeyIfAbsent("T1", "U_MGR", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx({ userId: "U_MGR", isManager: true }), deps());
    expect(replies[0]).toContain("owner");
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
  });

  it("refuses while the 1on1 is open to guests", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    await OneOnOne.setOpen("C1", "1.0", "");
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    expect(replies[0]).toContain("/1on1 lock");
  });

  it("existing lock is kept on off (lock_by_remote = 0)", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    await handleRemoteCommand({ kind: "remote", action: "off" }, ctx(), deps());
    expect(await OneOnOne.find("C1", "1.0")).not.toBeNull();
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
    expect(reloads).toBe(2);
  });

  it("off releases a lock that /remote created and cleans up the session's jobs", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    await handleRemoteCommand({ kind: "remote", action: "off" }, ctx(), deps());
    expect(await OneOnOne.find("C1", "1.0")).toBeNull();
    await Bun.sleep(20);
    expect(cleanups).toEqual([{ addr: "tcAddr1", privateKey: "PRIV", sessionKey: "S1" }]);
  });

  it("a stale row from another user never makes this user's lock look /remote-created", async () => {
    // U_A's leftover target (lock_by_remote=1) remains after the lock moved to U_B.
    await Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId: "U_A", addr: "tcOld", dir: "/r", lockByRemote: true });
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_B", createdBy: "U_B" });
    await Remote.putKeyIfAbsent("T1", "U_B", { privateKey: "PRIV-B", publicKey: "PUB-B" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx({ userId: "U_B" }), deps());
    expect((await Remote.findTarget("C1", "1.0"))?.lock_by_remote).toBe(0);
    await handleRemoteCommand({ kind: "remote", action: "off" }, ctx({ userId: "U_B" }), deps());
    expect((await OneOnOne.find("C1", "1.0"))?.locked_user).toBe("U_B");
  });

  it("re-point with address only keeps the stored dir", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr2" }, ctx(), deps());
    expect(preflights[1]).toEqual({ addr: "tcAddr2", dir: "/abs/repo", privateKey: "PRIV" });
    expect((await Remote.findTarget("C1", "1.0"))?.addr).toBe("tcAddr2");
  });

  it("status shows on/off and path, never the address", async () => {
    await handleRemoteCommand({ kind: "remote", action: "status" }, ctx(), deps());
    expect(replies[0]).toContain("off");
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcSecretAddr", dir: "/r" }, ctx(), deps());
    await handleRemoteCommand({ kind: "remote", action: "status" }, ctx(), deps());
    expect(replies.at(-1)).toContain("direct");
    expect(replies.at(-1)).toContain("/abs/repo");
    expect(allOut()).not.toContain("tcSecretAddr");
  });

  it("key re-sends the public key privately", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "ssh-ed25519 KEEP" });
    await handleRemoteCommand({ kind: "remote", action: "key" }, ctx(), deps());
    expect(privately[0]).toContain("ssh-ed25519 KEEP");
    expect(replies.join("")).not.toContain("KEEP");
  });

  it("refuses while a cron job someone else created fires in this thread; never echoes the prompt", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await addCron("U_B");
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    expect(replies[0]).toContain("1 cron job");
    expect(replies[0]).toContain("/cron-list");
    expect(allOut()).not.toContain("SECRET-PROMPT");
    expect(preflights).toHaveLength(0);
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
    expect(await OneOnOne.find("C1", "1.0")).toBeNull();
  });

  it("a paused foreign job still blocks (it can be resumed later)", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    const job = await addCron("U_B");
    await CronJobs.pause(job.id);
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    expect(replies[0]).toContain("cron job");
    expect(preflights).toHaveLength(0);
  });

  it("allows own jobs, removed foreign jobs, channel-target jobs, and jobs in other threads", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await addCron("U_A");
    await CronJobs.deactivate((await addCron("U_B")).id);
    await addCron("U_B", { target: "channel" });
    await addCron("U_B", { threadTs: "2.0" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    expect(preflights).toHaveLength(1);
    expect(await Remote.findTarget("C1", "1.0")).not.toBeNull();
  });

  it("key replaces a stored key that does not parse and says so privately", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "BROKEN", publicKey: "ssh-ed25519 OLD" });
    await handleRemoteCommand({ kind: "remote", action: "key" }, ctx(), deps());
    expect((await Remote.getKey("T1", "U_A"))?.privateKey).toBe("PRIV-slaude:U_A");
    expect(privately[0]).toContain("previous key was invalid");
    expect(privately[0]).toContain("ssh-ed25519 AAAA slaude:U_A");
    expect(privately[0]).not.toContain("OLD");
  });

  it("on with a stored key that does not parse: replaces it, sends setup privately, no preflight, no target", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "BROKEN", publicKey: "ssh-ed25519 OLD" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    expect((await Remote.getKey("T1", "U_A"))?.privateKey).toBe("PRIV-slaude:U_A");
    expect(privately[0]).toContain("previous key was invalid");
    expect(privately[0]).toContain("tailcat serve");
    expect(preflights).toHaveLength(0);
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
    expect(await OneOnOne.find("C1", "1.0")).toBeNull();
    expect(reloads).toBe(0);
    expect(replies[0]).toContain("invalid");
  });

  it("the default validator rejects a stored key ssh2 cannot parse", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "key" }, ctx());
    const k = await Remote.getKey("T1", "U_A");
    expect(k?.privateKey).not.toBe("PRIV");
    expect(k?.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
    expect(privately[0]).toContain("previous key was invalid");
  });

  it("status reports off for a stale row without a valid locked 1on1", async () => {
    await Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId: "U_A", addr: "tcOld", dir: "/r", lockByRemote: false });
    await handleRemoteCommand({ kind: "remote", action: "status" }, ctx(), deps());
    expect(replies[0]).toContain("off");
    expect(allOut()).not.toContain("/r`");
  });

  it("endRemoteForThread still clears the target when the key lookup throws", async () => {
    await Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r", lockByRemote: true });
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 9).toString("base64"); // wrong key: decrypt throws
    __resetMasterKeyCache();
    const seen: any[] = [];
    expect(await endRemoteForThread("C1", "1.0", { sessionId: "S9", cleanup: async (i) => { seen.push(i); } })).toEqual({ ended: true, lockByRemote: true });
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
    await Bun.sleep(20);
    expect(seen).toEqual([]);
  });

  it("remoteStatusOn swallows a failing lookup and reports no marker", async () => {
    const on = await remoteStatusOn("S-throw", "C1", "1.0", async () => { throw new Error("db down"); });
    expect(on).toBe(false);
  });

  it("endRemoteForThread clears the target, cleans up when given a session, and reports lock origin", async () => {
    await Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r", lockByRemote: true });
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    const seen: any[] = [];
    expect(await endRemoteForThread("C1", "1.0", { sessionId: "S9", cleanup: async (i) => { seen.push(flatCleanup(i)); } })).toEqual({ ended: true, lockByRemote: true });
    await Bun.sleep(20);
    expect(seen).toEqual([{ addr: "tcA", privateKey: "PRIV", sessionKey: "S9" }]);
    expect(await endRemoteForThread("C1", "1.0")).toEqual({ ended: false, lockByRemote: false });
  });
});

describe("/remote connect form", () => {
  const offer = { sessionId: "S1", teamId: "T1", channelId: "C1", threadTs: "1.0", userId: "U_A", apiAppId: "A1", issuedAt: 1_000_000 };
  let offers: number;
  const withOffer = (over: Partial<{ userId: string }> = {}) => ({ ...ctx(over), offerConnect: async () => { offers++; } });
  beforeEach(() => { offers = 0; });

  it("status when off offers the Connect button privately", async () => {
    await handleRemoteCommand({ kind: "remote", action: "status" }, withOffer(), deps());
    expect(replies[0]).toContain("*off*");
    expect(offers).toBe(1);
  });

  it("no offer when the thread is locked to someone else, or when remote is on", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_B", createdBy: "U_B" });
    await handleRemoteCommand({ kind: "remote", action: "status" }, withOffer(), deps());
    expect(offers).toBe(0);
    await OneOnOne._wipeForTests();
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, ctx(), deps());
    await handleRemoteCommand({ kind: "remote", action: "status" }, withOffer(), deps());
    expect(offers).toBe(0);
  });

  it("offer round-trips for its user, and is invalid for anyone else or when malformed", () => {
    const raw = encodeRemoteOffer(offer);
    expect(decodeRemoteOffer(raw, "U_A", offer.issuedAt + 1000)).toEqual({ ok: true, offer });
    expect(decodeRemoteOffer(raw, "U_B", offer.issuedAt)).toEqual({ ok: false, reason: "invalid" });
    expect(decodeRemoteOffer("not json", "U_A")).toEqual({ ok: false, reason: "invalid" });
    expect(decodeRemoteOffer(JSON.stringify({ s: "S1" }), "U_A")).toEqual({ ok: false, reason: "invalid" });
    expect(decodeRemoteOffer(undefined, "U_A")).toEqual({ ok: false, reason: "invalid" });
  });

  it("offer expires after the TTL and rejects a far-future issue time", () => {
    const raw = encodeRemoteOffer(offer);
    expect(decodeRemoteOffer(raw, "U_A", offer.issuedAt + REMOTE_OFFER_TTL_MS + 1)).toEqual({ ok: false, reason: "expired", offer });
    expect(decodeRemoteOffer(raw, "U_A", offer.issuedAt - 5 * 60_000).ok).toBe(false);
  });

  it("button carries the offer; modal carries it as metadata and prefills the directory", () => {
    const btn = (remoteOfferBlocks(offer) as any[])[1].elements[0];
    expect(btn.action_id).toBe(REMOTE_OPEN_ACTION);
    expect(decodeRemoteOffer(btn.value, "U_A", offer.issuedAt).ok).toBe(true);
    const modal = remoteConnectModal(offer, "~/repo") as any;
    expect(modal.callback_id).toBe(REMOTE_CONNECT_VIEW);
    expect(decodeRemoteOffer(modal.private_metadata, "U_A", offer.issuedAt).ok).toBe(true);
    expect(modal.blocks[1].element.initial_value).toBe("~/repo");
    expect((remoteConnectModal(offer) as any).blocks[1].element.initial_value).toBeUndefined();
  });

  it("reads the submitted address and directory, trimmed; missing fields are empty", () => {
    const values = { remote_addr: { value: { value: "  tcAddr1 " } }, remote_dir: { value: { value: "~/repo\n" } } };
    expect(readRemoteConnectValues({ state: { values } })).toEqual({ addr: "tcAddr1", dir: "~/repo" });
    expect(readRemoteConnectValues({})).toEqual({ addr: "", dir: "" });
  });

  it("a submission goes through the same checks: empty dir is refused before connecting", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "" }, ctx(), deps());
    expect(preflights).toHaveLength(0);
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
  });
});
