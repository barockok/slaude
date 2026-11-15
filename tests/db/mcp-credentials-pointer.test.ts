/**
 * Credentials dual write (slice F, task 2): a person's credential row also
 * records which user it belongs to. Bookkeeping only: every put keeps working
 * when the pointer cannot be resolved, payload bytes are exactly what they were,
 * and an agent row never gets one.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Accounts from "../../src/db/accounts";
import * as Creds from "../../src/db/mcp-credentials";
import * as Domain from "../../src/db/domain";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { settlePointerWrites } from "../../src/db/credential-pointers";
import { db } from "../../src/db/schema";
import { cleanWorld } from "../helpers/person-world";
import type { CredentialOwner } from "../../src/agent/credential-owner";

const ISS = "https://idp.example.com";
const entry = (token: string) => ({ serverName: "workbench", serverUrl: "https://mcp.example.com", accessToken: token, refreshToken: "r-1", expiresAt: Date.now() + 3600_000 });
const AGENT: CredentialOwner = { kind: "agent", tenant: "t1", persona: "default" };
const pointer = async (accountId: string, serverKey = "k") => {
  await settlePointerWrites();
  return (await db.one<{ user_id: string | null }>("SELECT user_id FROM mcp_credentials WHERE account_id = ? AND server_key = ?", [accountId, serverKey]))?.user_id ?? null;
};
let accountId: string;
let userId: string;

beforeEach(async () => {
  process.env.SLAUDE_CREDENTIAL_POINTERS = "on";
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await db.run("DELETE FROM mcp_credentials");
  await Accounts._wipeForTests();
  accountId = (await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "a@example.com" })).id;
  userId = (await Domain.findBinding({ service: "oidc", kind: "subject", workspace: ISS, value: "sub-1" }))!.user_id;
});
afterEach(async () => {
  await settlePointerWrites();
  delete process.env.SLAUDE_CREDENTIAL_POINTERS;
  spyOn(console, "warn").mockRestore();
});

describe("credentials dual write", () => {
  test("off by default: no pointer, no extra work, nothing scheduled", async () => {
    delete process.env.SLAUDE_CREDENTIAL_POINTERS;
    const owner: CredentialOwner = { kind: "account", accountId };
    const find = spyOn(Domain, "findBinding");
    await Creds.putCredential(owner, "k", entry("t1"));
    await Creds.putCredentialIfNewer(owner, "k2", entry("t2"));
    await Creds.putCredentialIfAbsent(owner, "k3", entry("t3"));
    await settlePointerWrites();
    expect(find).not.toHaveBeenCalled();
    find.mockRestore();
    expect(await pointer(accountId, "k")).toBeNull();
    expect(Object.keys(await Creds.credentialsFor(owner)).sort()).toEqual(["k", "k2", "k3"]);
  });

  test("the write never waits for the pointer: a stalled resolver does not delay the credential write", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = spyOn(Domain, "findBinding").mockImplementation(async () => {
      await gate;
      return null;
    });
    try {
      const t0 = Date.now();
      await Creds.putCredential({ kind: "account", accountId }, "k", entry("t1"));
      expect(Date.now() - t0).toBeLessThan(500);
      expect((await Creds.credentialsFor({ kind: "account", accountId })).k!.accessToken).toBe("t1");
    } finally {
      release();
      await settlePointerWrites();
      slow.mockRestore();
    }
  });

  test("putCredential, putCredentialIfNewer and putCredentialIfAbsent store the pointer", async () => {
    const owner: CredentialOwner = { kind: "account", accountId };
    await Creds.putCredential(owner, "k", entry("t1"));
    expect(await pointer(accountId, "k")).toBe(userId);
    await Creds.putCredentialIfNewer(owner, "k2", entry("t2"));
    expect(await pointer(accountId, "k2")).toBe(userId);
    await Creds.putCredentialIfAbsent(owner, "k3", entry("t3"));
    expect(await pointer(accountId, "k3")).toBe(userId);
  });

  test("an agent row never gets a pointer", async () => {
    await Creds.putCredential(AGENT, "k", entry("tok"));
    await Creds.putCredentialIfNewer(AGENT, "k2", entry("tok"));
    await Creds.putCredentialIfAbsent(AGENT, "k3", entry("tok"));
    const rows = await db.query<{ user_id: string | null }>("SELECT user_id FROM mcp_credentials WHERE agent_tenant = 't1'");
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.user_id === null)).toBe(true);
  });

  test("an unresolvable user leaves the pointer NULL and the credential stored", async () => {
    await db.run("DELETE FROM bindings WHERE service = 'oidc'");
    await Creds.putCredential({ kind: "account", accountId }, "k", entry("t1"));
    expect(await pointer(accountId)).toBeNull();
    expect((await Creds.credentialsFor({ kind: "account", accountId })).k!.accessToken).toBe("t1");
  });

  test("a resolver failure never fails the write, and the credential reads back", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    const bad = spyOn(Domain, "findBinding").mockImplementation(async () => {
      throw new Error("boom");
    });
    try {
      await Creds.putCredential({ kind: "account", accountId }, "k", entry("t1"));
      expect(await Creds.putCredentialIfNewer({ kind: "account", accountId }, "k2", entry("t2"))).toBe(true);
      expect(await Creds.putCredentialIfAbsent({ kind: "account", accountId }, "k3", entry("t3"))).toBe(true);
      await settlePointerWrites(); // the background writes run (and fail) while the resolver is still broken
    } finally {
      bad.mockRestore();
    }
    expect(await pointer(accountId)).toBeNull();
    expect(Object.keys(await Creds.credentialsFor({ kind: "account", accountId })).sort()).toEqual(["k", "k2", "k3"]);
  });

  test("payload bytes, expiry and reads are exactly what they were without a pointer", async () => {
    const e = entry("tok-x");
    await Creds.putCredential({ kind: "account", accountId }, "k", e);
    const row = await db.one<{ payload: string; expires_at: number }>("SELECT payload, expires_at FROM mcp_credentials WHERE account_id = ?", [accountId]);
    const { decrypt } = await import("../../src/db/crypto");
    expect(JSON.parse(decrypt(row!.payload))).toEqual(e);
    expect(Number(row!.expires_at)).toBe(e.expiresAt);
    expect(await Creds.storedExpiry({ kind: "account", accountId }, "k")).toBe(e.expiresAt);
    expect(await Creds.credentialExpiries({ kind: "account", accountId })).toEqual({ k: e.expiresAt });
  });

  test("putCredentialIfNewer that loses the race leaves an existing pointer alone", async () => {
    const owner: CredentialOwner = { kind: "account", accountId };
    await Creds.putCredential(owner, "k", entry("new"));
    await settlePointerWrites();
    const other = await Domain.ensureUser({});
    await db.run("UPDATE mcp_credentials SET user_id = ? WHERE account_id = ?", [other.id, accountId]);
    const older = { ...entry("old"), expiresAt: 1 };
    expect(await Creds.putCredentialIfNewer(owner, "k", older)).toBe(false);
    expect(await pointer(accountId)).toBe(other.id);
  });

  test("a login that creates the account's user fills the pointers of rows written before it knew the user", async () => {
    await db.run("DELETE FROM bindings WHERE service = 'oidc'");
    await Creds.putCredential({ kind: "account", accountId }, "k", entry("t1"));
    expect(await pointer(accountId)).toBeNull();
    await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "a@example.com" });
    const u = (await Domain.findBinding({ service: "oidc", kind: "subject", workspace: ISS, value: "sub-1" }))!.user_id;
    expect(await pointer(accountId)).toBe(u);
  });

  test("a link fills pointers too", async () => {
    await db.run("DELETE FROM bindings WHERE service = 'oidc'");
    await Creds.putCredential({ kind: "account", accountId }, "k", entry("t1"));
    const r = await Accounts.linkSlackIdentity({ teamId: "T0EXAMPLE", slackUserId: "U0EXAMPLE", accountId, via: "test" });
    expect(r.ok).toBe(true);
    expect(await pointer(accountId)).not.toBeNull();
  });
});

afterAll(async () => {
  await cleanWorld();
});
