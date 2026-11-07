/**
 * Console API: the audit trail read API. Any operator reads; filters map onto
 * the repository's, and the cursor pages from newest to oldest.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { db } from "../../src/db/schema";
import * as AuditEvents from "../../src/db/audit-events";
import { flushAudits } from "../../src/audit/emit";
import type { AuditPageResponse } from "../../src/gateway/panel/api-types";

const SECRET = "t".repeat(32);
const cookie = (email: string) => `${AT_COOKIE}=${mintSession({ sub: "s", email }, "at", { secret: SECRET })}`;
const operator = cookie("alice@example.com");

const panel = () => createPanelApi({ registry: null, pubsub: null, panelLock: null, chat: async () => {} });
const get = async (path: string, who: string | null = operator) => {
  const res = (await panel().fetch(new Request(`https://panel.example.com${path}`, { headers: who ? { cookie: who } : {} })))!;
  return { status: res.status, body: (await res.json()) as AuditPageResponse & { error?: string } };
};

const T0 = Date.parse("2026-11-01T00:00:00Z");
const ev = (i: number, over: Partial<AuditEvents.AuditEvent> = {}): AuditEvents.AuditEvent => ({
  id: `${AuditEvents.timeKey(T0 + i * 60_000)}-${String(i).padStart(12, "0")}`,
  at: T0 + i * 60_000,
  persona: "scout",
  actorKind: "slack_user",
  actorId: "UALICE",
  action: "gate.permission.decided",
  sessionId: "S-1",
  summary: `event ${i}`,
  details: {},
  ...over,
});

const saved: Record<string, string | undefined> = {};
const ENV = ["SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_SUPERADMIN", "SLAUDE_PANEL_OPERATORS"];
beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
  __resetRoleCache();
  await flushAudits();
  await db.run("DELETE FROM audit_events");
  await AuditEvents.insert(ev(0));
  await AuditEvents.insert(ev(1, { action: "grant.created", actorKind: "operator", actorId: "lead@example.com", sessionId: null }));
  await AuditEvents.insert(ev(2, { persona: "default", sessionId: "S-2" }));
  await AuditEvents.insert(ev(3, { action: "gate.approval.decided" }));
  await AuditEvents.insert(ev(4));
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetRoleCache();
  await db.run("DELETE FROM audit_events");
});

const summaries = (b: AuditPageResponse) => b.items.map((i) => i.summary);

describe("GET /panel/api/audit", () => {
  test("refuses a request without a session", async () => {
    expect((await get("/panel/api/audit", null)).status).toBe(401);
    expect((await get("/panel/api/sessions/S-1/audit", null)).status).toBe(401);
  });

  test("newest first, every field of a row", async () => {
    const r = await get("/panel/api/audit");
    expect(r.status).toBe(200);
    expect(summaries(r.body)).toEqual(["event 4", "event 3", "event 2", "event 1", "event 0"]);
    expect(r.body.nextCursor).toBeNull();
    expect(r.body.items[3]).toMatchObject({ action: "grant.created", actorKind: "operator", actorId: "lead@example.com", persona: "scout", at: T0 + 60_000 });
  });

  test("filters: persona, exact action, action prefix, actor, session", async () => {
    expect(summaries((await get("/panel/api/audit?persona=default")).body)).toEqual(["event 2"]);
    expect(summaries((await get("/panel/api/audit?action=grant.created")).body)).toEqual(["event 1"]);
    expect(summaries((await get("/panel/api/audit?action=gate.")).body)).toEqual(["event 4", "event 3", "event 2", "event 0"]);
    expect(summaries((await get("/panel/api/audit?actor=lead%40example.com")).body)).toEqual(["event 1"]);
    expect(summaries((await get("/panel/api/audit?session=S-2")).body)).toEqual(["event 2"]);
  });

  test("time bounds take epoch ms or ISO, inclusive", async () => {
    expect(summaries((await get(`/panel/api/audit?since=${T0 + 60_000}&until=${T0 + 180_000}`)).body)).toEqual(["event 3", "event 2", "event 1"]);
    const iso = new Date(T0 + 180_000).toISOString();
    expect(summaries((await get(`/panel/api/audit?since=${encodeURIComponent(iso)}`)).body)).toEqual(["event 4", "event 3"]);
  });

  test("cursor pages to the end", async () => {
    const one = await get("/panel/api/audit?limit=2");
    expect(summaries(one.body)).toEqual(["event 4", "event 3"]);
    expect(one.body.nextCursor).toBe(one.body.items[1]!.id);
    const two = await get(`/panel/api/audit?limit=2&cursor=${encodeURIComponent(one.body.nextCursor!)}`);
    expect(summaries(two.body)).toEqual(["event 2", "event 1"]);
    const three = await get(`/panel/api/audit?limit=2&cursor=${encodeURIComponent(two.body.nextCursor!)}`);
    expect(summaries(three.body)).toEqual(["event 0"]);
    expect(three.body.nextCursor).toBeNull();
  });

  test("invalid parameters are a 400 naming the parameter", async () => {
    for (const [q, name] of [["since=yesterday-ish", "since"], ["limit=0", "limit"], ["limit=abc", "limit"], ["limit=501", "limit"], ["bogus=1", "bogus"]] as const) {
      const r = await get(`/panel/api/audit?${q}`);
      expect(r.status).toBe(400);
      expect(r.body.error).toContain(name);
    }
  });
});

describe("GET /panel/api/sessions/:id/audit", () => {
  test("one session's rows, paged, even with no session row", async () => {
    const r = await get("/panel/api/sessions/S-1/audit?limit=2");
    expect(r.status).toBe(200);
    expect(summaries(r.body)).toEqual(["event 4", "event 3"]);
    const next = await get(`/panel/api/sessions/S-1/audit?limit=2&cursor=${encodeURIComponent(r.body.nextCursor!)}`);
    expect(summaries(next.body)).toEqual(["event 0"]);
    expect((await get("/panel/api/sessions/S-1/audit?persona=x")).status).toBe(400);
  });
});
