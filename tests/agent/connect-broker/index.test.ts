import { describe, it, expect, beforeEach } from "bun:test";
import { createBroker } from "../../../src/agent/connect-broker/index";
import * as Conn from "../../../src/db/connections";
import { db } from "../../../src/db/schema";
import { encryptCred } from "../../../src/agent/connect-broker/crypto";

const KEY = Buffer.alloc(32, 5);
const T = { team_id: "T", channel_id: "C", thread_ts: "9.9" };

/** Insert an active connection whose ciphertext is AAD-bound to its own row id. */
function seedConnection(owner: string, service: string, secret: object) {
  const row = Conn.insertConnection({
    owner_slack_user_id: owner, service, scope: "thread", thread: T,
    auth_strategy: "token", cred_ciphertext: "PLACEHOLDER", key_id: "k", now: 1,
  });
  db.run(`UPDATE connections SET cred_ciphertext = ? WHERE id = ?`, [encryptCred(KEY, row.id, JSON.stringify(secret)), row.id]);
  return Conn.findById(row.id)!;
}

beforeEach(() => Conn._wipeForTests());

describe("createBroker", () => {
  it("mcp_call forwards through a fake child for an own connection, decrypting the cred", async () => {
    seedConnection("U1", "jira", { token: "T0p" });
    let deliveredCred: string | null = null;
    const broker = createBroker({
      key: KEY,
      idleMs: 10_000,
      spawnChild: () => ({ callTool: async (tool, args) => ({ tool, args }), deliverCred(p) { deliveredCred = p; }, kill() {} }),
      requestApproval: async () => ({ approved: true, by: "U1", scope: "thread" }),
      isMember: () => true,
    });
    const ctx = broker.buildCtx({ getCallerUserId: () => "U1", thread: T, postConnectUrl: async () => ({ url: "u", expiresInMs: 0 }) });
    const res = await ctx.runCall({ caller: "U1", service: "jira", tool: "jira_search", args: { jql: "x" } });
    expect(res.kind).toBe("ok");
    expect(JSON.parse(deliveredCred!)).toEqual({ token: "T0p" });
    broker.stop();
  });

  it("revoke marks the caller's connection revoked and evicts the child", async () => {
    seedConnection("U1", "jira", { token: "x" });
    const broker = createBroker({ key: KEY, idleMs: 10_000, spawnChild: () => ({ callTool: async () => ({}), deliverCred() {}, kill() {} }), requestApproval: async () => ({ approved: false, by: "" }), isMember: () => true });
    const ctx = broker.buildCtx({ getCallerUserId: () => "U1", thread: T, postConnectUrl: async () => ({ url: "u", expiresInMs: 0 }) });
    expect(ctx.revoke("jira").revoked).toBe(1);
    expect(Conn.listForThread(T).length).toBe(0); // revoked rows excluded from active list
    broker.stop();
  });

  it("uses the LIVE caller id, not a boot-time snapshot (Vuln 1 regression)", async () => {
    seedConnection("U1", "jira", { token: "alice" }); // only Alice has a connection in this thread
    let current = "U1";
    const broker = createBroker({
      key: KEY, idleMs: 10_000,
      spawnChild: () => ({ callTool: async () => ({ ok: true }), deliverCred() {}, kill() {} }),
      requestApproval: async () => ({ approved: false, by: "" }),
      isMember: () => true,
    });
    const ctx = broker.buildCtx({ getCallerUserId: () => current, thread: T, postConnectUrl: async () => ({ url: "u", expiresInMs: 0 }) });

    // Turn 1: Alice acts -> her own connection resolves.
    expect(ctx.callerUserId).toBe("U1");
    expect((await ctx.runCall({ caller: ctx.callerUserId, service: "jira", tool: "jira_search", args: {} })).kind).toBe("ok");

    // Turn 2: Bob now acts in the same session. The broker must NOT keep using Alice.
    // Pre-fix (frozen callerUserId=U1) this would resolve Alice's OWN connection => "ok".
    // Post-fix Bob is correctly treated as a borrower: jira_list_my_issues is owner-only
    // (borrowable:false), so borrowing Alice's connection is denied.
    current = "U2";
    expect(ctx.callerUserId).toBe("U2");
    const bob = await ctx.runCall({ caller: ctx.callerUserId, service: "jira", tool: "jira_list_my_issues", args: {} });
    expect(bob.kind).toBe("denied");
    expect(bob.kind).not.toBe("ok"); // the Vuln 1 silent-cross-user-success must not happen
    broker.stop();
  });

  it("ctx exposes listConnections (mine flag + expiry), startConnect, describe", async () => {
    seedConnection("U1", "jira", { token: "x" }); // owned by U1, no expiry
    const broker = createBroker({ key: KEY, idleMs: 10_000, spawnChild: () => ({ callTool: async () => ({}), deliverCred() {}, kill() {} }), requestApproval: async () => ({ approved: false, by: "" }), isMember: () => true });

    // Caller U1 sees the connection as "mine".
    const asU1 = broker.buildCtx({ getCallerUserId: () => "U1", thread: T, postConnectUrl: async () => ({ url: "https://login/x", expiresInMs: 600_000 }) });
    const listMine = asU1.listConnections();
    expect(listMine).toHaveLength(1);
    expect(listMine[0]!.mine).toBe(true);
    expect(listMine[0]!.expiresInMs).toBeNull();

    // Caller U2 sees the same connection as not-mine.
    const asU2 = broker.buildCtx({ getCallerUserId: () => "U2", thread: T, postConnectUrl: async () => ({ url: "u", expiresInMs: 0 }) });
    expect(asU2.listConnections()[0]!.mine).toBe(false);

    // startConnect delegates to postConnectUrl; describe returns a payload.
    expect(await asU1.startConnect("jira")).toEqual({ url: "https://login/x", expiresInMs: 600_000 });
    expect(await asU1.describe("jira")).toMatchObject({ service: "jira" });
    broker.stop();
  });

  it("reapExpiredConnections marks past-TTL rows expired", async () => {
    const row = Conn.insertConnection({ owner_slack_user_id: "U1", service: "jira", scope: "thread", thread: T, auth_strategy: "token", cred_ciphertext: "x", key_id: "k", now: 1, expires_at: 100 });
    const broker = createBroker({ key: KEY, idleMs: 10_000, spawnChild: () => ({ callTool: async () => ({}), deliverCred() {}, kill() {} }), requestApproval: async () => ({ approved: false, by: "" }), isMember: () => true });
    broker.reapExpiredConnections(1000);
    expect(Conn.findById(row.id)!.status).toBe("expired");
    broker.stop();
  });
});
