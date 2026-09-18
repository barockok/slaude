/**
 * One-time import of on-disk MCP credentials into the store at gateway boot.
 *
 * Without it an upgrade loses every connected integration, the agent's and
 * every person's. The import is insert-only: once the store holds a row for an
 * owner and server it is authoritative, and an old file must never overwrite a
 * grant the gateway has since refreshed. That also makes it safe for several
 * gateway replicas to run it at once.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../../../src/db/schema";
import * as Accounts from "../../../src/db/accounts";
import * as Creds from "../../../src/db/mcp-credentials";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { importOnDiskCredentials } from "../../../src/gateway/core/credential-import";
import type { CredentialOwner } from "../../../src/agent/credential-owner";

const ISS = "https://idp.example.com";
const KEY = "workbench|abc";
const entry = (token: string, expiresAt = Date.now() + 3600_000) => ({
  serverName: "workbench",
  serverUrl: "https://mcp.example.com",
  clientId: "client-1",
  accessToken: token,
  refreshToken: `r-${token}`,
  expiresAt,
});

let root: string;
let agentHome: string;
let personasRoot: string;
let oauthRoot: string;
let personId: string;
const AGENT: CredentialOwner = { kind: "agent", tenant: "default", persona: "default" };

function writeCreds(dir: string, mcp: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ ...extra, mcpOAuth: mcp }), { mode: 0o600 });
}

const run = () => importOnDiskCredentials({ agentHome, personasRoot, oauthRoot });

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await db.run("DELETE FROM mcp_credentials");
  await Accounts._wipeForTests();
  personId = (await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "a@example.com" })).id;
  await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: personId, via: "signed-link" });
  root = mkdtempSync(join(tmpdir(), "cred-import-"));
  agentHome = join(root, "agent");
  personasRoot = join(root, "personas");
  oauthRoot = join(root, "oauth");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("importOnDiskCredentials", () => {
  test("imports the agent's credentials, a persona's, and a person's", async () => {
    writeCreds(agentHome, { [KEY]: entry("tok-agent") });
    writeCreds(join(personasRoot, "ana", ".claude"), { [KEY]: entry("tok-ana") });
    writeCreds(join(oauthRoot, "UTESTUSER1"), { [KEY]: entry("tok-person") });

    const r = await run();

    expect(r.imported).toBe(3);
    expect((await Creds.credentialsFor(AGENT))[KEY]!.accessToken).toBe("tok-agent");
    expect((await Creds.credentialsFor({ kind: "agent", tenant: "default", persona: "ana" }))[KEY]!.accessToken).toBe("tok-ana");
    expect((await Creds.credentialsFor({ kind: "account", accountId: personId }))[KEY]!.accessToken).toBe("tok-person");
  });

  test("a person's credentials nested under a persona import to their account", async () => {
    writeCreds(join(oauthRoot, "ana", "UTESTUSER1"), { [KEY]: entry("tok-person-ana") });
    const r = await run();
    expect(r.imported).toBe(1);
    expect((await Creds.credentialsFor({ kind: "account", accountId: personId }))[KEY]!.accessToken).toBe("tok-person-ana");
  });

  // The full grant is imported: the gateway needs the refresh token to refresh.
  test("the refresh token is imported with the access token", async () => {
    writeCreds(agentHome, { [KEY]: entry("tok-agent") });
    await run();
    expect((await Creds.credentialsFor(AGENT))[KEY]!.refreshToken).toBe("r-tok-agent");
  });

  test("only the mcpOAuth subtree is read; the agent's own login is not imported", async () => {
    writeCreds(agentHome, { [KEY]: entry("tok-agent") }, { claudeAiOauth: { accessToken: "anthropic-login" } });
    await run();
    const n = await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_credentials");
    expect(Number(n!.n)).toBe(1);
  });

  test("a person with no bound account is skipped, and the file is left in place", async () => {
    writeCreds(join(oauthRoot, "UTESTUSER9"), { [KEY]: entry("tok-orphan") });
    const r = await run();
    expect(r.skippedNoAccount).toBe(1);
    expect(r.imported).toBe(0);
    expect(existsSync(join(oauthRoot, "UTESTUSER9", ".credentials.json"))).toBe(true);
  });

  // The on-disk path carries no workspace. If one Slack id is bound to two
  // different accounts in two workspaces, there is no safe owner to pick.
  test("a Slack id bound to different accounts in different workspaces is skipped, not guessed", async () => {
    const other = (await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "b@example.com" })).id;
    await Accounts.linkSlackIdentity({ teamId: "TOTHERTEAM", slackUserId: "UTESTUSER1", accountId: other, via: "signed-link" });
    writeCreds(join(oauthRoot, "UTESTUSER1"), { [KEY]: entry("tok-person") });

    const r = await run();

    expect(r.skippedAmbiguous).toBe(1);
    expect(await Creds.credentialsFor({ kind: "account", accountId: personId })).toEqual({});
    expect(await Creds.credentialsFor({ kind: "account", accountId: other })).toEqual({});
  });

  // Rollback safety: the previous version must still find its files.
  test("imported files are left in place, unchanged", async () => {
    writeCreds(agentHome, { [KEY]: entry("tok-agent") });
    const before = readFileSync(join(agentHome, ".credentials.json"), "utf8");
    await run();
    expect(readFileSync(join(agentHome, ".credentials.json"), "utf8")).toBe(before);
  });

  // The store is authoritative once it holds a row. A file with a later nominal
  // expiry must not replace a grant the gateway has since refreshed.
  test("never overwrites anything already in the store", async () => {
    await Creds.putCredential(AGENT, KEY, entry("refreshed-since", Date.now() + 60_000));
    writeCreds(agentHome, { [KEY]: entry("stale-on-disk", Date.now() + 9e9) });

    const r = await run();

    expect(r.imported).toBe(0);
    expect((await Creds.credentialsFor(AGENT))[KEY]!.accessToken).toBe("refreshed-since");
  });

  test("running twice imports nothing the second time", async () => {
    writeCreds(agentHome, { [KEY]: entry("tok-agent") });
    expect((await run()).imported).toBe(1);
    expect((await run()).imported).toBe(0);
  });

  test("replicas running it at the same moment still produce one row", async () => {
    writeCreds(agentHome, { [KEY]: entry("tok-agent") });
    await Promise.all([run(), run(), run(), run()]);
    const n = await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_credentials");
    expect(Number(n!.n)).toBe(1);
  });

  test("an unreadable or malformed file is counted and skipped, not fatal", async () => {
    mkdirSync(agentHome, { recursive: true });
    writeFileSync(join(agentHome, ".credentials.json"), "{not json", { mode: 0o600 });
    writeCreds(join(personasRoot, "ana", ".claude"), { [KEY]: { serverName: "workbench" } });
    writeCreds(join(oauthRoot, "UTESTUSER1"), { [KEY]: entry("tok-person") });

    const r = await run();

    expect(r.imported).toBe(1);
    expect(r.skippedUnreadable).toBe(2);
  });

  test("missing directories are fine", async () => {
    const r = await run();
    expect(r).toEqual({ imported: 0, skippedNoAccount: 0, skippedAmbiguous: 0, skippedUnreadable: 0 });
  });

  test("the log names counts, never a Slack id or a token", async () => {
    writeCreds(agentHome, { [KEY]: entry("tok-agent") });
    writeCreds(join(oauthRoot, "UTESTUSER9"), { [KEY]: entry("tok-orphan") });
    const logged: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    console.log = capture; console.warn = capture; console.error = capture;
    try {
      await run();
    } finally {
      Object.assign(console, orig);
    }
    const text = logged.join("\n");
    expect(text).not.toMatch(/UTESTUSER|tok-|r-tok/);
    expect(text).toMatch(/imported/);
  });
});
