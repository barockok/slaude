// The runtime bundle is built from effective state for a managed tenant.
// DB-dependent: run with SLAUDE_DB=pg.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../../../src/db/schema";
import { __resetMasterKeyCache, encrypt } from "../../../src/db/crypto";
import { paths } from "../../../src/config/home";
import * as P from "../../../src/db/personas";
import type { DesiredPersona } from "../../../src/persona/effective";
import { __resetPersonaRegistry } from "../../../src/persona/registry";
import { handleTenantRuntime } from "../../../src/gateway/api/tenants";

const isPg = process.env.SLAUDE_DB === "pg";

const row = (name: string, extra: Partial<DesiredPersona> = {}) => ({
  name, slackUserId: `U${name.toUpperCase()}`, userToken: null, model: null,
  soulMd: `${name} soul`, soulJson: null, mcp: null, origin: "git" as const, tombstonedAt: null, ...extra,
});
const meta = (rev: string, iso: string) => ({ revision: rev, committedAt: Date.parse(iso), by: "ci" });
const req = () => new Request("https://x/");

function writeFsPersona(name: string) {
  const dir = join(paths.personas, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ slackUserId: "UGHOST", name }));
  writeFileSync(join(dir, "SOUL.md"), "ghost soul");
}

const savedKey = process.env.SLAUDE_MASTER_KEY;

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  if (isPg) for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
});

afterEach(async () => {
  // leave the tenant unmanaged for the other suites sharing this database
  if (isPg) for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
  __resetPersonaRegistry();
  rmSync(paths.personas, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
  else process.env.SLAUDE_MASTER_KEY = savedKey;
  __resetMasterKeyCache();
});

describe.skipIf(!isPg)("runtime bundle from effective state", () => {
  test("an override changes the bundle and its ETag", async () => {
    await P.applySync("default", [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    const a = await handleTenantRuntime(req(), "default", "ana");
    await P.setOverride("default", "ana", "soul", { soulMd: "live soul", soulJson: null }, "ops");
    const b = await handleTenantRuntime(req(), "default", "ana");
    expect(((await b.json()) as any).soulMd).toBe("live soul");
    expect(b.headers.get("etag")).not.toBe(a.headers.get("etag"));
  });

  // R42 (I2): the persona's effective model reaches the node, marked managed.
  test("a managed bundle is marked managed and carries the effective model", async () => {
    await P.applySync("default", [row("ana", { model: "m-git" })], meta("r1", "2026-10-01T10:00:00Z"));
    let b = (await (await handleTenantRuntime(req(), "default", "ana")).json()) as any;
    expect(b.managed).toBe(true);
    expect(b.defaultModel).toBe("m-git");
    await P.setOverride("default", "ana", "model", "m-override", "ops");
    b = (await (await handleTenantRuntime(req(), "default", "ana")).json()) as any;
    expect(b.defaultModel).toBe("m-override");
  });

  test("a managed named persona's bundle carries its Slack user id", async () => {
    await P.applySync("default", [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    const b = (await (await handleTenantRuntime(req(), "default", "ana")).json()) as any;
    expect(b.slackUserId).toBe("UANA");
  });

  test("a tombstoned persona has no bundle", async () => {
    await P.applySync("default", [row("ana"), row("bea")], meta("r1", "2026-10-01T10:00:00Z"));
    await P.applySync("default", [row("ana")], meta("r2", "2026-10-01T11:00:00Z"));
    expect((await handleTenantRuntime(req(), "default", "bea")).status).toBe(404);
  });

  test("a managed tenant never falls back to a persona directory on disk", async () => {
    writeFsPersona("ghost");
    await P.applySync("default", [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    expect((await handleTenantRuntime(req(), "default", "ghost")).status).toBe(404);
  });

  // R40-I3: nodes never consume a persona's mcp, so a managed bundle never ships it.
  test("a managed bundle ships mcpJson null, never the resolved mcp", async () => {
    const mcp = { mcpServers: { x: { type: "http", url: "https://x.test/mcp", headers: { a: "resolved-header-secret" } } } };
    await P.applySync("default", [row("ana", { mcp })], meta("r1", "2026-10-01T10:00:00Z"));
    const res = await handleTenantRuntime(req(), "default", "ana");
    const text = await res.text();
    expect(JSON.parse(text).mcpJson).toBeNull();
    expect(text).not.toContain("resolved-header-secret");
  });

  test("the bundle never carries the user token", async () => {
    await P.applySync("default", [row("ana", { userToken: "user-token-secret-value" })], meta("r1", "2026-10-01T10:00:00Z"));
    const text = await (await handleTenantRuntime(req(), "default", "ana")).text();
    expect(text).not.toContain("user-token-secret-value");
    expect(text).not.toContain("userToken");
  });

  test("a DB error fails closed: it never serves a disk-tier bundle", async () => {
    writeFsPersona("ghost");
    const spy = spyOn(P, "isManaged").mockRejectedValue(new Error("connection reset"));
    try {
      await expect(handleTenantRuntime(req(), "default", "ghost")).rejects.toThrow("connection reset");
    } finally {
      spy.mockRestore();
    }
  });

  test("effective present but raw row absent: still the effective bundle, with tenant-wide creds, never disk", async () => {
    writeFsPersona("ghost");
    await P.applySync("default", [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    await db.run(`INSERT INTO provider_creds (id, tenant_id, persona_id, kind, value, created_at, updated_at) VALUES ('pc1', ?, NULL, 'api_key', ?, 1, 1)`,
      ["default", encrypt("tenant-wide-key")]);
    const eff = { ...(await P.effectivePersonas("default"))[0]!, name: "ghost", soulMd: "effective ghost soul" };
    const spy = spyOn(P, "effectivePersonas").mockResolvedValue([eff]);
    try {
      const res = await handleTenantRuntime(req(), "default", "ghost");
      expect(res.status).toBe(200);
      const b = (await res.json()) as any;
      expect(b.soulMd).toBe("effective ghost soul");
      expect(b.providerCreds.apiKey).toBe("tenant-wide-key");
    } finally {
      spy.mockRestore();
      await db.run(`DELETE FROM provider_creds WHERE tenant_id = ?`, ["default"]);
    }
  });
});
