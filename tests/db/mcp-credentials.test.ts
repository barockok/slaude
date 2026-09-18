/**
 * The gateway-owned MCP credential store. Two kinds of owner share one table:
 * the agent's own identity per (tenant, persona), and a person per account.
 * Most of these tests are about the boundary between owners, because that is
 * where a mistake hands one party another's credentials.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { db } from "../../src/db/schema";
import * as Accounts from "../../src/db/accounts";
import * as Creds from "../../src/db/mcp-credentials";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import type { CredentialOwner } from "../../src/agent/credential-owner";

const ISS = "https://idp.example.com";
const KEY = "workbench|abc";
const entry = (token: string, expiresAt = Date.now() + 3600_000) => ({
  serverName: "workbench",
  serverUrl: "https://mcp.example.com",
  accessToken: token,
  refreshToken: "r-1",
  expiresAt,
});
const AGENT: CredentialOwner = { kind: "agent", tenant: "t1", persona: "default" };
let person: CredentialOwner;
let accountId: string;

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await db.run("DELETE FROM mcp_credentials");
  await Accounts._wipeForTests();
  accountId = (await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "a@example.com" })).id;
  person = { kind: "account", accountId };
});

describe("mcp credential store", () => {
  test("round-trips an entry for a person", async () => {
    await Creds.putCredential(person, KEY, entry("tok-1"));
    expect((await Creds.credentialsFor(person))[KEY]!.accessToken).toBe("tok-1");
  });

  test("round-trips an entry for the agent", async () => {
    await Creds.putCredential(AGENT, KEY, entry("tok-agent"));
    expect((await Creds.credentialsFor(AGENT))[KEY]!.accessToken).toBe("tok-agent");
  });

  test("the agent's credentials are never returned for a person, or the reverse", async () => {
    await Creds.putCredential(AGENT, KEY, entry("tok-agent"));
    await Creds.putCredential(person, KEY, entry("tok-person"));
    expect((await Creds.credentialsFor(AGENT))[KEY]!.accessToken).toBe("tok-agent");
    expect((await Creds.credentialsFor(person))[KEY]!.accessToken).toBe("tok-person");
  });

  test("one persona's agent credentials are not another's", async () => {
    await Creds.putCredential(AGENT, KEY, entry("tok-default"));
    expect(await Creds.credentialsFor({ kind: "agent", tenant: "t1", persona: "ana" })).toEqual({});
  });

  test("one tenant's agent credentials are not another's", async () => {
    await Creds.putCredential(AGENT, KEY, entry("tok-t1"));
    expect(await Creds.credentialsFor({ kind: "agent", tenant: "t2", persona: "default" })).toEqual({});
  });

  test("one person's credentials are not another's", async () => {
    const other = (await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "b@example.com" })).id;
    await Creds.putCredential(person, KEY, entry("tok-person"));
    expect(await Creds.credentialsFor({ kind: "account", accountId: other })).toEqual({});
  });

  // A database dump must not contain the token.
  test("the token is not stored in plaintext", async () => {
    await Creds.putCredential(AGENT, KEY, { ...entry("tok-super-secret"), refreshToken: "refresh-super-secret" });
    const raw = await db.one<{ payload: string }>("SELECT payload FROM mcp_credentials");
    expect(raw!.payload).not.toContain("tok-super-secret");
    expect(raw!.payload).not.toContain("refresh-super-secret");
    expect(raw!.payload.startsWith("v1:")).toBe(true);
  });

  test("expiry is queryable without decrypting", async () => {
    const at = Date.now() + 1234;
    await Creds.putCredential(person, KEY, entry("tok-1", at));
    const raw = await db.one<{ expires_at: number }>("SELECT expires_at FROM mcp_credentials");
    expect(Number(raw!.expires_at)).toBe(at);
  });

  test("writing the same key for the same owner replaces, never duplicates", async () => {
    await Creds.putCredential(AGENT, KEY, entry("tok-1"));
    await Creds.putCredential(AGENT, KEY, entry("tok-2"));
    const n = await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_credentials");
    expect(Number(n!.n)).toBe(1);
    expect((await Creds.credentialsFor(AGENT))[KEY]!.accessToken).toBe("tok-2");
  });

  test("the same key under the agent and a person is two rows, not a collision", async () => {
    await Creds.putCredential(AGENT, KEY, entry("tok-agent"));
    await Creds.putCredential(person, KEY, entry("tok-person"));
    const n = await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_credentials");
    expect(Number(n!.n)).toBe(2);
  });

  test("deleting an account takes its credentials through the database cascade", async () => {
    await Creds.putCredential(person, KEY, entry("tok-1"));
    await db.run("DELETE FROM accounts WHERE id = ?", [accountId]);
    const left = await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_credentials");
    expect(Number(left!.n)).toBe(0);
  });

  // Enforced by the schema, not by the repo, so a future caller cannot bypass it.
  test("a row with no owner, two owners, or half an agent owner is refused by the database", async () => {
    const insert = (acct: string | null, tenant: string | null, persona: string | null) =>
      db.run(
        `INSERT INTO mcp_credentials (id, account_id, agent_tenant, agent_persona, server_key, payload, expires_at, updated_at)
         VALUES (?, ?, ?, ?, 'k', 'v1:a:b:c', 0, 0)`,
        [randomUUID(), acct, tenant, persona],
      );
    await expect(insert(null, null, null)).rejects.toThrow();
    await expect(insert(accountId, "t1", "default")).rejects.toThrow();
    await expect(insert(null, "t1", null)).rejects.toThrow();
    await expect(insert(null, null, "default")).rejects.toThrow();
  });

  test("deleteCredential removes only that owner's row", async () => {
    await Creds.putCredential(AGENT, KEY, entry("tok-agent"));
    await Creds.putCredential(person, KEY, entry("tok-person"));
    expect(await Creds.deleteCredential(AGENT, KEY)).toBe(true);
    expect(await Creds.credentialsFor(AGENT)).toEqual({});
    expect((await Creds.credentialsFor(person))[KEY]!.accessToken).toBe("tok-person");
    expect(await Creds.deleteCredential(AGENT, KEY)).toBe(false);
  });

  test("a corrupt payload is skipped, not returned, and not echoed into the log", async () => {
    await Creds.putCredential(AGENT, KEY, entry("tok-1"));
    await db.run("UPDATE mcp_credentials SET payload = 'v1:aa:bb:cc'");
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    try {
      expect(await Creds.credentialsFor(AGENT)).toEqual({});
    } finally {
      console.error = orig;
    }
    expect(logged.join("\n")).not.toContain("v1:aa:bb:cc");
  });

  test("a payload encrypted under another key is refused, not decoded", async () => {
    await Creds.putCredential(AGENT, KEY, entry("tok-1"));
    process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
    __resetMasterKeyCache();
    const orig = console.error;
    console.error = () => {};
    try {
      expect(await Creds.credentialsFor(AGENT)).toEqual({});
    } finally {
      console.error = orig;
    }
  });
});
