import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as P from "../../src/db/personas";
import { __resetPersonaRegistry, whenPersonaRegistrySettled } from "../../src/persona/registry";
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

  test("only soul, model and mcp are overridable", async () => {
    await sync([row("ana")]);
    expect((await panel.fetch(put("/panel/api/personas/ana/overrides/slackUserId", { value: "UEVIL" }, superadmin)))!.status).toBe(422);
    expect((await panel.fetch(put("/panel/api/personas/ana/overrides/runsOn", { value: "finance" }, superadmin)))!.status).toBe(422);
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

  test("an extraction failure's 502 is generic; the provider text stays in the server log", async () => {
    await sync([row("ana")]);
    const failing = mk(async () => { throw new SoulExtractionError("soul extraction failed: extractor http 500: provider-body-detail"); });
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await failing.fetch(put("/panel/api/personas/ana/overrides/soul", { value: "new" }, superadmin));
      expect(res!.status).toBe(502);
      const text = await res!.text();
      expect(text).not.toContain("provider-body-detail");
      expect(text).not.toContain("extractor http");
      expect(JSON.parse(text).error).toMatch(/soul extraction failed/);
      expect(err.mock.calls.some((c) => c.map(String).join(" ").includes("provider-body-detail"))).toBe(true);
    } finally {
      err.mockRestore();
    }
    // Onboarding a persona goes through the same mapping.
    const onboard = await failing.fetch(post("/panel/api/personas", { name: "cat", soul: "s", slackUserId: "UTESTCAT1" }, superadmin));
    expect(onboard!.status).toBe(502);
    expect(await onboard!.text()).not.toContain("provider-body-detail");
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

  const HTTP = { mcpServers: { svc: { type: "http", url: "https://mcp.example.com", headers: { a: "b" } } } };
  const STDIO = { mcpServers: { evil: { type: "stdio", command: "sh", args: ["-c", "x"] } } };
  const SSE = { mcpServers: { s1: { type: "sse", url: "https://mcp.example.com" } } };

  test("an mcp override is http-only", async () => {
    await sync([row("ana")]);
    const p = "/panel/api/personas/ana/overrides/mcp";
    for (const bad of [STDIO, SSE]) {
      const res = (await panel.fetch(put(p, { value: bad }, superadmin)))!;
      expect(res.status).toBe(422);
      const msg = ((await res.json()) as any).error as string;
      expect(msg).not.toContain("sh");
      expect((await P.effectivePersonas("default"))[0]!.overridden).toEqual([]);
    }
    expect((await panel.fetch(put(p, { value: HTTP }, superadmin)))!.status).toBe(200);
  });

  test("a runtime onboard's mcp is http-only", async () => {
    await sync([row("ana")]);
    const mk1 = (mcp: unknown) => post("/panel/api/personas", { name: "zed", slackUserId: "UZED", soul: "x", mcp }, superadmin);
    const res = (await panel.fetch(mk1(STDIO)))!;
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("evil");
    expect((await panel.fetch(mk1(SSE)))!.status).toBe(422);
    expect((await P.effectivePersonas("default")).some((p) => p.name === "zed")).toBe(false);
    expect((await panel.fetch(mk1(HTTP)))!.status).toBe(200);
  });

  test("a bad persona name in the path is 422, after the role check", async () => {
    await sync([row("ana")]);
    for (const n of ["%E0", "a%2Fb"]) {
      expect((await panel.fetch(put(`/panel/api/personas/${n}/overrides/model`, { value: "m" }, superadmin)))!.status).toBe(422);
      expect((await panel.fetch(del(`/panel/api/personas/${n}/overrides/model`, superadmin)))!.status).toBe(422);
      expect((await panel.fetch(put(`/panel/api/personas/${n}/overrides/model`, { value: "m" }, operator)))!.status).toBe(403);
    }
  });

  test("PUT and DELETE both 409 on a never-synced tenant", async () => {
    const p = "/panel/api/personas/ana/overrides/model";
    expect((await panel.fetch(put(p, { value: "m" }, superadmin)))!.status).toBe(409);
    expect((await panel.fetch(del(p, superadmin)))!.status).toBe(409);
  });

  test("a runtime onboard rejects an empty model", async () => {
    await sync([row("ana")]);
    expect((await panel.fetch(post("/panel/api/personas", { name: "zed", slackUserId: "UZED", soul: "x", model: "" }, superadmin)))!.status).toBe(422);
  });

  test("GET skips a persona a racing sync added between the two reads", async () => {
    await sync([row("ana"), row("bea")]);
    const real = P.desiredPersonas;
    const spy = spyOn(P, "desiredPersonas").mockImplementation(async (...a) => (await real(...a)).filter((d) => d.name !== "bea"));
    try {
      const body = (await (await panel.fetch(get("/panel/api/personas", superadmin)))!.json()) as any;
      expect(body.personas.map((p: any) => p.name)).toEqual(["ana"]);
    } finally { spy.mockRestore(); }
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
    const p = mk(okExtract);
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
