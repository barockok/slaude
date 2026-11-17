/**
 * Console API: the domain records views (users, one user, boundaries). Read
 * only, superadmin only, and an email is never in an answer in full.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { db } from "../../src/db/schema";
import * as Domain from "../../src/db/domain";
import type { BoundaryPage, UserDetail, UserPage } from "../../src/gateway/panel/api-types";

const SECRET = "t".repeat(32);
const cookie = (email: string) => `${AT_COOKIE}=${mintSession({ sub: "s", email }, "at", { secret: SECRET })}`;
const superadmin = cookie("lead@example.com");
const operator = cookie("alice@example.com");

const panel = () => createPanelApi({ registry: null, pubsub: null, panelLock: null, chat: async () => {} });
const get = async (path: string, who: string | null = superadmin, method = "GET") => {
  const res = (await panel().fetch(new Request(`https://panel.example.com${path}`, { method, headers: who ? { cookie: who, "x-panel-csrf": "1" } : {} })))!;
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as any };
};

const WS = "T0EXAMPLE";
const DAY = 24 * 60 * 60 * 1000;
const slack = (value: string, state: Domain.State = "observed") =>
  ({ service: "slack", kind: "user", workspace: WS, value, state, source: "test" }) as const;
const mail = (value: string, state: Domain.State = "verified") =>
  ({ service: "email", kind: "address", workspace: "", value, state, source: "test" }) as const;
const age = (table: string, id: string, at: number) => db.run(`UPDATE ${table} SET created_at = ? WHERE id = ?`, [at, id]);

const saved: Record<string, string | undefined> = {};
const ENV = ["SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_SUPERADMIN", "SLAUDE_PANEL_OPERATORS"];
const wipe = async () => {
  for (const t of ["user_aliases", "bindings", "boundaries", "users"]) await db.run(`DELETE FROM ${t}`);
};
beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
  __resetRoleCache();
  await wipe();
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetRoleCache();
  await wipe();
});

describe("auth and roles", () => {
  test("a request without a session is refused", async () => {
    for (const p of ["/panel/api/users", "/panel/api/users/x", "/panel/api/boundaries"]) expect((await get(p, null)).status).toBe(401);
  });
  test("an operator is refused, a superadmin reads", async () => {
    for (const p of ["/panel/api/users", "/panel/api/users/x", "/panel/api/boundaries"]) {
      const r = await get(p, operator);
      expect(r.status).toBe(403);
      expect(r.body.required).toBe("superadmin");
    }
    expect((await get("/panel/api/users")).status).toBe(200);
    expect((await get("/panel/api/boundaries")).status).toBe(200);
  });
  test("read only: a write method is refused", async () => {
    for (const p of ["/panel/api/users", "/panel/api/boundaries"]) expect((await get(p, superadmin, "POST")).status).toBe(405);
    expect((await get("/panel/api/users/x", superadmin, "DELETE")).status).toBe(405);
  });
});

describe("GET /panel/api/users", () => {
  test("empty state", async () => {
    const r = await get("/panel/api/users");
    expect(r.body as UserPage).toEqual({ items: [], nextCursor: null });
    expect((await get("/panel/api/boundaries")).body as BoundaryPage).toEqual({ items: [], nextCursor: null });
  });

  test("preferred label, per-state counts and alias count", async () => {
    const a = await Domain.ensureBinding(slack("U0EXAMPLE", "verified"));
    await Domain.ensureBinding({ ...mail("alice.example@example.com"), userId: a.userId });
    await Domain.ensureBinding({ ...slack("U1EXAMPLE", "declared"), userId: a.userId });
    await db.run("INSERT INTO user_aliases (old_id, user_id, merged_at) VALUES (?, ?, ?)", ["old-user-1", a.userId, Date.now()]);
    const r = (await get("/panel/api/users")).body as UserPage;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      id: a.userId, kind: "person", preferred: "a***@example.com",
      bindings: { declared: 1, observed: 0, verified: 2 }, aliasCount: 1, unmatched: false,
    });
  });

  test("a Slack-only user shows its Slack binding", async () => {
    await Domain.ensureBinding(slack("U0EXAMPLE"));
    const r = (await get("/panel/api/users")).body as UserPage;
    expect(r.items[0]!.preferred).toBe("slack user U0EXAMPLE");
  });

  test("unmatched: all declared and older than seven days", async () => {
    const old = await Domain.ensureBinding(slack("U0OLD", "declared"));
    const fresh = await Domain.ensureBinding(slack("U0FRESH", "declared"));
    const seen = await Domain.ensureBinding(slack("U0SEEN", "observed"));
    const mixed = await Domain.ensureBinding(slack("U0MIXED", "declared"));
    await Domain.ensureBinding({ ...slack("U1MIXED", "observed"), userId: mixed.userId });
    await Domain.ensureUser({}); // no bindings: nothing to match, not flagged
    for (const u of [old, seen, mixed]) await age("users", u.userId, Date.now() - 8 * DAY);
    const items = ((await get("/panel/api/users?limit=100")).body as UserPage).items;
    const flag = (id: string) => items.find((i) => i.id === id)!.unmatched;
    expect(flag(old.userId)).toBe(true);
    expect(flag(fresh.userId)).toBe(false);
    expect(flag(seen.userId)).toBe(false);
    expect(flag(mixed.userId)).toBe(false);
    expect(items.filter((i) => i.unmatched)).toHaveLength(1);
    expect(items.find((i) => i.bindings.declared + i.bindings.observed + i.bindings.verified === 0)!.unmatched).toBe(false);
  });

  test("pages newest first with a cursor", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await Domain.ensureBinding(slack(`U${i}EXAMPLE`));
      await age("users", r.userId, 1_000_000 + i);
      ids.push(r.userId);
    }
    const p1 = (await get("/panel/api/users?limit=2")).body as UserPage;
    expect(p1.items.map((i) => i.id)).toEqual([ids[4]!, ids[3]!]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = (await get(`/panel/api/users?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`)).body as UserPage;
    expect(p2.items.map((i) => i.id)).toEqual([ids[2]!, ids[1]!]);
    const p3 = (await get(`/panel/api/users?limit=2&cursor=${encodeURIComponent(p2.nextCursor!)}`)).body as UserPage;
    expect(p3.items.map((i) => i.id)).toEqual([ids[0]!]);
    expect(p3.nextCursor).toBeNull();
  });

  test("filters: state, service, q prefix (wildcards are literal)", async () => {
    const a = await Domain.ensureBinding(slack("U0ALPHA", "verified"));
    await Domain.ensureBinding({ ...mail("zed@example.com"), userId: a.userId });
    const b = await Domain.ensureBinding(slack("U0BETA", "declared"));
    const c = await Domain.ensureBinding({ ...mail("carol@example.com", "declared") });
    const ids = async (qs: string) => ((await get(`/panel/api/users?${qs}`)).body as UserPage).items.map((i) => i.id).sort();
    expect(await ids("state=verified")).toEqual([a.userId].sort());
    expect(await ids("state=declared")).toEqual([b.userId, c.userId].sort());
    expect(await ids("service=email")).toEqual([a.userId, c.userId].sort());
    expect(await ids("service=slack&state=declared")).toEqual([b.userId]);
    expect(await ids("q=U0AL")).toEqual([a.userId]);
    expect(await ids("q=Car")).toEqual([]);
    expect(await ids("q=%25")).toEqual([]);
    expect(await ids("q=0ALPHA")).toEqual([]);
  });

  test("q never matches an email or phone binding, so a prefix cannot confirm an address", async () => {
    const a = await Domain.ensureBinding(slack("U0ALPHA", "verified"));
    await Domain.ensureBinding({ ...mail("alice@example.com"), userId: a.userId });
    const b = await Domain.ensureBinding(mail("alan@example.com", "declared"));
    const p = await Domain.ensureBinding({ service: "whatsapp", kind: "phone", workspace: "", value: "+15550001234", state: "declared", source: "test" });
    await Domain.ensureBinding({ service: "oidc", kind: "subject", workspace: "https://idp.example.com", value: "alina@example.com", state: "verified", source: "test", userId: a.userId });
    const ids = async (qs: string) => ((await get(`/panel/api/users?${qs}`)).body as UserPage).items.map((i) => i.id).sort();
    // The slack binding still answers q for its own user; the email ones answer nothing.
    expect(await ids("q=U0AL")).toEqual([a.userId]);
    expect(await ids("q=al")).toEqual([]);
    expect(await ids("q=ali")).toEqual([]);
    expect(await ids("q=alan")).toEqual([]);
    expect(await ids("q=alice@example.com")).toEqual([]);
    expect(await ids("service=email&q=al")).toEqual([]);
    expect(await ids("q=%2B1555")).toEqual([]);
    // Without q the email bindings still list and filter.
    expect(await ids("service=email")).toEqual([a.userId, b.userId].sort());
    expect(p.userId).toBeTruthy();
  });

  test("bad parameters are 400", async () => {
    expect((await get("/panel/api/users?state=bogus")).status).toBe(400);
    expect((await get("/panel/api/users?limit=0")).status).toBe(400);
    expect((await get("/panel/api/users?cursor=nope")).status).toBe(400);
    expect((await get("/panel/api/boundaries?x=1")).status).toBe(400);
  });
});

describe("GET /panel/api/users/:id", () => {
  test("bindings with masked email, source and aliases; an old id resolves", async () => {
    const a = await Domain.ensureBinding(slack("U0EXAMPLE", "verified"));
    await Domain.ensureBinding({ ...mail("jane.doe@example.com"), userId: a.userId });
    await db.run("INSERT INTO user_aliases (old_id, user_id, merged_at) VALUES (?, ?, ?)", ["old-user-1", a.userId, 5]);
    const r = await get(`/panel/api/users/${a.userId}`);
    expect(r.status).toBe(200);
    const d = r.body as UserDetail;
    expect(d.id).toBe(a.userId);
    expect(d.bindings.map((b) => [b.service, b.kind, b.workspace, b.value, b.state, b.source]).sort()).toEqual([
      ["email", "address", "", "j***@example.com", "verified", "test"],
      ["slack", "user", WS, "U0EXAMPLE", "verified", "test"],
    ]);
    expect(d.aliases).toEqual([{ oldId: "old-user-1", mergedAt: 5 }]);
    expect(((await get("/panel/api/users/old-user-1")).body as UserDetail).id).toBe(a.userId);
  });
  test("unknown id is 404", async () => {
    expect((await get("/panel/api/users/nope")).status).toBe(404);
  });
});

describe("GET /panel/api/boundaries", () => {
  test("columns, filters, paging and the unmatched flag", async () => {
    const mk = (value: string, state: Domain.State, displayName: string | null) =>
      Domain.ensureBoundary({ service: "slack", workspace: WS, value, kind: "channel", state, displayName });
    const a = await mk("C0EXAMPLE", "observed", "team-channel");
    const b = await mk("C1EXAMPLE", "declared", null);
    const c = await mk("C2EXAMPLE", "declared", null);
    await age("boundaries", a.boundary.id, 1_000_003);
    await age("boundaries", b.boundary.id, Date.now() - 8 * DAY);
    const all = (await get("/panel/api/boundaries")).body as BoundaryPage;
    expect(all.items).toHaveLength(3);
    expect(all.items[0]!.value).toBe("C2EXAMPLE");
    const by = (v: string) => all.items.find((i) => i.value === v)!;
    expect(by("C0EXAMPLE")).toMatchObject({ kind: "channel", service: "slack", workspace: WS, state: "observed", displayName: "team-channel", unmatched: false });
    expect(by("C1EXAMPLE").unmatched).toBe(true);
    expect(by("C2EXAMPLE").unmatched).toBe(false);
    expect(c.boundary.id).toBeTruthy();
    const f = async (qs: string) => ((await get(`/panel/api/boundaries?${qs}`)).body as BoundaryPage).items.map((i) => i.value).sort();
    expect(await f("state=declared")).toEqual(["C1EXAMPLE", "C2EXAMPLE"]);
    expect(await f("service=whatsapp")).toEqual([]);
    expect(await f("q=C1")).toEqual(["C1EXAMPLE"]);
    const p1 = (await get("/panel/api/boundaries?limit=2")).body as BoundaryPage;
    expect(p1.items).toHaveLength(2);
    const p2 = (await get(`/panel/api/boundaries?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`)).body as BoundaryPage;
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
  });
});

describe("masking", () => {
  test("no full email address, phone or local part appears in any response body", async () => {
    const a = await Domain.ensureBinding(slack("U0EXAMPLE", "verified"));
    await Domain.ensureBinding({ ...mail("jane.doe@example.com"), userId: a.userId });
    await Domain.ensureBinding({ ...mail("pending.person@example.com", "declared") });
    await Domain.ensureBinding({ service: "oidc", kind: "subject", workspace: "https://idp.example.com", value: "oidc.user@example.com", state: "verified", source: "test", userId: a.userId });
    await Domain.ensureBinding({ service: "whatsapp", kind: "phone", workspace: "", value: "+15550001234", state: "declared", source: "test" });
    await Domain.ensureBoundary({ service: "slack", workspace: WS, value: "C0EXAMPLE", kind: "channel", state: "observed", displayName: null });
    const users = await get("/panel/api/users?limit=100");
    const detail = await get(`/panel/api/users/${a.userId}`);
    const search = await get("/panel/api/users?q=jane");
    const bounds = await get("/panel/api/boundaries");
    expect(users.body.items).toHaveLength(3);
    expect(search.body.items).toHaveLength(0);
    for (const r of [users, detail, search, bounds]) {
      expect(r.status).toBe(200);
      expect(r.text).not.toMatch(/jane\.doe|pending\.person|oidc\.user|\+15550001234|5550001234/);
    }
    expect(detail.text).toContain("j***@example.com");
    expect(users.text).toContain("p***@example.com");
    expect(detail.text).toContain("o***@example.com");
    expect(users.text).toContain("***34");
  });
});
