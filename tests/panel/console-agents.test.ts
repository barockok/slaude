/**
 * Console API: agents and grants. Reads for any operator, grant changes for a
 * superadmin only, each change audited and visible to roleOf at once.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { db } from "../../src/db/schema";
import * as AgentGrants from "../../src/db/agent-grants";
import * as AuditEvents from "../../src/db/audit-events";
import { flushAudits } from "../../src/audit/emit";
import { SoulDataSchema } from "../../src/soul/data";
import { __resetSoulDataMemo, setSoulData } from "../../src/soul/extract";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import { __setGrantsReader, roleOf } from "../../src/access/role";
import type { AgentDetailResponse, AgentsResponse, AllGrantsResponse, ConsoleGrantView, CreateGrantResponse } from "../../src/gateway/panel/api-types";

const SECRET = "t".repeat(32);
const cookie = (email: string) => `${AT_COOKIE}=${mintSession({ sub: "s", email }, "at", { secret: SECRET })}`;
const superadmin = cookie("lead@example.com");
const operator = cookie("alice@example.com");
const unlisted = cookie("eve@example.com");

function registryWith(personas: Array<{ name: string; soulJson?: unknown }>): PersonaRegistry {
  const full = personas.map((p) => ({ slackUserId: `UP${p.name.toUpperCase()}`, config: { slackUserId: "UX", name: p.name }, outClient: null, ...p }) as Persona);
  return {
    lookupByUserId: () => null,
    lookupByName: (n) => full.find((p) => p.name === n) ?? null,
    list: () => full,
    isMultiPersonaMode: () => full.length > 0,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => ({ model: "m-default", mcp: null, runsOn: null }),
  };
}

const mk = (o: { registry?: unknown; role?: "gateway" | "mono" } = {}) =>
  createPanelApi({
    registry: (o.registry === undefined ? { liveNodesPerLabel: async () => new Map([["default", 2]]) } : o.registry) as any,
    role: o.role ?? "gateway",
    pubsub: null, panelLock: null, chat: async () => {},
  });

const call = async (method: string, path: string, who?: string, body?: unknown, csrf = true) => {
  const res = (await mk().fetch(
    new Request(`https://panel.example.com${path}`, {
      method,
      headers: {
        ...(who ? { cookie: who } : {}),
        ...(csrf && method !== "GET" ? { "x-panel-csrf": "1" } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
  ))!;
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
};

const auditRows = async (action: string) => {
  await flushAudits();
  return (await AuditEvents.list({ action })).items;
};

const saved: Record<string, string | undefined> = {};
const ENV = ["SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_SUPERADMIN", "SLAUDE_PANEL_OPERATORS"];
beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
  __resetRoleCache();
  await flushAudits();
  await db.run("DELETE FROM agent_grants");
  await db.run("DELETE FROM audit_events");
  setSoulData(SoulDataSchema.parse({ manager: { userId: "UMGR" }, mandate: "Help the team." }));
  setPersonaRegistry(registryWith([
    { name: "scout", soulJson: { manager: { userId: "USCOUT" }, mandate: "Scout things.", trustedChannels: ["CSCOUT"] } },
  ]));
  __setGrantsReader(null);
});
afterEach(async () => {
  await flushAudits();
  __setGrantsReader(null);
  __resetPersonaRegistry();
  __resetSoulDataMemo();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetRoleCache();
  await db.run("DELETE FROM agent_grants");
});

describe("authentication", () => {
  test("every agents route refuses a request without a session", async () => {
    expect((await call("GET", "/panel/api/agents")).status).toBe(401);
    expect((await call("GET", "/panel/api/agents/scout")).status).toBe(401);
    expect((await call("POST", "/panel/api/agents/scout/grants", undefined, { subjectKind: "user", subjectId: "UNEW", role: "member" })).status).toBe(401);
    expect((await call("DELETE", "/panel/api/agents/scout/grants/x")).status).toBe(401);
    expect((await call("GET", "/panel/api/grants")).status).toBe(401);
  });

  test("a signed-in identity outside the allowlist is refused", async () => {
    expect((await call("GET", "/panel/api/agents", unlisted)).status).toBe(403);
  });
});

describe("GET /panel/api/agents", () => {
  test("lists the default persona first, then the registry's, with counts", async () => {
    await AgentGrants.create({ persona: "scout", subjectKind: "user", subjectId: "UONE", role: "member", createdBy: "lead@example.com" });
    await AgentGrants.create({ persona: "scout", subjectKind: "user", subjectId: "UOLD", role: "member", createdBy: "lead@example.com", expiresAt: 1 }, 0);
    const r = await call("GET", "/panel/api/agents", operator);
    expect(r.status).toBe(200);
    const { agents } = r.body as AgentsResponse;
    expect(agents.map((a) => a.name)).toEqual(["default", "scout"]);
    expect(agents[0]).toEqual({ name: "default", slackUserId: null, model: "m-default", runsOn: "default", live: true, mandateCount: 1, grantCount: 0 });
    expect(agents[1]).toMatchObject({ name: "scout", slackUserId: "UPSCOUT", runsOn: "default", live: true, mandateCount: 1, grantCount: 1 });
  });

  test("live is null without a node registry and true in mono", async () => {
    const none = await mk({ registry: null }).fetch(new Request("https://panel.example.com/panel/api/agents", { headers: { cookie: operator } }));
    expect(((await none!.json()) as AgentsResponse).agents[0]!.live).toBeNull();
    const mono = await mk({ registry: null, role: "mono" }).fetch(new Request("https://panel.example.com/panel/api/agents", { headers: { cookie: operator } }));
    expect(((await mono!.json()) as AgentsResponse).agents[0]!.live).toBe(true);
  });
});

describe("GET /panel/api/agents/:name", () => {
  test("mandates and effective grants, each with its source", async () => {
    const stored = await AgentGrants.create({ persona: "scout", subjectKind: "user", subjectId: "UONE", role: "approver", createdBy: "lead@example.com", note: "on call" });
    const r = await call("GET", "/panel/api/agents/scout", operator);
    expect(r.status).toBe(200);
    const d = r.body as AgentDetailResponse;
    expect(d.mandates.map((m) => m.id)).toEqual(["global"]);
    expect(d.grants).toContainEqual({ source: "soul", subjectKind: "user", subjectId: "USCOUT", role: "manager", deny: false, dmOnly: false, channelId: null });
    expect(d.grants).toContainEqual({ source: "soul", subjectKind: "channel", subjectId: "CSCOUT", role: "member", deny: false, dmOnly: false, channelId: null });
    expect(d.grants.at(-1)).toEqual({
      source: "console", id: stored.id, subjectKind: "user", subjectId: "UONE", role: "approver", deny: false, dmOnly: false,
      createdBy: "lead@example.com", createdAt: stored.createdAt, expiresAt: null, note: "on call",
    });
    expect(d.grantCount).toBe(1);
    const g = await call("GET", "/panel/api/agents/scout/grants", operator);
    expect(g.body.grants).toEqual(d.grants);
  });

  test("an unknown agent is a 404; a malformed name a 422", async () => {
    expect((await call("GET", "/panel/api/agents/ghost", operator)).status).toBe(404);
    expect((await call("GET", "/panel/api/agents/ghost/grants", operator)).status).toBe(404);
    expect((await call("GET", "/panel/api/agents/Bad_Name", operator)).status).toBe(422);
  });
});

describe("POST /panel/api/agents/:name/grants", () => {
  const body = { subjectKind: "user", subjectId: "UNEW", role: "member", note: "pilot" };

  test("an operator is refused and nothing is stored", async () => {
    const r = await call("POST", "/panel/api/agents/scout/grants", operator, body);
    expect(r.status).toBe(403);
    expect(r.body.required).toBe("superadmin");
    expect(await AgentGrants.listAll()).toEqual([]);
    expect(await auditRows("grant.created")).toEqual([]);
  });

  test("the anti-CSRF header is required", async () => {
    expect((await call("POST", "/panel/api/agents/scout/grants", superadmin, body, false)).status).toBe(403);
    expect(await AgentGrants.listAll()).toEqual([]);
  });

  test("a superadmin stores it, it is audited, and roleOf sees it at once", async () => {
    // Prime the in-process grant cache with the pre-grant answer.
    expect(await roleOf("scout", "UNEW")).toBeNull();
    const r = await call("POST", "/panel/api/agents/scout/grants", superadmin, body);
    expect(r.status).toBe(201);
    const grant = (r.body as CreateGrantResponse).grant;
    expect(grant).toMatchObject({ source: "console", subjectKind: "user", subjectId: "UNEW", role: "member", createdBy: "lead@example.com", note: "pilot", expiresAt: null });
    expect(await roleOf("scout", "UNEW")).toBe("member");
    const [row] = await auditRows("grant.created");
    expect(row).toMatchObject({
      actorKind: "operator", actorId: "lead@example.com", persona: "scout", targetKind: "grant", targetId: grant.id,
    });
    expect(row!.details).toMatchObject({ grantId: grant.id, subjectKind: "user", subjectId: "UNEW", role: "member", deny: false, note: "pilot" });
  });

  test("zod validation: missing and unknown fields, bad enums, bad types", async () => {
    const bad = async (b: unknown) => {
      const r = await call("POST", "/panel/api/agents/scout/grants", superadmin, b);
      expect(r.status).toBe(400);
      return r.body.error as string;
    };
    expect(await bad({ subjectKind: "user", subjectId: "UNEW" })).toContain("role");
    expect(await bad({ ...body, role: "owner" })).toContain("role");
    expect(await bad({ ...body, subjectKind: "group" })).toContain("subjectKind");
    expect(await bad({ ...body, subjectId: "" })).toContain("subjectId");
    expect(await bad({ ...body, deny: "yes" })).toContain("deny");
    expect(await bad({ ...body, extra: 1 })).toContain("extra");
    expect(await bad({ ...body, expiresAt: Date.now() - 1000 })).toContain("expiresAt");
    expect(await bad("{not json")).toContain("malformed");
    expect(await AgentGrants.listAll()).toEqual([]);
  });

  test("the repository's combination rules come back as a clear 400", async () => {
    const r = await call("POST", "/panel/api/agents/scout/grants", superadmin, { subjectKind: "channel", subjectId: "CNEW", role: "manager" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("a channel subject can only be granted member, not manager");
    const d = await call("POST", "/panel/api/agents/scout/grants", superadmin, { subjectKind: "workspace", subjectId: "TTEAM", role: "member", deny: true });
    expect(d.status).toBe(400);
    expect(d.body.error).toContain("deny applies to user subjects only");
  });

  test("a subject id of the wrong shape for its kind is a clear 400", async () => {
    const user = await call("POST", "/panel/api/agents/scout/grants", superadmin, { subjectKind: "user", subjectId: "alice", role: "member" });
    expect(user.status).toBe(400);
    expect(user.body.error).toContain("a user subject_id must be a Slack user id");
    const chan = await call("POST", "/panel/api/agents/scout/grants", superadmin, { subjectKind: "channel", subjectId: "UNEW", role: "member" });
    expect(chan.status).toBe(400);
    expect(chan.body.error).toContain("Slack channel id");
    expect(await AgentGrants.listAll()).toEqual([]);
  });

  test("an unknown persona is a 404", async () => {
    expect((await call("POST", "/panel/api/agents/ghost/grants", superadmin, body)).status).toBe(404);
  });
});

describe("DELETE /panel/api/agents/:name/grants/:id", () => {
  const seed = () => AgentGrants.create({ persona: "scout", subjectKind: "user", subjectId: "UNEW", role: "manager", createdBy: "lead@example.com" });

  test("an operator is refused and the grant stays", async () => {
    const g = await seed();
    expect((await call("DELETE", `/panel/api/agents/scout/grants/${g.id}`, operator)).status).toBe(403);
    expect((await AgentGrants.listAll()).map((x) => x.id)).toEqual([g.id]);
    expect(await auditRows("grant.revoked")).toEqual([]);
  });

  test("a superadmin revokes it, it is audited, and roleOf drops it at once", async () => {
    const g = await seed();
    expect(await roleOf("scout", "UNEW")).toBe("manager");
    const r = await call("DELETE", `/panel/api/agents/scout/grants/${g.id}`, superadmin);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(await roleOf("scout", "UNEW")).toBeNull();
    const [row] = await auditRows("grant.revoked");
    expect(row).toMatchObject({ actorKind: "operator", actorId: "lead@example.com", persona: "scout", targetKind: "grant", targetId: g.id });
    expect(row!.details).toMatchObject({ grantId: g.id, subjectId: "UNEW", role: "manager" });
  });

  test("an unknown id, or another agent's grant, is a 404 and changes nothing", async () => {
    const other = await AgentGrants.create({ persona: "default", subjectKind: "user", subjectId: "UNEW", role: "member", createdBy: "lead@example.com" });
    expect((await call("DELETE", "/panel/api/agents/scout/grants/nope", superadmin)).status).toBe(404);
    expect((await call("DELETE", `/panel/api/agents/scout/grants/${other.id}`, superadmin)).status).toBe(404);
    expect((await AgentGrants.listAll()).map((x: ConsoleGrantView | AgentGrants.AgentGrantRow) => x.id)).toEqual([other.id]);
  });
});

describe("GET /panel/api/grants", () => {
  test("an operator gets every unexpired console grant across agents, with its persona", async () => {
    const now = Date.now();
    const a = await AgentGrants.create({ persona: "scout", subjectKind: "user", subjectId: "UNEW", role: "approver", createdBy: "lead@example.com", note: "cover" });
    const b = await AgentGrants.create({ persona: "default", subjectKind: "channel", subjectId: "CTEAM", role: "member", createdBy: "lead@example.com", expiresAt: now + 60_000 });
    // Expired: stored, but not listed.
    await AgentGrants.create({ persona: "scout", subjectKind: "user", subjectId: "UOLD", role: "member", createdBy: "lead@example.com", expiresAt: now - 1_000 }, now - 60_000);
    const r = await call("GET", "/panel/api/grants", operator);
    expect(r.status).toBe(200);
    const grants = (r.body as AllGrantsResponse).grants;
    expect(grants.map((g) => g.id).sort()).toEqual([a.id, b.id].sort());
    expect(grants.find((g) => g.id === a.id)).toEqual({
      source: "console", id: a.id, persona: "scout", subjectKind: "user", subjectId: "UNEW", role: "approver",
      deny: false, dmOnly: false, createdBy: "lead@example.com", createdAt: a.createdAt, expiresAt: null, note: "cover",
    });
    expect(grants.find((g) => g.id === b.id)).toMatchObject({ persona: "default", subjectKind: "channel", expiresAt: now + 60_000 });
  });

  test("an empty store is an empty list; only GET is allowed", async () => {
    expect((await call("GET", "/panel/api/grants", operator)).body).toEqual({ grants: [] });
    expect((await call("POST", "/panel/api/grants", superadmin, {})).status).toBe(405);
  });
});
