/**
 * The parked paste-back connect flow.
 *
 * Two properties differ from the portal's equivalent and both are deliberate:
 * peeking does not consume (a person can paste the wrong URL and retry), and
 * taking does (the exchange must happen once, whichever replica gets the paste).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Flows from "../../src/db/slack-oauth-flows";
import { __resetMasterKeyCache } from "../../src/db/crypto";

const KEY = "C_TEST:1790000000.1:UTESTUSER1";
const flow = (state: string): Flows.SlackOauthFlow => ({
  state,
  parts: {
    tokenEndpoint: "https://auth.example.com/token",
    redirectUri: "https://slaude.example.com/oauth/cb",
    clientId: "client-1",
    clientSecret: "cs-1",
    verifier: "pkce-verifier-1",
    resource: "https://mcp.example.com/mcp",
  },
  serverName: "workbench",
  cfg: { type: "http", url: "https://mcp.example.com/mcp" },
  sessionId: "s-1",
  channelId: "C_TEST",
  threadTs: "1790000000.1",
  userId: "UTESTUSER1",
  scope: "initiator",
  personaName: "ana",
  authMsgRef: "1790000001.5",
});

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await db.run("DELETE FROM slack_oauth_flows");
});

describe("parked connect flows", () => {
  test("a flow round-trips", async () => {
    await Flows.putFlow(KEY, flow("st-1"));
    expect(await Flows.peekFlow(KEY)).toEqual(flow("st-1"));
  });

  // The state check must be able to fail without costing the person their flow:
  // they are told to paste the URL from the same authorize step and try again.
  test("peeking does not consume", async () => {
    await Flows.putFlow(KEY, flow("st-1"));
    expect(await Flows.peekFlow(KEY)).not.toBeNull();
    expect(await Flows.peekFlow(KEY)).not.toBeNull();
  });

  test("taking consumes", async () => {
    await Flows.putFlow(KEY, flow("st-1"));
    expect(await Flows.takeFlow(KEY)).not.toBeNull();
    expect(await Flows.takeFlow(KEY)).toBeNull();
  });

  test("concurrent takes hand the flow to exactly one caller", async () => {
    await Flows.putFlow(KEY, flow("st-1"));
    const outs = await Promise.all([Flows.takeFlow(KEY), Flows.takeFlow(KEY), Flows.takeFlow(KEY)]);
    expect(outs.filter(Boolean)).toHaveLength(1);
  });

  test("rerunning connect replaces the parked flow rather than adding one", async () => {
    await Flows.putFlow(KEY, flow("st-1"));
    await Flows.putFlow(KEY, flow("st-2"));
    expect((await Flows.peekFlow(KEY))?.state).toBe("st-2");
    expect(await db.query("SELECT flow_key FROM slack_oauth_flows")).toHaveLength(1);
  });

  test("another thread's key finds nothing", async () => {
    await Flows.putFlow(KEY, flow("st-1"));
    expect(await Flows.peekFlow("C_TEST:1790000000.1:UTESTUSER2")).toBeNull();
  });

  test("an expired flow is gone to both readers", async () => {
    await Flows.putFlow(KEY, flow("st-1"), -1);
    expect(await Flows.peekFlow(KEY)).toBeNull();
    expect(await Flows.takeFlow(KEY)).toBeNull();
  });

  test("the client secret and verifier are not stored in plaintext", async () => {
    await Flows.putFlow(KEY, flow("st-1"));
    const row = await db.one<{ payload: string }>("SELECT payload FROM slack_oauth_flows");
    expect(row!.payload).not.toContain("cs-1");
    expect(row!.payload).not.toContain("pkce-verifier-1");
    expect(row!.payload.startsWith("v1:")).toBe(true);
  });

  test("sweeping removes expired rows and leaves live ones", async () => {
    await Flows.putFlow("dead", flow("st-dead"), -1);
    await Flows.putFlow(KEY, flow("st-1"));
    expect(await Flows.sweepExpiredFlows()).toBe(1);
    expect(await Flows.peekFlow(KEY)).not.toBeNull();
  });

  test("a payload that does not decrypt reads as absent, and taking still clears it", async () => {
    await Flows.putFlow(KEY, flow("st-1"));
    await db.run("UPDATE slack_oauth_flows SET payload = ? WHERE flow_key = ?", ["v1:aa:bb:cc", KEY]);
    expect(await Flows.peekFlow(KEY)).toBeNull();
    expect(await Flows.takeFlow(KEY)).toBeNull();
    expect(await db.query("SELECT flow_key FROM slack_oauth_flows WHERE flow_key = ?", [KEY])).toHaveLength(0);
  });
});
