/**
 * Console API: Resources > Guardrails (the owner's guardrails, phase A1).
 * List, detail, the agent's Guardrails tab, and the superadmin enable switch
 * (audited, announced); operators read everything and cannot switch.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { db } from "../../src/db/schema";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import { __clearGuardrailsForTests, __setOverrideForTests, applyGuardrailChange, sha256 } from "../../src/db/guardrails";
import { __resetGuardrailSnapshotsForTests } from "../../src/guardrails/snapshot";
import { flushAudits } from "../../src/audit/emit";
import type { AgentGuardrailsResponse, OwnerGuardrailDetail, OwnerGuardrailsResponse } from "../../src/gateway/panel/api-types";

const SECRET = "t".repeat(32);
const operator = `${AT_COOKIE}=${mintSession({ sub: "s", email: "alice@example.com" }, "at", { secret: SECRET })}`;
const superadmin = `${AT_COOKIE}=${mintSession({ sub: "s", email: "lead@example.com" }, "at", { secret: SECRET })}`;

const MAIL = [
  "---",
  "name: no-outbound-email",
  "description: The agent drafts email but never sends it.",
  "---",
  "Draft email, never send it.",
  "",
  "```rules",
  "- id: no-send",
  "  on: tool",
  "  match: { tool: 'mcp__*__*send*' }",
  "  action: deny",
  "  message: Save a draft instead.",
  "- id: no-prices",
  "  on: reply",
  "  match: { text: '(?i)price' }",
  "  action: approve",
  "- id: bad",
  "  on: inbound",
  "  match: { text: '(' }",
  "  action: deny",
  "```",
].join("\n");
const SCOUT = "---\nname: scout-only\ndescription: Research rules\nscope: agents\nagents: [scout, ghost]\nchannels: [COPS]\n---\nCite sources.";
const LONELY = "---\nname: lonely\nscope: agents\nagents: [ghost]\n---\nNobody reads this.";
const CARE = "---\nname: mail-care\ndescription: How to send\nload: on-match\ntriggers: { tool: ['mcp__*__send*'], inbound: '(?i)invoice' }\n---\nCheck twice.";

function registry(): PersonaRegistry {
  const scout = { name: "scout", slackUserId: "UPSCOUT", soulMd: "# Scout", config: { slackUserId: "UX", name: "scout" }, outClient: null } as unknown as Persona;
  return {
    lookupByUserId: () => null,
    lookupByName: (n) => (n === "scout" ? scout : null),
    list: () => [scout],
    isMultiPersonaMode: () => true,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => ({ model: null, mcp: null, runsOn: null }),
  };
}

const call = async (path: string, who = operator, init: RequestInit = {}) => {
  const api = createPanelApi({ registry: null, role: "mono", pubsub: null, panelLock: null, chat: async () => {} });
  const headers: Record<string, string> = { cookie: who, ...(init.method && init.method !== "GET" ? { "content-type": "application/json", "x-panel-csrf": "1" } : {}) };
  const res = (await api.fetch(new Request(`https://panel.example.com${path}`, { ...init, headers })))!;
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
};

const ENV = ["SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_OPERATORS", "SLAUDE_PANEL_SUPERADMIN"];
const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  __resetRoleCache();
  setPersonaRegistry(registry());
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
  await db.run("DELETE FROM audit_events WHERE action LIKE 'guardrail.%'");
  await applyGuardrailChange("default", {
    upsert: [
      { slug: "no-outbound-email", md: MAIL, source: "git" },
      { slug: "scout-only", md: SCOUT, source: "file" },
      { slug: "lonely", md: LONELY, source: "file" },
      { slug: "mail-care", md: CARE, source: "git" },
    ],
    by: "test",
  });
});
afterEach(() => {
  __resetPersonaRegistry();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetRoleCache();
});
afterAll(async () => {
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
});

describe("GET /panel/api/guardrails", () => {
  test("the list: scope, rule counts by kind, source, validation, flags; the threat model", async () => {
    const r = await call("/panel/api/guardrails");
    expect(r.status).toBe(200);
    const b = r.body as OwnerGuardrailsResponse;
    expect(b.version).toBe(1);
    expect(b.failure).toBeNull();
    expect(b.canToggle).toBe(false);
    expect(b.proseMax).toBe(4000);
    expect(b.threatModel).toMatchObject({ db: db.dialect, turnsRunOn: "this-process", strong: db.dialect === "pg" });
    const by = (s: string) => b.guardrails.find((g) => g.slug === s)!;
    expect(b.guardrails.map((g) => g.slug)).toEqual(["lonely", "mail-care", "no-outbound-email", "scout-only"]);
    expect(by("no-outbound-email")).toMatchObject({
      name: "no-outbound-email", scope: "shared", source: "git", ruleCounts: { tool: 1, reply: 1, inbound: 0 }, guidance: true, errorCount: 1,
      active: true, enabled: true, override: false, behindSource: false, appliesToNoAgent: false, lastFiredAt: null,
    });
    expect(by("scout-only")).toMatchObject({ scope: "agents", agents: ["scout", "ghost"], unknownAgents: ["ghost"], channels: [{ id: "COPS", label: null }] });
    expect(by("lonely")).toMatchObject({ appliesToNoAgent: true, unknownAgents: ["ghost"] });
    expect(by("mail-care")).toMatchObject({ load: "on-match" });
  });

  test("an override written against an older text is flagged behind source", async () => {
    await __setOverrideForTests("default", { slug: "mail-care", md: CARE.replace("Check twice.", "Mine."), baseSha: sha256("older"), author: "op" });
    const b = (await call("/panel/api/guardrails")).body as OwnerGuardrailsResponse;
    expect(b.guardrails.find((g) => g.slug === "mail-care")).toMatchObject({ override: true, behindSource: true });
  });

  test("a stored set that does not verify is named; the page still renders", async () => {
    await db.run("UPDATE guardrails SET md = 'tampered' WHERE slug = 'lonely'");
    const b = (await call("/panel/api/guardrails")).body as OwnerGuardrailsResponse;
    expect(b.failure).toMatch(/'lonely' signature does not verify/);
  });
});

describe("GET /panel/api/guardrails/:slug", () => {
  test("GUARDRAIL.md, parsed rules with their status, errors, applies-to resolved, recent firings", async () => {
    await db.run("DELETE FROM audit_events WHERE action LIKE 'guardrail.%'");
    const { auditFiring } = await import("../../src/guardrails/audit");
    auditFiring({ on: "tool", slug: "no-outbound-email", ruleId: "no-send", action: "deny", applied: "deny", deciding: true, toolName: "mcp__mail__send" }, { persona: "scout", channelId: "COPS", sessionId: "S1" });
    await flushAudits();
    const r = await call("/panel/api/guardrails/no-outbound-email");
    expect(r.status).toBe(200);
    const d = r.body as OwnerGuardrailDetail;
    expect(d.md).toBe(MAIL);
    expect(d.prose).toBe("Draft email, never send it.");
    expect(d.rules.map((x) => [x.id, x.on, x.action, x.status])).toEqual([["no-send", "tool", "deny", "enforced"], ["no-prices", "reply", "approve", "pending"]]);
    expect(d.errors[0]).toMatch(/rule bad match.text is not a valid pattern/);
    expect(d.appliesTo).toEqual({ agents: ["default", "scout"], channels: [], everyChannel: true });
    expect(d.triggers).toBeNull();
    expect(d.firings).toHaveLength(1);
    expect(d.firings[0]).toMatchObject({ action: "guardrail.tool.denied", ruleId: "no-send", agent: "scout", channel: { id: "COPS" }, decision: "deny" });
    expect(d.lastFiredAt).toBe(d.firings[0]!.at);
    const care = (await call("/panel/api/guardrails/mail-care")).body as OwnerGuardrailDetail;
    expect(care.triggers).toEqual({ tool: ["mcp__*__send*"], inbound: "(?i)invoice", channels: [] });
    expect(care.rules).toEqual([]);
  });

  test("unknown is a 404, a bad name a 422", async () => {
    expect((await call("/panel/api/guardrails/nope")).status).toBe(404);
    expect((await call("/panel/api/guardrails/Bad%20Name")).status).toBe(422);
    expect((await call("/panel/api/guardrails/x/y/z")).status).toBe(404);
    expect((await call("/panel/api/guardrails", operator, { method: "POST", body: "{}" })).status).toBe(405);
  });
});

describe("GET /panel/api/agents/:name/guardrails", () => {
  test("shared and specific guardrails of one agent, the prose budget", async () => {
    const scout = (await call("/panel/api/agents/scout/guardrails")).body as AgentGuardrailsResponse;
    expect(scout.guardrails.map((g) => [g.slug, g.via, g.channelLimited])).toEqual([
      ["mail-care", "shared", false],
      ["no-outbound-email", "shared", false],
      ["scout-only", "agent", true],
    ]);
    expect(scout.prose).toMatchObject({ max: 4000, skipped: [] });
    const def = (await call("/panel/api/agents/default/guardrails")).body as AgentGuardrailsResponse;
    expect(def.guardrails.map((g) => g.slug)).toEqual(["mail-care", "no-outbound-email"]);
    expect((await call("/panel/api/agents/nobody/guardrails")).status).toBe(404);
  });

  test("the always-loaded prose cap: the one that tips it over is named, with the total", async () => {
    process.env.SLAUDE_GUARDRAIL_PROSE_MAX = "30";
    try {
      const d = (await call("/panel/api/agents/default/guardrails")).body as AgentGuardrailsResponse;
      expect(d.prose).toMatchObject({ chars: 27, max: 30, skipped: [] });
      process.env.SLAUDE_GUARDRAIL_PROSE_MAX = "20";
      const tight = (await call("/panel/api/agents/default/guardrails")).body as AgentGuardrailsResponse;
      expect(tight.prose.skipped).toEqual([{ slug: "no-outbound-email", name: "no-outbound-email", chars: 27 }]);
      expect(tight.guardrails.find((g) => g.slug === "no-outbound-email")!.skipped).toBe(true);
      const list = (await call("/panel/api/guardrails")).body as OwnerGuardrailsResponse;
      expect(list.guardrails.find((g) => g.slug === "no-outbound-email")!.skippedFor).toEqual(["default", "scout"]);
    } finally {
      delete process.env.SLAUDE_GUARDRAIL_PROSE_MAX;
    }
  });
});

describe("PUT /panel/api/guardrails/:slug/enabled", () => {
  const put = (slug: string, body: unknown, who = superadmin) => call(`/panel/api/guardrails/${slug}/enabled`, who, { method: "PUT", body: JSON.stringify(body) });

  test("a superadmin switches one off and on: audited, the set re-signed, it stops applying", async () => {
    const off = await put("no-outbound-email", { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ ok: true, slug: "no-outbound-email", enabled: false, version: 2 });
    const def = (await call("/panel/api/agents/default/guardrails")).body as AgentGuardrailsResponse;
    expect(def.guardrails.map((g) => g.slug)).toEqual(["mail-care"]);
    const listed = (await call("/panel/api/guardrails", superadmin)).body as OwnerGuardrailsResponse;
    expect(listed.canToggle).toBe(true);
    expect(listed.guardrails.find((g) => g.slug === "no-outbound-email")).toMatchObject({ enabled: false, active: false });
    // Switching to the state it is in changes nothing.
    expect((await put("no-outbound-email", { enabled: false })).body.version).toBe(2);
    expect((await put("no-outbound-email", { enabled: true })).body.version).toBe(3);
    await flushAudits();
    const rows = await db.query<{ action: string; target_id: string; actor_id: string; details: string }>(`SELECT action, target_id, actor_id, details FROM audit_events WHERE action = 'guardrail.updated' ORDER BY id`);
    expect(rows.map((r) => [r.target_id, r.actor_id, (typeof r.details === "string" ? JSON.parse(r.details) : r.details).enabled]).sort()).toEqual([["no-outbound-email", "lead@example.com", false], ["no-outbound-email", "lead@example.com", true]]);
  });

  test("an operator cannot; a bad body or unknown guardrail is refused", async () => {
    expect((await put("no-outbound-email", { enabled: false }, operator)).status).toBe(403);
    expect((await put("no-outbound-email", { enabled: "no" })).status).toBe(400);
    expect((await put("nope", { enabled: false })).status).toBe(404);
    expect((await call("/panel/api/guardrails/no-outbound-email/enabled", superadmin, { method: "POST", body: "{}" })).status).toBe(405);
  });
});
