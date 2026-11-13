import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as P from "../../src/db/personas";
import { __resetPersonaRegistry, whenPersonaRegistrySettled } from "../../src/persona/registry";
import type { DesiredPersona } from "../../src/persona/effective";
import * as AuditEvents from "../../src/db/audit-events";
import { flushAudits } from "../../src/audit/emit";

// Postgres-only tables: run with SLAUDE_DB=pg (PGLite).
const SECRET = "t".repeat(32);
const TOKEN = "user-token-secret-value";
const cookie = (email: string) => `${AT_COOKIE}=${mintSession({ sub: "s", email }, "at", { secret: SECRET })}`;
const superadmin = cookie("lead@example.com");
const operator = cookie("alice@example.com");

let reloads = 0;
const pubsub = { publishReload: async () => { reloads++; return 1; } } as any;
const mk = () => createPanelApi({ registry: null, pubsub, panelLock: null, chat: async () => {} });
let panel = mk();

const req = (method: string, path: string, who: string, body?: unknown, o: { csrf?: boolean } = {}) =>
  new Request(`https://panel.example.com${path}`, {
    method,
    headers: { cookie: who, ...(o.csrf === false || method === "GET" ? {} : { "x-panel-csrf": "1" }), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (p: string, w: string) => req("GET", p, w);
const put = (p: string, b: unknown, w: string, o?: { csrf?: boolean }) => req("PUT", p, w, b, o);
const del = (p: string, w: string, o?: { csrf?: boolean }) => req("DELETE", p, w, undefined, o);
const post = (p: string, b: unknown, w: string, o?: { csrf?: boolean }) => req("POST", p, w, b, o);

const row = (name: string, over: Partial<DesiredPersona> = {}): DesiredPersona => ({
  name, slackUserId: `U${name.toUpperCase()}`, userToken: null, model: null,
  soulMd: `${name} soul`, soulJson: { approvers: [] }, mcp: null, origin: "git", tombstonedAt: null, ...over,
});
const sync = (rows: DesiredPersona[]) =>
  P.applySync("default", rows, { revision: "r1", committedAt: Date.parse("2026-10-01T10:00:00Z"), by: "ci" });

const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  if (process.env.SLAUDE_DB !== "pg") return;
  for (const k of ["SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_SUPERADMIN", "SLAUDE_PANEL_OPERATORS", "SLAUDE_MASTER_KEY"]) saved[k] = process.env[k];
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  __resetRoleCache();
  for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
  reloads = 0;
  panel = mk();
});
afterAll(async () => {
  // Leftover persona rows make later files see a populated table (fail-closed on a missing default).
  if (process.env.SLAUDE_DB !== "pg") return;
  for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
});
afterEach(async () => {
  // A reload installs a database-backed snapshot into module state: never let it
  // reach the next test file.
  await whenPersonaRegistrySettled();
  __resetPersonaRegistry();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetMasterKeyCache();
  __resetRoleCache();
});

describe.skipIf(process.env.SLAUDE_DB !== "pg")("panel persona overrides", () => {
  test("GET reports per-field git and live values, never a token", async () => {
    await sync([row("ana", { userToken: TOKEN, model: "m-git", mcp: { s: { url: "http://x" } } })]);
    await P.setOverride("default", "ana", "model", "m-live", "ops");
    const res = (await panel.fetch(get("/panel/api/personas", superadmin)))!;
    const text = await res.text();
    const body = JSON.parse(text);
    const ana = body.personas.find((p: any) => p.name === "ana");
    expect(ana.fields.model).toEqual({ git: "m-git", live: "m-live", overridden: true });
    expect(ana.fields.mcp).toEqual({ git: "present", live: "present", overridden: false });
    expect(ana.userToken).toBe("present");
    expect(ana.runsOn).toBeNull();
    expect(text).not.toContain("user-token-");
    expect(text).not.toContain("http://x");
  });

  test("GET reports runsOn (node labels spec §4.5)", async () => {
    await sync([row("ana", { runsOn: "engineering" })]);
    const body = await (await panel.fetch(get("/panel/api/personas", superadmin)))!.json() as any;
    expect(body.personas.find((p: any) => p.name === "ana").runsOn).toBe("engineering");
  });

  test("GET is readable by an operator (like sessions), still redacted", async () => {
    await sync([row("ana")]);
    expect((await panel.fetch(get("/panel/api/personas", operator)))!.status).toBe(200);
  });

  test("an operator is refused; a superadmin may override", async () => {
    await sync([row("ana")]);
    const p = "/panel/api/personas/ana/overrides/model";
    expect((await panel.fetch(put(p, { value: "m" }, operator)))!.status).toBe(403);
    expect((await panel.fetch(del(p, operator)))!.status).toBe(403);
    expect((await panel.fetch(post("/panel/api/personas", { name: "zed", slackUserId: "UZED", soul: "x" }, operator)))!.status).toBe(403);
    expect((await panel.fetch(put(p, { value: "m" }, superadmin)))!.status).toBe(200);
    expect((await P.effectivePersonas("default"))[0]!.model).toBe("m");
    expect(reloads).toBe(1);
  });

  test("PUT and DELETE record soul.override.set and soul.override.cleared, once each", async () => {
    await sync([row("ana")]);
    await db.run("DELETE FROM audit_events");
    const p = "/panel/api/personas/ana/overrides/model";
    expect((await panel.fetch(put(p, { value: "m" }, superadmin)))!.status).toBe(200);
    expect((await panel.fetch(del(p, superadmin)))!.status).toBe(200);
    // A second DELETE removes nothing, so it records nothing.
    expect((await panel.fetch(del(p, superadmin)))!.status).toBe(200);
    await flushAudits();
    const rows = (await AuditEvents.list({ action: "soul.override." })).items;
    expect(rows.map((e) => e.action).sort()).toEqual(["soul.override.cleared", "soul.override.set"]);
    for (const e of rows) {
      expect(e).toMatchObject({ actorKind: "operator", actorId: "lead@example.com", persona: "ana", targetKind: "soul_field", targetId: "model" });
      expect(e.details.panelAction).toBe("persona.override");
    }
  });

  test("only soul, model and mcp are overridable", async () => {
    await sync([row("ana")]);
    expect((await panel.fetch(put("/panel/api/personas/ana/overrides/slackUserId", { value: "UEVIL" }, superadmin)))!.status).toBe(422);
    expect((await panel.fetch(put("/panel/api/personas/ana/overrides/runsOn", { value: "finance" }, superadmin)))!.status).toBe(422);
  });

  test("a soul override for a persona with no agent.yaml is refused: its soul has no structure to keep", async () => {
    await sync([row("ana")]);
    const res = (await panel.fetch(put("/panel/api/personas/ana/overrides/soul", { value: "new" }, superadmin)))!;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("no agent.yaml");
    expect((await P.effectivePersonas("default"))[0]!.overridden).toEqual([]);
  });

  test("a persona cannot be onboarded from the console: it is defined by an agent.yaml and synced", async () => {
    const res = (await panel.fetch(post("/panel/api/personas", { name: "cat", soul: "s", slackUserId: "UTESTCAT1" }, superadmin)))!;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("agent.yaml");
  });

  test("mutations without the anti-CSRF header are refused first", async () => {
    await sync([row("ana")]);
    expect((await panel.fetch(put("/panel/api/personas/ana/overrides/model", { value: "m" }, superadmin, { csrf: false })))!.status).toBe(403);
    expect((await panel.fetch(del("/panel/api/personas/ana/overrides/model", superadmin, { csrf: false })))!.status).toBe(403);
    expect((await panel.fetch(post("/panel/api/personas", { name: "zed", slackUserId: "UZED", soul: "x" }, superadmin, { csrf: false })))!.status).toBe(403);
    expect(reloads).toBe(0);
  });
});

// R42 (M3): on sqlite the persona routes used to 500 on a missing table.
describe.skipIf(process.env.SLAUDE_DB === "pg")("panel persona routes on sqlite", () => {
  const saved2: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_SUPERADMIN", "SLAUDE_PANEL_OPERATORS"]) saved2[k] = process.env[k];
    process.env.SLAUDE_PANEL_SECRET = SECRET;
    process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
    process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
    __resetRoleCache();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved2)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    __resetRoleCache();
  });
  test("GET, POST, PUT and DELETE are 409 'persona sync requires Postgres'", async () => {
    const p = mk();
    for (const r of [
      get("/panel/api/personas", superadmin),
      post("/panel/api/personas", { name: "ana", soul: "x", slackUserId: "UTESTUSER1" }, superadmin),
      put("/panel/api/personas/ana/overrides/model", { value: "m" }, superadmin),
      del("/panel/api/personas/ana/overrides/model", superadmin),
    ]) {
      const res = (await p.fetch(r))!;
      expect(res.status).toBe(409);
      expect(((await res.json()) as any).error).toMatch(/persona sync requires Postgres/);
    }
  });
});
