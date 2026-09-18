/**
 * GET /v1/tenants/:tenant/mcp-credentials.
 *
 * Nodes receive the access token and nothing that could mint another: the
 * refresh token and client secret stay in the gateway's store. The agent
 * cannot rotate what it does not hold, so the gateway is the only refresher by
 * construction, and a compromised node leaks only short-lived access tokens.
 *
 * The owner comes ONLY from the job token's signed runAs claim. There is no
 * owner in the path or the body, so there is nothing a caller can change to
 * reach someone else's credentials. Most of these tests are the boundaries
 * between owners, and they assert on the response body as well as the status:
 * a 200 that quietly contains the wrong owner's token is the failure that
 * matters.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createV1Api } from "../../../src/gateway/api/index";
import { mintJobToken, JOB_HEADER } from "../../../src/gateway/api/auth";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { db } from "../../../src/db/schema";
import * as Accounts from "../../../src/db/accounts";
import * as Creds from "../../../src/db/mcp-credentials";
import type { CredentialOwner } from "../../../src/agent/credential-owner";

const NODE_TOKEN = "test-node-token";
const ISS = "https://idp.example.com";
const TEAM = "TTESTTEAM1";
const KEY = "workbench|abc";
const PATH = "/v1/tenants/t1/mcp-credentials";

const entry = (token: string, expiresAt = Date.now() + 3600_000) => ({
  serverName: "workbench",
  serverUrl: "https://mcp.example.com",
  accessToken: token,
  refreshToken: `refresh-${token}`,
  expiresAt,
});

const AGENT: CredentialOwner = { kind: "agent", tenant: "t1", persona: "default" };
let PERSON: CredentialOwner;
let OTHER: CredentialOwner;

function tokenFor(c: { tenant?: string; persona?: string; team?: string; initiator?: string; runAs?: string }): string {
  return mintJobToken({
    tenant: c.tenant ?? "t1",
    persona: c.persona ?? "default",
    session: "S1",
    team: c.team ?? TEAM,
    channel: "C1",
    thread: "1.1",
    initiator: c.initiator ?? "UTESTUSER2",
    scope: "turn",
    ...(c.runAs !== undefined ? { runAs: c.runAs } : {}),
  });
}

const api = () => createV1Api({ tools: {} as any });
const headers = (jobToken?: string): Record<string, string> => ({
  authorization: `Bearer ${NODE_TOKEN}`,
  ...(jobToken ? { [JOB_HEADER]: jobToken } : {}),
});
const get = (jobToken: string, path = PATH) => api().fetch(new Request(`http://gw${path}`, { headers: headers(jobToken) }));

beforeAll(() => {
  process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
  process.env.SLAUDE_JOB_SECRET = "test-job-secret";
});

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await db.run("DELETE FROM mcp_credentials");
  await Accounts._wipeForTests();
  const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "a@example.com" });
  await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });
  const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "b@example.com" });
  await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "UTESTUSER2", accountId: b.id, via: "signed-link" });
  PERSON = { kind: "account", accountId: a.id };
  OTHER = { kind: "account", accountId: b.id };
  await Creds.putCredential(AGENT, KEY, entry("tok-agent"));
  await Creds.putCredential(PERSON, KEY, entry("tok-person"));
  await Creds.putCredential(OTHER, KEY, entry("tok-other"));
});

describe("reading credentials", () => {
  test("an agent-scoped token gets the agent's credentials for its persona", async () => {
    const res = await get(tokenFor({ runAs: "agent" }));
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).entries[KEY].accessToken).toBe("tok-agent");
  });

  test("a user-scoped token gets that person's credentials", async () => {
    const res = await get(tokenFor({ runAs: "user:UTESTUSER1" }));
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).entries[KEY].accessToken).toBe("tok-person");
  });

  // The message came from UTESTUSER1, but the session runs as the agent.
  test("a session running as the agent does not get the sender's credentials", async () => {
    const body = await (await get(tokenFor({ runAs: "agent", initiator: "UTESTUSER1" })))!.text();
    expect(body).toContain("tok-agent");
    expect(body).not.toContain("tok-person");
  });

  test("a 1:1 does not get the agent's credentials", async () => {
    const body = await (await get(tokenFor({ runAs: "user:UTESTUSER1" })))!.text();
    expect(body).not.toContain("tok-agent");
  });

  test("one person's token never returns another person's credentials", async () => {
    const body = await (await get(tokenFor({ runAs: "user:UTESTUSER2" })))!.text();
    expect(body).toContain("tok-other");
    expect(body).not.toContain("tok-person");
  });

  test("an agent token for one persona does not get another persona's credentials", async () => {
    const body = await (await get(tokenFor({ runAs: "agent", persona: "ana" })))!.text();
    expect(body).not.toContain("tok-agent");
  });

  test("a token for one tenant is refused another tenant's path", async () => {
    const res = await get(tokenFor({ runAs: "agent", tenant: "t1" }), "/v1/tenants/t2/mcp-credentials");
    expect(res!.status).toBe(403);
  });

  test("a token with no runAs is refused, never treated as the agent", async () => {
    const res = await get(tokenFor({}));
    expect(res!.status).toBe(403);
    expect(await res!.text()).not.toContain("tok-");
  });

  test("a token with a malformed runAs is refused", async () => {
    for (const runAs of ["admin", "user:", "user:a:b", "AGENT"]) {
      const res = await get(tokenFor({ runAs }));
      expect(res!.status).toBe(403);
    }
  });

  test("a request without a job token is refused", async () => {
    const res = await api().fetch(new Request(`http://gw${PATH}`, { headers: headers() }));
    expect(res!.status).toBe(401);
  });

  test("a request without the node bearer is refused before anything else", async () => {
    const res = await api().fetch(new Request(`http://gw${PATH}`, { headers: { [JOB_HEADER]: tokenFor({ runAs: "agent" }) } }));
    expect(res!.status).toBe(401);
  });

  // Answering differently would tell a caller whether an account exists.
  test("a user with no account gets an empty set, indistinguishable from none connected", async () => {
    const res = await get(tokenFor({ runAs: "user:UTESTUSER9" }));
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).entries).toEqual({});
  });

  // The binding is per workspace. A Slack id bound in one team is not the
  // same person in another.
  test("the binding is looked up in the token's own team", async () => {
    const body = await (await get(tokenFor({ runAs: "user:UTESTUSER1", team: "TOTHERTEAM" })))!.text();
    expect(body).not.toContain("tok-person");
  });
});

describe("what a node is allowed to hold", () => {
  test("the refresh token never leaves the gateway", async () => {
    const body = await (await get(tokenFor({ runAs: "agent" })))!.text();
    expect(body).toContain("tok-agent");
    expect(body).not.toContain("refresh-tok-agent");
    expect(body).not.toContain("refreshToken");
  });

  test("the client secret never leaves the gateway", async () => {
    await Creds.putCredential(AGENT, KEY, { ...entry("tok-agent"), clientId: "client-1", clientSecret: "secret-must-stay" });
    const body = await (await get(tokenFor({ runAs: "agent" })))!.text();
    expect(body).not.toContain("secret-must-stay");
    expect(body).not.toContain("clientSecret");
  });

  test("a node gets exactly the fields the agent needs to call the server", async () => {
    await Creds.putCredential(AGENT, KEY, { ...entry("tok-agent"), clientId: "client-1", clientSecret: "s" });
    const e = ((await (await get(tokenFor({ runAs: "agent" })))!.json()) as any).entries[KEY];
    expect(Object.keys(e).sort()).toEqual(["accessToken", "clientId", "expiresAt", "serverName", "serverUrl"]);
  });

  // Nothing a node holds can change a credential, so there is nothing for it
  // to write back, and no write surface for a compromised node to plant one.
  test("there is no write path from a node", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await api().fetch(
        new Request(`http://gw${PATH}`, {
          method,
          headers: { ...headers(tokenFor({ runAs: "agent" })), "content-type": "application/json" },
          body: JSON.stringify({ entries: { [KEY]: entry("planted", Date.now() + 9e6) } }),
        }),
      );
      expect(res!.status).toBe(405);
    }
    expect((await Creds.credentialsFor(AGENT))[KEY]!.accessToken).toBe("tok-agent");
  });
});
