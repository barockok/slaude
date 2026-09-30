/**
 * The portal's single-use OAuth flow row. Everything here is about the two
 * properties the security model leans on: the row is consumed exactly once, and
 * nobody but the account that created it can consume it.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Accounts from "../../src/db/accounts";
import * as Flows from "../../src/db/portal-oauth-flows";
import { __resetMasterKeyCache } from "../../src/db/crypto";

const ISS = "https://idp.example.com";
const flow = (state: string): Flows.PortalFlow => ({
  clientId: "client-1",
  clientSecret: "cs-1",
  verifier: "pkce-verifier-1",
  tokenEndpoint: "https://mcp.example.com/token",
  serverName: "workbench",
  serverUrl: "https://mcp.example.com",
  state,
});

let accountId: string;
let otherAccountId: string;

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await db.run("DELETE FROM portal_oauth_flows");
  await Accounts._wipeForTests();
  accountId = (await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "a@example.com" })).id;
  otherAccountId = (await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "b@example.com" })).id;
});

describe("portal oauth flows", () => {
  test("a flow round-trips for its own account", async () => {
    const id = await Flows.createFlow(accountId, flow("state-1"));
    const got = await Flows.takeFlow(id, accountId);
    expect(got).toEqual(flow("state-1"));
  });

  // Single use: a replayed callback must find nothing.
  test("taking a flow consumes it", async () => {
    const id = await Flows.createFlow(accountId, flow("state-1"));
    expect(await Flows.takeFlow(id, accountId)).not.toBeNull();
    expect(await Flows.takeFlow(id, accountId)).toBeNull();
  });

  test("concurrent takes hand the flow to exactly one caller", async () => {
    const id = await Flows.createFlow(accountId, flow("state-1"));
    const outs = await Promise.all([
      Flows.takeFlow(id, accountId),
      Flows.takeFlow(id, accountId),
      Flows.takeFlow(id, accountId),
    ]);
    expect(outs.filter(Boolean)).toHaveLength(1);
  });

  test("another account cannot take it, and does not consume it", async () => {
    const id = await Flows.createFlow(accountId, flow("state-1"));
    expect(await Flows.takeFlow(id, otherAccountId)).toBeNull();
    expect(await Flows.takeFlow(id, accountId)).not.toBeNull();
  });

  test("an unknown id is simply absent", async () => {
    expect(await Flows.takeFlow("no-such-flow", accountId)).toBeNull();
  });

  test("an expired flow is gone", async () => {
    const id = await Flows.createFlow(accountId, flow("state-1"), -1);
    expect(await Flows.takeFlow(id, accountId)).toBeNull();
  });

  test("the client secret is not stored in plaintext", async () => {
    await Flows.createFlow(accountId, { ...flow("state-1"), clientSecret: "secret-in-flight" });
    const row = await db.one<{ payload: string }>("SELECT payload FROM portal_oauth_flows");
    expect(row!.payload).not.toContain("secret-in-flight");
    expect(row!.payload.startsWith("v1:")).toBe(true);
  });

  test("a flow with no client secret round-trips", async () => {
    const { clientSecret: _drop, ...noSecret } = flow("state-1");
    const id = await Flows.createFlow(accountId, noSecret);
    expect(await Flows.takeFlow(id, accountId)).toEqual(noSecret);
  });

  test("deleting the account takes its flows with it", async () => {
    await Flows.createFlow(accountId, flow("state-1"));
    await db.run("DELETE FROM accounts WHERE id = ?", [accountId]);
    const rows = await db.query("SELECT id FROM portal_oauth_flows WHERE account_id = ?", [accountId]);
    expect(rows).toHaveLength(0);
  });

  test("sweeping removes expired rows and leaves live ones", async () => {
    await Flows.createFlow(accountId, flow("dead"), -1);
    const live = await Flows.createFlow(accountId, flow("live"));
    expect(await Flows.sweepExpiredFlows()).toBe(1);
    expect(await Flows.takeFlow(live, accountId)).not.toBeNull();
  });

  test("a payload that does not decrypt is reported as absent, and still consumed", async () => {
    const id = await Flows.createFlow(accountId, flow("state-1"));
    await db.run("UPDATE portal_oauth_flows SET payload = ? WHERE id = ?", ["v1:aa:bb:cc", id]);
    expect(await Flows.takeFlow(id, accountId)).toBeNull();
    const rows = await db.query("SELECT id FROM portal_oauth_flows WHERE id = ?", [id]);
    expect(rows).toHaveLength(0);
  });
});
