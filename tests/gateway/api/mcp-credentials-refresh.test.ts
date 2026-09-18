/**
 * POST /v1/tenants/:tenant/mcp-credentials/refresh — a node asks the gateway to
 * refresh one server's credential for its own turn's owner. The owner is the
 * job token's runAs, exactly as for GET; the body names only the server key and
 * a hash of the token that failed, never a token.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createV1Api } from "../../../src/gateway/api/index";
import { mintJobToken, JOB_HEADER } from "../../../src/gateway/api/auth";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { db } from "../../../src/db/schema";
import * as Accounts from "../../../src/db/accounts";
import * as Creds from "../../../src/db/mcp-credentials";
import { makeCredentialRefresher, localLock } from "../../../src/gateway/core/credential-refresh";
import { RefreshRejected } from "../../../src/agent/mcp-oauth/refresh";
import type { CredentialOwner } from "../../../src/agent/credential-owner";

const NODE_TOKEN = "test-node-token";
const TEAM = "TTESTTEAM1";
const KEY = "workbench|abc";
const PATH = "/v1/tenants/t1/mcp-credentials/refresh";
const AGENT: CredentialOwner = { kind: "agent", tenant: "t1", persona: "default" };
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

const stored = (token: string, expiresAt = Date.now() - 1) => ({
  serverName: "workbench",
  serverUrl: "https://mcp.example.com/mcp",
  clientId: "client-1",
  clientSecret: "secret-stays-home",
  accessToken: token,
  refreshToken: `refresh-${token}`,
  expiresAt,
});

let grantBehaviour: "ok" | "rejected" | "down" = "ok";
let grants = 0;
const refresher = makeCredentialRefresher({
  lock: localLock(),
  discover: async () => ({ tokenEndpoint: "https://idp.example.com/token" }),
  grant: async (p) => {
    grants++;
    if (grantBehaviour === "rejected") throw new RefreshRejected(400, "invalid_grant");
    if (grantBehaviour === "down") throw new Error("refresh failed at the provider (status 503)");
    return { clientId: p.clientId, accessToken: `tok-new-${grants}`, refreshToken: `refresh-new-${grants}`, expiresIn: 3600 };
  },
});

const api = () => createV1Api({ tools: {} as any, credentialRefresher: refresher });
const tokenFor = (runAs?: string, tenant = "t1") =>
  mintJobToken({
    tenant, persona: "default", session: "S1", team: TEAM, channel: "C1", thread: "1.1",
    initiator: "UTESTUSER2", scope: "turn", ...(runAs !== undefined ? { runAs } : {}),
  });
const post = (jobToken: string, body: unknown, path = PATH) =>
  api().fetch(
    new Request(`http://gw${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${NODE_TOKEN}`, [JOB_HEADER]: jobToken, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

let PERSON: CredentialOwner;

beforeAll(() => {
  process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
  process.env.SLAUDE_JOB_SECRET = "test-job-secret";
});

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await db.run("DELETE FROM mcp_credentials");
  await Accounts._wipeForTests();
  const a = await Accounts.upsertAccount({ issuer: "https://idp.example.com", subject: "sub-1", email: "a@example.com" });
  await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });
  PERSON = { kind: "account", accountId: a.id };
  grantBehaviour = "ok";
  grants = 0;
});

describe("refresh endpoint", () => {
  test("refreshes the agent's credential and returns only an access-token projection", async () => {
    await Creds.putCredential(AGENT, KEY, stored("tok-old"));
    const res = await post(tokenFor("agent"), { serverKey: KEY, failedAccessTokenHash: hash("tok-old") });
    expect(res!.status).toBe(200);
    const text = await res!.text();
    const entry = JSON.parse(text).entry;
    expect(entry.accessToken).toBe("tok-new-1");
    expect(text).not.toContain("refresh-");
    expect(text).not.toContain("secret-stays-home");
    expect(Object.keys(entry).sort()).toEqual(["accessToken", "clientId", "expiresAt", "serverName", "serverUrl"]);
  });

  test("a person's refresh acts on their own credential", async () => {
    await Creds.putCredential(AGENT, KEY, stored("tok-agent"));
    await Creds.putCredential(PERSON, KEY, stored("tok-person"));
    await post(tokenFor("user:UTESTUSER1"), { serverKey: KEY, failedAccessTokenHash: hash("tok-person") });
    expect((await Creds.credentialsFor(PERSON))[KEY]!.accessToken).toBe("tok-new-1");
    expect((await Creds.credentialsFor(AGENT))[KEY]!.accessToken).toBe("tok-agent");
  });

  // A session running as the agent cannot drive a refresh of someone else's
  // credential, whoever sent the message.
  test("an agent-scoped token cannot refresh a person's credential", async () => {
    await Creds.putCredential(PERSON, KEY, stored("tok-person"));
    const res = await post(tokenFor("agent"), { serverKey: KEY });
    expect(res!.status).toBe(404);
    expect(grants).toBe(0);
    expect((await Creds.credentialsFor(PERSON))[KEY]!.accessToken).toBe("tok-person");
  });

  test("a revoked grant answers 409 reconnect", async () => {
    await Creds.putCredential(AGENT, KEY, stored("tok-old"));
    grantBehaviour = "rejected";
    const res = await post(tokenFor("agent"), { serverKey: KEY, failedAccessTokenHash: hash("tok-old") });
    expect(res!.status).toBe(409);
    expect(await res!.json()).toEqual({ reconnect: true });
  });

  test("a transient provider failure answers 503, with no detail", async () => {
    await Creds.putCredential(AGENT, KEY, stored("tok-old"));
    grantBehaviour = "down";
    const res = await post(tokenFor("agent"), { serverKey: KEY, failedAccessTokenHash: hash("tok-old") });
    expect(res!.status).toBe(503);
    expect(await res!.text()).not.toContain("provider");
  });

  // No account and never-connected look the same from outside.
  test("an unknown server and a person with no account both answer 404", async () => {
    expect((await post(tokenFor("agent"), { serverKey: "never|x" }))!.status).toBe(404);
    expect((await post(tokenFor("user:UTESTUSER9"), { serverKey: KEY }))!.status).toBe(404);
  });

  test("a token without runAs is refused", async () => {
    await Creds.putCredential(AGENT, KEY, stored("tok-old"));
    expect((await post(tokenFor(undefined), { serverKey: KEY }))!.status).toBe(403);
    expect(grants).toBe(0);
  });

  test("a token for another tenant is refused", async () => {
    expect((await post(tokenFor("agent", "t2"), { serverKey: KEY }))!.status).toBe(403);
  });

  // The node sends a hash of the failed token, never the token itself.
  test("a body carrying anything but a server key and a hash is rejected", async () => {
    for (const body of [{}, { serverKey: "" }, { serverKey: 7 }, { serverKey: KEY, failedAccessTokenHash: "tok-plain" }]) {
      expect((await post(tokenFor("agent"), body))!.status).toBe(400);
    }
    expect(grants).toBe(0);
  });

  test("only POST is accepted", async () => {
    const res = await api().fetch(
      new Request(`http://gw${PATH}`, { headers: { authorization: `Bearer ${NODE_TOKEN}`, [JOB_HEADER]: tokenFor("agent") } }),
    );
    expect(res!.status).toBe(405);
  });
});
