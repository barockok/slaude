// Provider credentials by reference, resolved at bundle build (WS-A §5, §8).
// DB-dependent: run with SLAUDE_DB=pg.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { db } from "../../../src/db/schema";
import { __resetMasterKeyCache, encrypt } from "../../../src/db/crypto";
import * as P from "../../../src/db/personas";
import type { DesiredPersona } from "../../../src/persona/effective";
import {
  __resetEtagKeyForTests, bundleEtagForTests, handleTenantRuntime, setProviderSecretResolver,
} from "../../../src/gateway/api/tenants";
import { createSecretResolver, SecretResolutionError, type ResolveEvent } from "../../../src/secrets";

const isPg = process.env.SLAUDE_DB === "pg";
const T = "default";

const row = (name: string, extra: Partial<DesiredPersona> = {}): DesiredPersona => ({
  name, slackUserId: `U${name.toUpperCase()}`, userToken: null, model: "m-1",
  soulMd: `${name} soul`, soulJson: null, mcp: null, origin: "git", tombstonedAt: null, ...extra,
});
const meta = (rev: string, iso: string) => ({ revision: rev, committedAt: Date.parse(iso), by: "ci" });
const req = (etag?: string) => new Request("https://x/", etag ? { headers: { "if-none-match": etag } } : undefined);

let events: ResolveEvent[] = [];
const install = (env: Record<string, string>) =>
  setProviderSecretResolver(createSecretResolver({ env, onEvent: (e) => events.push(e) }));

async function cred(id: string, persona: string | null, kind: string, value: string) {
  const personaId = persona
    ? (await db.one<{ id: string }>(`SELECT id FROM personas WHERE tenant_id = ? AND name = ?`, [T, persona]))!.id
    : null;
  await db.run(
    `INSERT INTO provider_creds (id, tenant_id, persona_id, kind, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)`,
    [id, T, personaId, kind, encrypt(value)]);
}

const savedKey = process.env.SLAUDE_MASTER_KEY;
async function clean() {
  if (!isPg) return;
  for (const t of ["provider_creds", "persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
}

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  events = [];
  await clean();
});

afterEach(async () => {
  await clean();
  setProviderSecretResolver(null);
  if (savedKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
  else process.env.SLAUDE_MASTER_KEY = savedKey;
  __resetMasterKeyCache();
});

describe.skipIf(!isPg)("runtime bundle: provider references", () => {
  test("each persona gets its own key from its own reference", async () => {
    install({ PERSONA_ANA_KEY: "ana-key-value", PERSONA_BEA_KEY: "bea-key-value" });
    await P.applySync(T, [
      row("default"),
      row("ana", { provider: { apiKey: "env://PERSONA_ANA_KEY", baseUrl: "https://llm.example.com" } }),
      row("bea", { provider: { apiKey: "env://PERSONA_BEA_KEY" } }),
    ], meta("r1", "2026-10-01T10:00:00Z"));
    const a = (await (await handleTenantRuntime(req(), T, "ana")).json()) as any;
    const b = (await (await handleTenantRuntime(req(), T, "bea")).json()) as any;
    expect(a.providerCreds).toEqual({ apiKey: "ana-key-value", baseUrl: "https://llm.example.com" });
    expect(b.providerCreds).toEqual({ apiKey: "bea-key-value" });
  });

  // M-1: a declared provider is an atomic set. Nothing from the rows (or the
  // node) is mixed into it, so its key only ever goes to its own host.
  test("a persona that declares provider gets ONLY its own fields, never a row's", async () => {
    install({ PERSONA_ANA_KEY: "ref-key" });
    await P.applySync(T, [row("default"), row("ana", { provider: { apiKey: "env://PERSONA_ANA_KEY" } })],
      meta("r1", "2026-10-01T10:00:00Z"));
    await cred("c1", null, "api_key", "tenant-key");
    await cred("c2", null, "base_url", "https://tenant.example.com");
    await cred("c3", null, "oauth_token", "tenant-oauth");
    await cred("c4", "ana", "base_url", "https://persona.example.com");
    const b = (await (await handleTenantRuntime(req(), T, "ana")).json()) as any;
    expect(b.providerCreds).toEqual({ apiKey: "ref-key" });
    expect(b.ownProvider).toBe(true);
  });

  test("a tenant-row key is never paired with a persona's baseUrl", async () => {
    install({ PERSONA_ANA_KEY: "ana-key" });
    await P.applySync(T, [row("default"), row("ana", { provider: { baseUrl: "https://llm.example.com", apiKey: "env://PERSONA_ANA_KEY" } })],
      meta("r1", "2026-10-01T10:00:00Z"));
    await cred("c1", null, "auth_token", "tenant-auth-token");
    const b = (await (await handleTenantRuntime(req(), T, "ana")).json()) as any;
    expect(b.providerCreds).toEqual({ apiKey: "ana-key", baseUrl: "https://llm.example.com" });
  });

  test("without a declared provider: persona row > tenant row > none, per field; auth_token is read", async () => {
    install({});
    await P.applySync(T, [row("default"), row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    await cred("c1", null, "api_key", "tenant-key");
    await cred("c2", null, "base_url", "https://tenant.example.com");
    await cred("c3", null, "oauth_token", "tenant-oauth");
    await cred("c4", "ana", "base_url", "https://persona.example.com");
    await cred("c5", "ana", "auth_token", "persona-auth-token");
    const b = (await (await handleTenantRuntime(req(), T, "ana")).json()) as any;
    expect(b.providerCreds).toEqual({
      apiKey: "tenant-key",
      baseUrl: "https://persona.example.com",
      oauthToken: "tenant-oauth",
      authToken: "persona-auth-token",
    });
    expect(b.ownProvider).toBeUndefined();
  });

  // R2-F7: re-validated at bundle build, whatever wrote the row.
  test("a stored baseUrl outside the policy is refused at bundle build, literal or resolved", async () => {
    install({ PERSONA_ANA_KEY: "k", PERSONA_ANA_URL: "http://169.254.169.254/latest" });
    for (const baseUrl of ["file:///etc/passwd", "http://169.254.169.254/latest", "env://PERSONA_ANA_URL"]) {
      await clean();
      await P.applySync(T, [row("default"), row("ana", { provider: { baseUrl, apiKey: "env://PERSONA_ANA_KEY" } })],
        meta("r1", "2026-10-01T10:00:00Z"));
      const res = await handleTenantRuntime(req(), T, "ana");
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(body).not.toContain("passwd");
      expect(body).not.toContain("169.254");
    }
  });

  test("a stored provider with no credential is refused at bundle build", async () => {
    install({});
    await P.applySync(T, [row("default"), row("ana", { provider: { baseUrl: "https://llm.example.com" } })],
      meta("r1", "2026-10-01T10:00:00Z"));
    expect((await handleTenantRuntime(req(), T, "ana")).status).toBe(503);
  });

  test("a resolution failure is a 503 with a fixed body: no reason, path or value", async () => {
    install({});
    await P.applySync(T, [row("default"), row("ana", { provider: { apiKey: "env://PERSONA_ANA_MISSING" } })],
      meta("r1", "2026-10-01T10:00:00Z"));
    const res = await handleTenantRuntime(req(), T, "ana");
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "provider credentials unavailable", code: "PROVIDER_CREDENTIALS_UNAVAILABLE", transient: false });
    expect(res.headers.get("retry-after")).toBeNull();
    expect(events).toEqual([expect.objectContaining({ persona: "ana", scheme: "env", outcome: "error", reason: "env_missing" })]);
  });

  // R2-F4: Vault not answering is transient: the node may retry.
  test("a transient resolution failure says so, with Retry-After", async () => {
    setProviderSecretResolver({
      resolve: async () => { throw new SecretResolutionError("unreachable", "vault unreachable"); },
    });
    await P.applySync(T, [row("default"), row("ana", { provider: { apiKey: "vault://secret/slaude/personas/ana#k" } })],
      meta("r1", "2026-10-01T10:00:00Z"));
    const res = await handleTenantRuntime(req(), T, "ana");
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).transient).toBe(true);
    expect(res.headers.get("retry-after")).toBe("5");
  });

  test("a vault:// reference on a gateway without Vault fails the same way", async () => {
    install({});
    await P.applySync(T, [row("default"), row("ana", { provider: { apiKey: "vault://secret/slaude/personas/ana#k" } })],
      meta("r1", "2026-10-01T10:00:00Z"));
    expect((await handleTenantRuntime(req(), T, "ana")).status).toBe(503);
  });

  test("resolve events never carry the path, field or value", async () => {
    install({ PERSONA_ANA_KEY: "ana-key-value" });
    await P.applySync(T, [row("default"), row("ana", { provider: { apiKey: "env://PERSONA_ANA_KEY" } })],
      meta("r1", "2026-10-01T10:00:00Z"));
    await handleTenantRuntime(req(), T, "ana");
    const text = JSON.stringify(events);
    expect(events).toHaveLength(1);
    expect(text).not.toContain("ana-key-value");
    expect(text).not.toContain("PERSONA_ANA_KEY");
  });

  test("the ETag is an HMAC of the body, not its bare hash, and moves when a value rotates", async () => {
    const env: Record<string, string> = { PERSONA_ANA_KEY: "v1" };
    setProviderSecretResolver(createSecretResolver({ env, onEvent: () => {} }));
    await P.applySync(T, [row("default"), row("ana", { provider: { apiKey: "env://PERSONA_ANA_KEY" } })],
      meta("r1", "2026-10-01T10:00:00Z"));
    const r1 = await handleTenantRuntime(req(), T, "ana");
    const body1 = await r1.text();
    const etag1 = r1.headers.get("etag")!;
    expect(etag1).not.toBe(`"${createHash("sha256").update(body1).digest("hex")}"`);
    expect((await handleTenantRuntime(req(etag1), T, "ana")).status).toBe(304);
    env.PERSONA_ANA_KEY = "v2";
    const r2 = await handleTenantRuntime(req(etag1), T, "ana");
    expect(r2.status).toBe(200);
    expect(r2.headers.get("etag")).not.toBe(etag1);
    expect(((await r2.json()) as any).providerCreds.apiKey).toBe("v2");
  });

  test("without a master key each process keys its ETag with its own random key", async () => {
    install({ PERSONA_ANA_KEY: "v1" });
    await P.applySync(T, [row("default"), row("ana", { provider: { apiKey: "env://PERSONA_ANA_KEY" } })],
      meta("r1", "2026-10-01T10:00:00Z"));
    const res = await handleTenantRuntime(req(), T, "ana"); // reads rows under the master key
    const body = await res.text();
    delete process.env.SLAUDE_MASTER_KEY;
    __resetMasterKeyCache();
    __resetEtagKeyForTests();
    const a = bundleEtagForTests(body);
    expect(bundleEtagForTests(body)).toBe(a); // stable within a process
    __resetEtagKeyForTests(); // a second process
    expect(bundleEtagForTests(body)).not.toBe(a);
  });

  test("the ETag is keyed by SLAUDE_MASTER_KEY: another key, another tag for the same body", async () => {
    install({ PERSONA_ANA_KEY: "v1" });
    await P.applySync(T, [row("default"), row("ana", { provider: { apiKey: "env://PERSONA_ANA_KEY" } })],
      meta("r1", "2026-10-01T10:00:00Z"));
    const e1 = (await handleTenantRuntime(req(), T, "ana")).headers.get("etag");
    process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
    __resetMasterKeyCache();
    const e2 = (await handleTenantRuntime(req(), T, "ana")).headers.get("etag");
    expect(e2).not.toBe(e1);
  });
});
