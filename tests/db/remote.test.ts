import { describe, it, expect, beforeEach } from "bun:test";
import * as Remote from "../../src/db/remote";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  __resetMasterKeyCache();
  await Remote._wipeForTests();
});

describe("remote_targets", () => {
  it("set then find returns the row; set again replaces it", async () => {
    await Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId: "U_A", addr: "tcAAA", dir: "/home/a/repo", lockByRemote: true });
    let row = await Remote.findTarget("C1", "1.0");
    expect(row?.user_id).toBe("U_A");
    expect(row?.dir).toBe("/home/a/repo");
    expect(row?.lock_by_remote).toBe(1);
    await Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId: "U_A", addr: "tcBBB", dir: "/home/a/repo", lockByRemote: false });
    row = await Remote.findTarget("C1", "1.0");
    expect(row?.addr).toBe("tcBBB");
    expect(row?.lock_by_remote).toBe(0);
  });

  it("clear returns the removed row and leaves nothing", async () => {
    await Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId: "U_A", addr: "tcAAA", dir: "/r", lockByRemote: true });
    const gone = await Remote.clearTarget("C1", "1.0");
    expect(gone?.lock_by_remote).toBe(1);
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
    expect(await Remote.clearTarget("C1", "1.0")).toBeNull();
  });
});

describe("remote_keys", () => {
  it("putKeyIfAbsent stores once and returns the first pair on later calls", async () => {
    const first = await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV-1", publicKey: "ssh-ed25519 AAA1" });
    const second = await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV-2", publicKey: "ssh-ed25519 AAA2" });
    expect(first.privateKey).toBe("PRIV-1");
    expect(second.privateKey).toBe("PRIV-1");
    expect((await Remote.getKey("T1", "U_A"))?.publicKey).toBe("ssh-ed25519 AAA1");
    expect(await Remote.getKey("T1", "U_B")).toBeNull();
  });

  it("stores the private key encrypted, never in plaintext", async () => {
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV-SECRET", publicKey: "ssh-ed25519 AAA1" });
    const raw = await db.one<{ private_key: string }>("SELECT private_key FROM remote_keys WHERE team_id = ? AND user_id = ?", ["T1", "U_A"]);
    expect(raw?.private_key).not.toContain("PRIV-SECRET");
    expect(raw?.private_key.startsWith("v1:")).toBe(true);
  });
});

describe("env.remote.enabled", () => {
  it("is off by default and on for 1/true/yes", async () => {
    const { env } = await import("../../src/config/env");
    delete process.env.SLAUDE_REMOTE;
    expect(env.remote.enabled()).toBe(false);
    for (const v of ["1", "true", "YES"]) {
      process.env.SLAUDE_REMOTE = v;
      expect(env.remote.enabled()).toBe(true);
    }
    delete process.env.SLAUDE_REMOTE;
  });
});
