import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as P from "../../src/db/personas";
import type { DesiredPersona } from "../../src/persona/effective";
import { SoulExtractionError } from "../../src/soul/extract";

// Postgres-only tables: run with SLAUDE_DB=pg (PGLite).
const SECRET = "t".repeat(32);
const TOKEN = "user-token-secret-value";
const cookie = (email: string) => `${AT_COOKIE}=${mintSession({ sub: "s", email }, "at", { secret: SECRET })}`;
const superadmin = cookie("lead@example.com");
const operator = cookie("alice@example.com");

let reloads = 0;
const pubsub = { publishReload: async () => { reloads++; return 1; } } as any;
const mk = (extractSoul?: (t: string) => Promise<unknown>) =>
  createPanelApi({ registry: null, pubsub, panelLock: null, chat: async () => {}, extractSoul });
const okExtract = async (t: string) => ({ extracted: t });
let panel = mk(okExtract);

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
  panel = mk(okExtract);
});
afterEach(() => {
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
    expect(text).not.toContain("user-token-");
    expect(text).not.toContain("http://x");
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

  test("only soul, model and mcp are overridable", async () => {
    await sync([row("ana")]);
    expect((await panel.fetch(put("/panel/api/personas/ana/overrides/slackUserId", { value: "UEVIL" }, superadmin)))!.status).toBe(422);
  });

  test("a soul override runs strict extraction; a failure refuses it", async () => {
    await sync([row("ana")]);
    const failing = mk(async () => { throw new SoulExtractionError("boom"); });
    expect((await failing.fetch(put("/panel/api/personas/ana/overrides/soul", { value: "new" }, superadmin)))!.status).toBe(502);
    expect((await P.effectivePersonas("default"))[0]!.overridden).toEqual([]);
    expect((await panel.fetch(put("/panel/api/personas/ana/overrides/soul", { value: "new" }, superadmin)))!.status).toBe(200);
    const ana = (await P.effectivePersonas("default"))[0]!;
    expect(ana.soulMd).toBe("new");
    expect(ana.soulJson).toEqual({ extracted: "new" });
  });

  test("runtime writes to a never-synced tenant are refused", async () => {
    expect((await panel.fetch(put("/panel/api/personas/ana/overrides/model", { value: "m" }, superadmin)))!.status).toBe(409);
  });

  test("an override on a missing persona is 404 for PUT and DELETE", async () => {
    await sync([row("ana")]);
    expect((await panel.fetch(put("/panel/api/personas/ghost/overrides/model", { value: "m" }, superadmin)))!.status).toBe(404);
    expect((await panel.fetch(del("/panel/api/personas/ghost/overrides/model", superadmin)))!.status).toBe(404);
  });

  test("DELETE clears an override and reloads", async () => {
    await sync([row("ana")]);
    await P.setOverride("default", "ana", "model", "m", "ops");
    const res = (await panel.fetch(del("/panel/api/personas/ana/overrides/model", superadmin)))!;
    expect(res.status).toBe(200);
    expect((await res.json() as any).removed).toBe(true);
    expect((await P.effectivePersonas("default"))[0]!.overridden).toEqual([]);
    expect(reloads).toBe(1);
  });

  test("a runtime onboard may not take a git-managed name", async () => {
    await sync([row("ana")]);
    expect((await panel.fetch(post("/panel/api/personas", { name: "ana", slackUserId: "UTESTUSER9", soul: "x" }, superadmin)))!.status).toBe(409);
  });

  test("a runtime onboard validates the name and identity, and never echoes the token", async () => {
    await sync([row("ana")]);
    expect((await panel.fetch(post("/panel/api/personas", { name: "Bad Name", slackUserId: "U1", soul: "x" }, superadmin)))!.status).toBe(422);
    expect((await panel.fetch(post("/panel/api/personas", { name: "zed", soul: "x" }, superadmin)))!.status).toBe(422);
    expect((await panel.fetch(post("/panel/api/personas", { name: "zed", slackUserId: "UANA", soul: "x" }, superadmin)))!.status).toBe(409);
    const logs: string[] = [];
    const spy = console.log; const spyE = console.error;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    console.error = (...a: unknown[]) => { logs.push(a.join(" ")); };
    let text: string;
    try {
      const res = (await panel.fetch(post("/panel/api/personas", { name: "zed", slackUserId: "UZED", soul: "x", userToken: TOKEN }, superadmin)))!;
      expect(res.status).toBe(200);
      text = await res.text();
    } finally { console.log = spy; console.error = spyE; }
    expect(text).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(reloads).toBe(1);
    const zed = (await P.effectivePersonas("default")).find((p) => p.name === "zed")!;
    expect(zed.origin).toBe("runtime");
    expect(zed.userToken).toBe(TOKEN);
    const listed = await (await panel.fetch(get("/panel/api/personas", superadmin)))!.text();
    expect(listed).not.toContain(TOKEN);
  });

  test("mutations without the anti-CSRF header are refused first", async () => {
    await sync([row("ana")]);
    expect((await panel.fetch(put("/panel/api/personas/ana/overrides/model", { value: "m" }, superadmin, { csrf: false })))!.status).toBe(403);
    expect((await panel.fetch(del("/panel/api/personas/ana/overrides/model", superadmin, { csrf: false })))!.status).toBe(403);
    expect((await panel.fetch(post("/panel/api/personas", { name: "zed", slackUserId: "UZED", soul: "x" }, superadmin, { csrf: false })))!.status).toBe(403);
    expect(reloads).toBe(0);
  });
});
