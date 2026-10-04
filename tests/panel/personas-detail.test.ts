/**
 * GET /panel/api/personas/:name (WS-C §4.4.1): one persona's definition for any
 * authenticated operator, built from presence and references only.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as P from "../../src/db/personas";
import { putCredential } from "../../src/db/mcp-credentials";
import { oauthKey } from "../../src/agent/mcp-oauth/store";
import { paths } from "../../src/config/home";
import { __resetPersonaRegistry, whenPersonaRegistrySettled } from "../../src/persona/registry";
import type { DesiredPersona } from "../../src/persona/effective";

const SECRET = "t".repeat(32);
const cookie = (email: string) => `${AT_COOKIE}=${mintSession({ sub: "s", email }, "at", { secret: SECRET })}`;
const superadmin = cookie("lead@example.com");
const operator = cookie("alice@example.com");
const unlisted = cookie("eve@example.com");

// Every secret a persona's stored configuration can hold. None may appear in a
// response body or anything the request logs (audit included).
const S = {
  userToken: "USERTOKEN-SECRET-0",
  query: "QS-SECRET-1",
  header: "HDR-SECRET-2",
  apiKeyHeader: "HDR-SECRET-3",
  arg: "ARG-SECRET-4",
  env: "ENV-SECRET-5",
  userinfo: "PW-SECRET-6",
  access: "AT-SECRET-7",
  refresh: "RT-SECRET-8",
  clientSecret: "CS-SECRET-9",
  rawProvider: "RAWPROVIDER-SECRET-10",
};
const DOCS = { type: "http" as const, url: `https://docs.example.com/mcp?token=${S.query}`, headers: { Authorization: `Bearer ${S.header}`, "x-api-key": S.apiKeyHeader } };
const MCP = {
  mcpServers: {
    docs: DOCS,
    tracker: { type: "http", url: "https://tracker.example.com/mcp" },
    local: { type: "stdio", command: "/opt/tools/bin/run", args: ["--key", S.arg], env: { API_TOKEN: S.env } },
    legacy: { type: "sse", url: `https://user:${S.userinfo}@legacy.example.com/sse` },
  },
  privateServices: ["docs"],
};

const row = (name: string, over: Partial<DesiredPersona> = {}): DesiredPersona => ({
  name, slackUserId: `U${name.toUpperCase()}`, userToken: null, model: null,
  soulMd: `${name} soul`, soulJson: { approvers: [] }, mcp: null, origin: "git", tombstonedAt: null, ...over,
});
const sync = (rows: DesiredPersona[]) =>
  P.applySync("default", rows, { revision: "r1", committedAt: Date.parse("2026-10-01T10:00:00Z"), by: "ci" });

const nodeLabels: Record<string, string[]> = {
  "node-b": ["engineering", "finance"],
  "node-a": ["engineering"],
  "node-d": ["default"],
};
const registry = {
  async liveNodesHolding(label: string) {
    return Object.keys(nodeLabels).filter((n) => nodeLabels[n]!.includes(label)).sort().map((node) => ({ node, labels: [...nodeLabels[node]!].sort() }));
  },
} as any;

const DOCS_EXPIRY = Date.parse("2100-01-01T00:00:00Z");
const mk = (o: { registry?: any; installed?: string[]; role?: "gateway" | "mono" } = {}) =>
  createPanelApi({
    registry: o.registry === undefined ? registry : o.registry,
    role: o.role ?? "gateway",
    pubsub: null, panelLock: null, chat: async () => {},
    installedKbSources: () => o.installed ?? ["kb-handbook", "kb-runbooks"],
  });
const get = (p: string, who?: string) =>
  new Request(`https://panel.example.com${p}`, { method: "GET", headers: who ? { cookie: who } : {} });
const read = async (path: string, who = operator, panel = mk()) => {
  const res = (await panel.fetch(get(path, who)))!;
  return { status: res.status, text: await res.text() };
};

const skillDir = (root: string, slug: string, name: string) => {
  mkdirSync(join(root, slug), { recursive: true });
  writeFileSync(join(root, slug, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
};

const saved: Record<string, string | undefined> = {};
const ENV = ["SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_SUPERADMIN", "SLAUDE_PANEL_OPERATORS", "SLAUDE_MASTER_KEY"];
beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  __resetRoleCache();
  if (process.env.SLAUDE_DB !== "pg") return;
  for (const t of ["mcp_credentials", "persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
});
afterEach(async () => {
  await whenPersonaRegistrySettled();
  __resetPersonaRegistry();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetMasterKeyCache();
  __resetRoleCache();
  rmSync(join(paths.skills, "u14-shared"), { recursive: true, force: true });
  rmSync(join(paths.skills, "u14-shadowed"), { recursive: true, force: true });
  rmSync(join(paths.personas, "ana", "skills"), { recursive: true, force: true });
});
afterAll(async () => {
  if (process.env.SLAUDE_DB !== "pg") return;
  for (const t of ["mcp_credentials", "persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
});

describe.skipIf(process.env.SLAUDE_DB !== "pg")("GET /panel/api/personas/:name", () => {
  const seedAna = async (over: Partial<DesiredPersona> = {}) => {
    await sync([
      row("default"),
      row("ana", {
        userToken: S.userToken,
        model: "m-git",
        soulMd: "A".repeat(150) + "B".repeat(227),
        mcp: MCP,
        runsOn: "engineering",
        provider: { apiKey: "vault://kv/agents/ana#api_key", baseUrl: "https://llm.example.com/v1" },
        kbSources: ["kb-runbooks", "kb-missing"],
        ...over,
      }),
    ]);
    // The agent holds an OAuth credential for `docs` (keyed on its exact config).
    await putCredential({ kind: "agent", tenant: "default", persona: "ana" }, oauthKey("docs", DOCS), {
      serverName: "docs", serverUrl: DOCS.url, clientId: "cid", clientSecret: S.clientSecret,
      accessToken: S.access, refreshToken: S.refresh, expiresAt: DOCS_EXPIRY,
    });
  };

  test("returns the exact §4.4.1 shape", async () => {
    await seedAna();
    await P.setOverride("default", "ana", "model", "m-live", "ops");
    const r = await read("/panel/api/personas/ana");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({
      name: "ana",
      origin: "git",
      tombstoned: false,
      slackUserId: "UANA",
      soul: { length: 377, overridden: false, preview: "A".repeat(150) + "B".repeat(50) },
      model: { git: "m-git", live: "m-live", overridden: true },
      runsOn: "engineering",
      provider: { apiKey: "vault://kv/agents/ana#api_key", authToken: "none", oauthToken: "none", baseUrl: "https://llm.example.com/v1" },
      mcp: [
        { name: "docs", via: "bridge", type: "http", host: "docs.example.com", oauth: true, expiresAt: DOCS_EXPIRY },
        { name: "legacy", via: "none", type: "sse", host: "legacy.example.com", oauth: false, expiresAt: null },
        { name: "local", via: "none", type: "stdio", host: null, oauth: false, expiresAt: null },
        { name: "tracker", via: "bridge", type: "http", host: "tracker.example.com", oauth: false, expiresAt: null },
      ],
      kb: { mode: "list", sources: [{ id: "kb-runbooks", installed: true }, { id: "kb-missing", installed: false }] },
      skills: [],
      nodes: [
        { id: "node-a", alive: true, labels: ["engineering"] },
        { id: "node-b", alive: true, labels: ["engineering", "finance"] },
      ],
    });
  });

  test("no secret appears in the body or in anything logged, for either role", async () => {
    await seedAna();
    // A provider value that is not a reference (only possible by writing the
    // row directly) is reported as 'stored', never echoed.
    await sync([row("default"), row("ana", { userToken: S.userToken, mcp: MCP, provider: { apiKey: "vault://kv/agents/ana#api_key", authToken: S.rawProvider } })]);
    const sinks = (["log", "error", "warn", "info", "debug"] as const).map((m) => spyOn(console, m).mockImplementation(() => {}));
    let bodies = "";
    let logged = "";
    try {
      console.log("capture-canary");
      for (const who of [operator, superadmin]) {
        const r = await read("/panel/api/personas/ana", who);
        expect(r.status).toBe(200);
        bodies += r.text;
        const list = await read("/panel/api/personas", who);
        expect(list.status).toBe(200);
        bodies += list.text;
      }
    } finally {
      // Copy the calls BEFORE restoring: mockRestore() clears them.
      for (const s of sinks) {
        logged += s.mock.calls.map((c) => c.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")).join("\n");
        s.mockRestore();
      }
    }
    // The capture itself must work, or "nothing logged" proves nothing.
    expect(logged).toContain("capture-canary");
    for (const v of Object.values(S)) {
      expect(bodies).not.toContain(v);
      expect(logged).not.toContain(v);
    }
    expect(bodies).not.toContain("/opt/tools");
    expect(bodies).not.toContain("https://docs.example.com/mcp");
    expect(JSON.parse((await read("/panel/api/personas/ana")).text).provider.authToken).toBe("stored");
  });

  test("in mono a persona's stdio server runs in the gateway process; in the gateway role it is not served", async () => {
    await seedAna();
    const via = async (role: "gateway" | "mono") =>
      JSON.parse((await read("/panel/api/personas/ana", operator, mk({ role }))).text).mcp.find((s: any) => s.name === "local").via;
    expect(await via("gateway")).toBe("none");
    expect(await via("mono")).toBe("stdio");
  });

  test("auth: no session is 401, an unlisted identity 403, any operator role 200", async () => {
    await seedAna();
    expect((await read("/panel/api/personas/ana", "")).status).toBe(401);
    expect((await read("/panel/api/personas/ana", unlisted)).status).toBe(403);
    expect((await read("/panel/api/personas/ana", operator)).status).toBe(200);
    expect((await read("/panel/api/personas/ana", superadmin)).status).toBe(200);
  });

  test("an unknown persona is 404; a malformed name 422; a non-GET 405", async () => {
    await seedAna();
    expect((await read("/panel/api/personas/nobody")).status).toBe(404);
    expect((await read("/panel/api/personas/Not%20Valid")).status).toBe(422);
    const res = (await mk().fetch(new Request("https://panel.example.com/panel/api/personas/ana", {
      method: "DELETE", headers: { cookie: superadmin, "x-panel-csrf": "1" },
    })))!;
    expect(res.status).toBe(405);
  });

  test("a tombstoned persona is still readable and says so", async () => {
    await seedAna();
    await sync([row("default")]);
    const body = JSON.parse((await read("/panel/api/personas/ana")).text);
    expect(body.tombstoned).toBe(true);
  });

  test("kb modes: absent is every installed KB, [] none", async () => {
    await sync([row("default"), row("all"), row("nokb", { kbSources: [] })]);
    expect(JSON.parse((await read("/panel/api/personas/all")).text).kb).toEqual({
      mode: "all", sources: [{ id: "kb-handbook", installed: true }, { id: "kb-runbooks", installed: true }],
    });
    expect(JSON.parse((await read("/panel/api/personas/nokb")).text).kb).toEqual({ mode: "none", sources: [] });
  });

  test("skills carry their provenance; the persona's overlay shadows a global skill", async () => {
    await seedAna();
    skillDir(paths.skills, "u14-shared", "Shared skill");
    skillDir(paths.skills, "u14-shadowed", "Global version");
    skillDir(join(paths.personas, "ana", "skills"), "u14-shadowed", "Ana's version");
    skillDir(join(paths.personas, "ana", "skills"), "u14-own", "Ana only");
    const ana = JSON.parse((await read("/panel/api/personas/ana")).text).skills.filter((s: any) => s.slug.startsWith("u14-"));
    expect(ana).toEqual([
      { slug: "u14-own", name: "Ana only", source: "persona" },
      { slug: "u14-shadowed", name: "Ana's version", source: "persona" },
      { slug: "u14-shared", name: "Shared skill", source: "global" },
    ]);
    // The default persona sees the global root only.
    const def = JSON.parse((await read("/panel/api/personas/default")).text).skills.filter((s: any) => s.slug.startsWith("u14-"));
    expect(def).toEqual([
      { slug: "u14-shadowed", name: "Global version", source: "global" },
      { slug: "u14-shared", name: "Shared skill", source: "global" },
    ]);
  });

  test("nodes: a persona with no runsOn is on `default`; no registry is null", async () => {
    await seedAna({ runsOn: null });
    expect(JSON.parse((await read("/panel/api/personas/ana")).text).nodes).toEqual([{ id: "node-d", alive: true, labels: ["default"] }]);
    expect(JSON.parse((await read("/panel/api/personas/ana", operator, mk({ registry: null }))).text).nodes).toBeNull();
  });

  test("a registry failure leaves the rest of the view intact (nodes null)", async () => {
    await seedAna();
    const broken = { liveNodesHolding: async () => { throw new Error("redis down"); } };
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await read("/panel/api/personas/ana", operator, mk({ registry: broken }));
      expect(r.status).toBe(200);
      expect(JSON.parse(r.text).nodes).toBeNull();
    } finally { err.mockRestore(); }
  });

  test("the list route keeps its shape and adds a kb.mode summary", async () => {
    await sync([row("default"), row("ana", { kbSources: ["kb-runbooks"], runsOn: "engineering" }), row("nokb", { kbSources: [] })]);
    const body = JSON.parse((await read("/panel/api/personas")).text);
    const by = (n: string) => body.personas.find((p: any) => p.name === n);
    expect(by("default").kb).toEqual({ mode: "all" });
    expect(by("ana").kb).toEqual({ mode: "list" });
    expect(by("nokb").kb).toEqual({ mode: "none" });
    expect(Object.keys(by("ana")).sort()).toEqual(["fields", "kb", "name", "origin", "runsOn", "slackUserId", "tombstoned", "userToken"]);
  });
});

describe.skipIf(process.env.SLAUDE_DB === "pg")("GET /panel/api/personas/:name on sqlite", () => {
  test("is 409 'persona sync requires Postgres'", async () => {
    const r = await read("/panel/api/personas/ana");
    expect(r.status).toBe(409);
    expect(JSON.parse(r.text).error).toMatch(/persona sync requires Postgres/);
  });
});
