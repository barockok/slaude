/**
 * Console API: environments (never a secret or an endpoint), the console role
 * allowlist, and the overview counts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as Envs from "../../src/db/environments";
import * as Sessions from "../../src/db/sessions";
import * as PendingGates from "../../src/db/pending-gates";
import * as AuditEvents from "../../src/db/audit-events";
import { flushAudits } from "../../src/audit/emit";
import { flushFirstSightWork } from "../../src/domain/first-sight-flush";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import type { ConsoleRolesResponse, EnvironmentsResponse, OverviewResponse } from "../../src/gateway/panel/api-types";

const SECRET = "t".repeat(32);
const cookie = (email: string) => `${AT_COOKIE}=${mintSession({ sub: "s", email }, "at", { secret: SECRET })}`;
const operator = cookie("alice@example.com");

const nodes = {
  /** Two sessions warm on nodes (the overview's active count). */
  async countWarm() {
    return 2;
  },
  async liveNodeDetails() {
    return [
      { node: "node-a", labels: ["default"], lastBeat: 1000 },
      { node: "node-b", labels: ["default", "finance"], lastBeat: 2000 },
    ];
  },
};
const panel = (o: { registry?: unknown; role?: "gateway" | "mono" } = {}) =>
  createPanelApi({
    registry: (o.registry === undefined ? nodes : o.registry) as any,
    role: o.role ?? "gateway",
    pubsub: null, panelLock: null, chat: async () => {},
  });
const get = async (path: string, who: string | null = operator, o: { registry?: unknown; role?: "gateway" | "mono" } = {}) => {
  const res = (await panel(o).fetch(new Request(`https://panel.example.com${path}`, { headers: who ? { cookie: who } : {} })))!;
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
};

function registryWith(personas: Array<{ name: string; runsOn?: string | null }>): PersonaRegistry {
  const full = personas.map((p) => ({ slackUserId: `UP${p.name.toUpperCase()}`, config: { slackUserId: "UX", name: p.name }, outClient: null, ...p }) as Persona);
  return {
    lookupByUserId: () => null,
    lookupByName: (n) => full.find((p) => p.name === n) ?? null,
    list: () => full,
    isMultiPersonaMode: () => full.length > 0,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => ({ model: null, mcp: null, runsOn: null }),
  };
}

const saved: Record<string, string | undefined> = {};
const ENV = ["SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_SUPERADMIN", "SLAUDE_PANEL_OPERATORS", "SLAUDE_MASTER_KEY"];
beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com,bob@example.com";
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  __resetRoleCache();
  setPersonaRegistry(registryWith([{ name: "scout", runsOn: "finance" }, { name: "ledger", runsOn: "gpu" }]));
  await Envs._wipeForTests();
});
afterEach(async () => {
  __resetPersonaRegistry();
  await Envs._wipeForTests();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetMasterKeyCache();
  __resetRoleCache();
});

describe("GET /panel/api/environments", () => {
  test("refuses a request without a session", async () => {
    expect((await get("/panel/api/environments", null)).status).toBe(401);
    expect((await get("/panel/api/console-roles", null)).status).toBe(401);
    expect((await get("/panel/api/overview", null)).status).toBe(401);
  });

  test("node pools, persona labels and personal environments, never a secret or an endpoint", async () => {
    const env = await Envs.createEnv({
      teamId: "TTEAM", userId: "UALICE", name: "laptop", kind: "tailcat",
      config: { addr: "ADDR-SECRET-100.64.0.9", user: "CFG-SECRET-alice" },
      secrets: { privateKey: "KEY-SECRET-1", password: "PW-SECRET-2" },
      defaultDir: "/home/alice/code",
    });
    await Envs.bind({ channelId: "CCHAN", threadTs: "1.0", envId: env.id, dir: "/home/alice/code", lockByEnv: false });
    const r = await get("/panel/api/environments");
    expect(r.status).toBe(200);
    const b = r.body as EnvironmentsResponse;
    expect(b.nodePools).toEqual([
      { label: "default", nodes: [{ id: "node-a", lastSeen: 1000 }, { id: "node-b", lastSeen: 2000 }] },
      { label: "finance", nodes: [{ id: "node-b", lastSeen: 2000 }] },
      { label: "gpu", nodes: [] },
    ]);
    expect(b.personas).toEqual([
      { name: "default", runsOn: "default" },
      { name: "ledger", runsOn: "gpu" },
      { name: "scout", runsOn: "finance" },
    ]);
    expect(b.personal).toEqual([{
      id: env.id, owner: { teamId: "TTEAM", userId: "UALICE" }, name: "laptop", kind: "tailcat",
      defaultDir: "/home/alice/code", createdAt: expect.any(Number),
    }]);
    // Nothing secret, at any depth, by key or by value.
    expect(r.text).not.toMatch(/SECRET/);
    expect(r.text).not.toMatch(/"(secrets?|config|endpoint|addr|password|privateKey|token)"\s*:/i);
  });

  test("no node pools in mono or without a registry", async () => {
    expect((await get("/panel/api/environments", operator, { role: "mono" })).body.nodePools).toEqual([]);
    expect((await get("/panel/api/environments", operator, { registry: null })).body.nodePools).toEqual([]);
  });
});

describe("GET /panel/api/console-roles", () => {
  test("the allowlist, read-only, for a superadmin", async () => {
    const r = await get("/panel/api/console-roles", cookie("lead@example.com"));
    expect(r.status).toBe(200);
    expect(r.body as ConsoleRolesResponse).toEqual({ superadmin: ["lead@example.com"], operator: ["alice@example.com", "bob@example.com"] });
    const put = await panel().fetch(new Request("https://panel.example.com/panel/api/console-roles", {
      method: "PUT", headers: { cookie: cookie("lead@example.com"), "x-panel-csrf": "1" }, body: "{}",
    }));
    expect(put!.status).toBe(405);
  });
  test("refused to an operator: it lists every console user's email", async () => {
    const r = await get("/panel/api/console-roles");
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ required: "superadmin" });
    expect(r.text).not.toContain("bob@example.com");
  });
});

describe("GET /panel/api/overview", () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const id of created) {
      await db.run("DELETE FROM pending_gates WHERE session_id = ?", [id]);
      await db.run("DELETE FROM sessions WHERE id = ?", [id]);
    }
    created.length = 0;
  });

  test("counts and the ten most recent audit events", async () => {
    await flushAudits();
    await db.run("DELETE FROM audit_events");
    const before = (await get("/panel/api/overview")).body as OverviewResponse;

    const s1 = await Sessions.createForThread({ thread: { team_id: "TTEAM", channel_id: "CCHAN", thread_ts: "100.1" }, model: "m", working_dir: "/tmp" });
    const s2 = await Sessions.createForThread({ thread: { team_id: "TTEAM", channel_id: "CCHAN", thread_ts: "100.2" }, model: "m", working_dir: "/tmp" });
    created.push(s1.id, s2.id);
    // Session creation records its channel fire-and-forget (first sight writes audit rows): settle and drop those, the test counts its own rows.
    await flushFirstSightWork();
    await flushAudits();
    await db.run("DELETE FROM audit_events WHERE actor_id = 'first-sight'");
    await Sessions.setStatus(s1.id, "running");
    await PendingGates.create({ kind: "approval", sessionId: s1.id, expiresAt: Date.now() + 60_000 });
    await PendingGates.create({ kind: "perm", sessionId: s1.id });
    await PendingGates.create({ kind: "perm", sessionId: s2.id, expiresAt: Date.now() - 1 }); // past its expiry
    const settled = await PendingGates.create({ kind: "perm", sessionId: s2.id });
    await PendingGates.resolve(settled.id, "approved", "UALICE");
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      await AuditEvents.insert({
        id: `${AuditEvents.timeKey(now - i * 1000)}-${String(i).padStart(12, "0")}`, at: now - i * 1000,
        actorKind: "system", actorId: "system", action: "persona.sync", summary: `e${i}`, details: {},
      });
    }
    await AuditEvents.insert({
      id: `${AuditEvents.timeKey(now - 2 * 86_400_000)}-old`, at: now - 2 * 86_400_000,
      actorKind: "system", actorId: "system", action: "persona.sync", summary: "old", details: {},
    });

    const r = await get("/panel/api/overview");
    expect(r.status).toBe(200);
    const o = r.body as OverviewResponse;
    expect(o.counts.agents).toBe(3);
    // Warm sessions from the registry, not stored `running` rows (s1 is one).
    expect(o.counts.liveSessions).toBe(2);
    expect(before.counts.liveSessions).toBe(2);
    expect(o.counts.pendingApprovals - before.counts.pendingApprovals).toBe(2);
    expect(o.counts.auditEvents24h).toBe(12);
    expect(o.recentAudit.map((e) => e.summary)).toEqual(["e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"]);
    await db.run("DELETE FROM audit_events");
  });
});

describe("GET /panel/api/overview active sessions", () => {
  test("mono counts the sessions live in this process; no registry and no local is zero", async () => {
    const mono = createPanelApi({
      registry: null, role: "mono", pubsub: null, panelLock: null, chat: async () => {},
      local: { isWarm: () => true, turnInFlight: () => false, count: () => 4 },
    });
    const res = (await mono.fetch(new Request("https://panel.example.com/panel/api/overview", { headers: { cookie: operator } })))!;
    expect(((await res.json()) as OverviewResponse).counts.liveSessions).toBe(4);
    const none = (await get("/panel/api/overview", operator, { registry: null })).body as OverviewResponse;
    expect(none.counts.liveSessions).toBe(0);
  });
});
