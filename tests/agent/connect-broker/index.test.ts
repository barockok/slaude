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
    const ctx = broker.buildCtx({ callerUserId: "U1", thread: T, postConnectUrl: async () => ({ url: "u", expiresInMs: 0 }) });
    const res = await ctx.runCall({ caller: "U1", service: "jira", tool: "jira_search", args: { jql: "x" } });
    expect(res.kind).toBe("ok");
    expect(JSON.parse(deliveredCred!)).toEqual({ token: "T0p" });
    broker.stop();
  });

  it("revoke marks the caller's connection revoked and evicts the child", async () => {
    seedConnection("U1", "jira", { token: "x" });
    const broker = createBroker({ key: KEY, idleMs: 10_000, spawnChild: () => ({ callTool: async () => ({}), deliverCred() {}, kill() {} }), requestApproval: async () => ({ approved: false, by: "" }), isMember: () => true });
    const ctx = broker.buildCtx({ callerUserId: "U1", thread: T, postConnectUrl: async () => ({ url: "u", expiresInMs: 0 }) });
    expect(ctx.revoke("jira").revoked).toBe(1);
    expect(Conn.listForThread(T).length).toBe(0); // revoked rows excluded from active list
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
