import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as OneOnOne from "../../../src/db/one-on-one";
import * as Remote from "../../../src/db/remote";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { handleRemoteCommand, endRemoteForThread, remoteStatusOn, type RemoteCommandDeps } from "../../../src/gateway/core/remote-command";

let replies: string[], privately: string[], reloads: number, preflights: any[], cleanups: any[];
const ctx = (over: Partial<{ userId: string; isManager: boolean }> = {}) => ({
  teamId: "T1", channelId: "C1", threadTs: "1.0", userId: over.userId ?? "U_A", sessionId: "S1", isManager: over.isManager ?? false,
  reply: async (t: string) => { replies.push(t); },
  sayPrivately: async (t: string) => { privately.push(t); },
  reload: () => { reloads++; },
});
const deps = (ok = true): RemoteCommandDeps => ({
  preflight: async (i) => { preflights.push(i); return ok ? { ok: true, dir: "/abs/repo" } : { ok: false, error: "REMOTE_UNREACHABLE: no route" }; },
  ping: async () => "direct",
  cleanup: async (i) => { cleanups.push(i); },
  generateKeyPair: (c) => ({ privateKey: `PRIV-${c}`, publicKey: `ssh-ed25519 AAAA ${c}` }),
  validKey: (p) => !p.privateKey.startsWith("BROKEN"),
});
const allOut = () => [...replies, ...privately].join("\n");

beforeEach(async () => {
  process.env.SLAUDE_REMOTE = "1";
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
  __resetMasterKeyCache();
  await OneOnOne._wipeForTests();
  await Remote._wipeForTests();
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
    await Bun.sleep(0);
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
    expect(await endRemoteForThread("C1", "1.0", { sessionId: "S9", cleanup: async (i) => { seen.push(i); } })).toEqual({ ended: true, lockByRemote: true });
    expect(seen).toEqual([{ addr: "tcA", privateKey: "PRIV", sessionKey: "S9" }]);
    expect(await endRemoteForThread("C1", "1.0")).toEqual({ ended: false, lockByRemote: false });
  });
});
