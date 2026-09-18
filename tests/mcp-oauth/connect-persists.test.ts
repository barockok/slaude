/**
 * On the gateway, /mcp connect and /mcp disconnect write to the credential
 * store instead of a config directory on the shared volume. The scope decides
 * the owner exactly as the existing gates already do: `global` is the agent's
 * shared identity for this tenant and persona (a manager-only action), and
 * `initiator` is the 1:1 lock owner's account.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Accounts from "../../src/db/accounts";
import * as Creds from "../../src/db/mcp-credentials";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { oauthKey } from "../../src/agent/mcp-oauth/store";
import { persistConnect, persistDisconnect } from "../../src/agent/mcp-oauth/persist";

const ISS = "https://idp.example.com";
const TEAM = "TTESTTEAM1";
const cfg = { type: "http", url: "https://mcp.example.com/mcp" };
const KEY = oauthKey("workbench", cfg);
const tokens = (t: string) => ({ clientId: "client-1", clientSecret: "secret-1", accessToken: t, refreshToken: `r-${t}`, expiresIn: 3600 });

let personId: string;
let managerId: string;

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await db.run("DELETE FROM mcp_credentials");
  await Accounts._wipeForTests();
  personId = (await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "a@example.com" })).id;
  await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "UTESTUSER1", accountId: personId, via: "signed-link" });
  managerId = (await Accounts.upsertAccount({ issuer: ISS, subject: "sub-m", email: "m@example.com" })).id;
  await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "UMANAGER1", accountId: managerId, via: "signed-link" });
});

const base = { tenant: "t1", teamId: TEAM, serverName: "workbench", cfg };

describe("persistConnect", () => {
  test("a manager's global connect lands under the agent owner for that persona", async () => {
    const r = await persistConnect({ ...base, scope: "global", persona: "ana", slackUserId: "UMANAGER1", tokens: tokens("tok-agent") });
    expect(r).toEqual({ ok: true });
    const got = await Creds.credentialsFor({ kind: "agent", tenant: "t1", persona: "ana" });
    expect(got[KEY]!.accessToken).toBe("tok-agent");
  });

  // The manager ran the command, but it is the agent's credential, not theirs.
  test("a global connect is never stored under the manager's own account", async () => {
    await persistConnect({ ...base, scope: "global", persona: "default", slackUserId: "UMANAGER1", tokens: tokens("tok-agent") });
    expect(await Creds.credentialsFor({ kind: "account", accountId: managerId })).toEqual({});
  });

  test("a 1:1 connect lands under the person's account", async () => {
    await persistConnect({ ...base, scope: "initiator", persona: "default", slackUserId: "UTESTUSER1", tokens: tokens("tok-person") });
    expect((await Creds.credentialsFor({ kind: "account", accountId: personId }))[KEY]!.accessToken).toBe("tok-person");
    expect(await Creds.credentialsFor({ kind: "agent", tenant: "t1", persona: "default" })).toEqual({});
  });

  // One person's integrations follow them across personas: the account is the owner.
  test("a person's connect under one persona is the same credential under another", async () => {
    await persistConnect({ ...base, scope: "initiator", persona: "ana", slackUserId: "UTESTUSER1", tokens: tokens("tok-person") });
    expect((await Creds.credentialsFor({ kind: "account", accountId: personId }))[KEY]!.accessToken).toBe("tok-person");
  });

  test("a 1:1 connect with no bound account is refused, not silently dropped", async () => {
    const r = await persistConnect({ ...base, scope: "initiator", persona: "default", slackUserId: "UTESTUSER9", tokens: tokens("tok-1") });
    expect(r).toEqual({ ok: false, reason: "no-account" });
    const n = await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_credentials");
    expect(Number(n!.n)).toBe(0);
  });

  test("the binding is resolved in the connect's own workspace", async () => {
    const r = await persistConnect({ ...base, teamId: "TOTHERTEAM", scope: "initiator", persona: "default", slackUserId: "UTESTUSER1", tokens: tokens("tok-1") });
    expect(r).toEqual({ ok: false, reason: "no-account" });
  });

  // An explicit connect is the owner's own fresh grant: it always wins, even
  // over a stored entry with a later expiry.
  test("a fresh connect replaces what was stored", async () => {
    await Creds.putCredential({ kind: "agent", tenant: "t1", persona: "default" }, KEY, {
      serverName: "workbench", serverUrl: cfg.url, accessToken: "old", expiresAt: Date.now() + 9e7,
    });
    await persistConnect({ ...base, scope: "global", persona: "default", slackUserId: "UMANAGER1", tokens: tokens("new") });
    expect((await Creds.credentialsFor({ kind: "agent", tenant: "t1", persona: "default" }))[KEY]!.accessToken).toBe("new");
  });

  // The store is the gateway's own; the full grant belongs there, encrypted.
  test("the refresh token and client secret are kept, for the gateway to refresh with", async () => {
    await persistConnect({ ...base, scope: "global", persona: "default", slackUserId: "UMANAGER1", tokens: tokens("tok-agent") });
    const e = (await Creds.credentialsFor({ kind: "agent", tenant: "t1", persona: "default" }))[KEY]!;
    expect(e.refreshToken).toBe("r-tok-agent");
    expect(e.clientSecret).toBe("secret-1");
  });
});

describe("persistDisconnect", () => {
  test("a global disconnect removes the agent's row and leaves a person's intact", async () => {
    await persistConnect({ ...base, scope: "global", persona: "default", slackUserId: "UMANAGER1", tokens: tokens("tok-agent") });
    await persistConnect({ ...base, scope: "initiator", persona: "default", slackUserId: "UTESTUSER1", tokens: tokens("tok-person") });

    const r = await persistDisconnect({ ...base, scope: "global", persona: "default", slackUserId: "UMANAGER1" });

    expect(r).toEqual({ ok: true, removed: true });
    expect(await Creds.credentialsFor({ kind: "agent", tenant: "t1", persona: "default" })).toEqual({});
    expect((await Creds.credentialsFor({ kind: "account", accountId: personId }))[KEY]!.accessToken).toBe("tok-person");
  });

  test("a 1:1 disconnect removes only that person's row", async () => {
    await persistConnect({ ...base, scope: "global", persona: "default", slackUserId: "UMANAGER1", tokens: tokens("tok-agent") });
    await persistConnect({ ...base, scope: "initiator", persona: "default", slackUserId: "UTESTUSER1", tokens: tokens("tok-person") });

    await persistDisconnect({ ...base, scope: "initiator", persona: "default", slackUserId: "UTESTUSER1" });

    expect(await Creds.credentialsFor({ kind: "account", accountId: personId })).toEqual({});
    expect((await Creds.credentialsFor({ kind: "agent", tenant: "t1", persona: "default" }))[KEY]!.accessToken).toBe("tok-agent");
  });

  test("disconnecting something never connected reports it rather than claiming success", async () => {
    const r = await persistDisconnect({ ...base, scope: "global", persona: "default", slackUserId: "UMANAGER1" });
    expect(r).toEqual({ ok: true, removed: false });
  });
});
