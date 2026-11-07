/**
 * Console API: memory stores, read-only, against a stubbed brain listing. The
 * real engine side is tests/knowledge/memory-browse.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import type { MemoryBrowser, MemoryPage } from "../../src/knowledge/memory-browse";
import type { MemoryPagesResponse, MemoryStoresResponse } from "../../src/gateway/panel/api-types";
import { db } from "../../src/db/schema";
import * as AuditEvents from "../../src/db/audit-events";
import { flushAudits } from "../../src/audit/emit";

const SECRET = "t".repeat(32);
const cookie = (email: string) => `${AT_COOKIE}=${mintSession({ sub: "s", email }, "at", { secret: SECRET })}`;
const operator = cookie("alice@example.com");
const superadmin = cookie("lead@example.com");

const SLUGS = ["notes/a", "notes/b", "notes/c", "notes/d", "notes/e"];
const PAGE: MemoryPage = {
  store: "shared", slug: "notes/a", type: "note", title: "A", content: "First page.", timeline: "",
  frontmatter: { type: "note" }, tags: ["ops"], links: [{ to: "notes/b", type: "see_also", context: "" }],
  createdAt: 1, updatedAt: 2,
};
const calls: unknown[] = [];
const stub: MemoryBrowser = {
  async stores() {
    return [
      { id: "shared", kind: "shared", pageCount: 5 },
      { id: "agent-uscout", kind: "agent", pageCount: 2 },
      { id: "kb-handbook", kind: "library", pageCount: 9 },
      { id: "profile-tteam-ualice", kind: "profile", pageCount: 1 },
      { id: "user-ualice", kind: "personal", pageCount: 4 },
    ];
  },
  async pages(store, o) {
    calls.push({ store, ...o });
    return store === "shared" || store === "user-ualice"
      ? SLUGS.slice(o.offset, o.offset + o.limit).map((slug) => ({ slug, type: "note", title: slug, updatedAt: 2 }))
      : [];
  },
  async page(store, slug) {
    calls.push({ store, slug });
    if (slug !== "notes/a") return null;
    if (store === "shared") return PAGE;
    if (store === "user-ualice" || store === "profile-tteam-ualice") return { ...PAGE, store, content: "PRIVATE-CONTENT" };
    return null;
  },
};

const panel = (memory: MemoryBrowser | undefined = stub) =>
  createPanelApi({ registry: null, pubsub: null, panelLock: null, chat: async () => {}, memory });
const get = async (path: string, who: string | null = operator, memory?: MemoryBrowser) => {
  const res = (await panel(memory).fetch(new Request(`https://panel.example.com${path}`, { headers: who ? { cookie: who } : {} })))!;
  return { status: res.status, body: (await res.json()) as any };
};

function registryWith(personas: Array<{ name: string; slackUserId: string }>): PersonaRegistry {
  const full = personas.map((p) => ({ config: { slackUserId: p.slackUserId, name: p.name }, outClient: null, ...p }) as Persona);
  return {
    lookupByUserId: () => null,
    lookupByName: (n) => full.find((p) => p.name === n) ?? null,
    list: () => full,
    isMultiPersonaMode: () => full.length > 0,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
  };
}

const saved: Record<string, string | undefined> = {};
const ENV = ["SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_SUPERADMIN", "SLAUDE_PANEL_OPERATORS", "SLAUDE_BRAIN_DISABLED", "SLAUDE_BRAIN_MODE"];
beforeEach(async () => {
  await flushAudits();
  await db.run("DELETE FROM audit_events");
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
  delete process.env.SLAUDE_BRAIN_DISABLED;
  delete process.env.SLAUDE_BRAIN_MODE;
  __resetRoleCache();
  setPersonaRegistry(registryWith([{ name: "scout", slackUserId: "USCOUT" }]));
  calls.length = 0;
});
afterEach(() => {
  __resetPersonaRegistry();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetRoleCache();
});

describe("memory API", () => {
  test("refuses a request without a session", async () => {
    expect((await get("/panel/api/memory/stores", null)).status).toBe(401);
    expect((await get("/panel/api/memory/pages?store=shared&slug=notes/a", null)).status).toBe(401);
  });

  test("stores with kind, label and page count; agent minds named after their persona", async () => {
    const r = await get("/panel/api/memory/stores", superadmin);
    expect(r.status).toBe(200);
    expect((r.body as MemoryStoresResponse).stores).toEqual([
      { id: "shared", kind: "shared", label: "Shared", pageCount: 5 },
      { id: "agent-uscout", kind: "agent", label: "Agent mind: scout", pageCount: 2 },
      { id: "kb-handbook", kind: "library", label: "Library: handbook", pageCount: 9 },
      { id: "profile-tteam-ualice", kind: "profile", label: "Profile", pageCount: 1 },
      { id: "user-ualice", kind: "personal", label: "Personal: ualice", pageCount: 4 },
    ]);
  });

  test("a store's pages, cursor paged", async () => {
    const one = await get("/panel/api/memory/stores/shared/pages?limit=2");
    expect(one.status).toBe(200);
    expect((one.body as MemoryPagesResponse).items.map((p) => p.slug)).toEqual(["notes/a", "notes/b"]);
    expect(one.body.nextCursor).toBe("2");
    const last = await get("/panel/api/memory/stores/shared/pages?limit=2&cursor=4");
    expect(last.body.items.map((p: { slug: string }) => p.slug)).toEqual(["notes/e"]);
    expect(last.body.nextCursor).toBeNull();
    expect(calls[0]).toEqual({ store: "shared", offset: 0, limit: 3 });
  });

  test("one page with content, type, tags and links; a missing one is a 404", async () => {
    const r = await get("/panel/api/memory/pages?store=shared&slug=notes%2Fa");
    expect(r.status).toBe(200);
    expect(r.body).toEqual(PAGE);
    expect((await get("/panel/api/memory/pages?store=shared&slug=notes%2Fz")).status).toBe(404);
  });

  test("bad parameters are a 400", async () => {
    expect((await get("/panel/api/memory/pages?store=shared")).status).toBe(400);
    expect((await get("/panel/api/memory/pages?store=Bad%20Id&slug=x")).status).toBe(400);
    expect((await get("/panel/api/memory/stores/shared/pages?cursor=-1")).status).toBe(400);
    expect((await get("/panel/api/memory/stores/shared/pages?limit=101")).status).toBe(400);
    expect((await get("/panel/api/memory/stores/BAD/pages")).status).toBe(422);
    expect(calls).toEqual([]);
  });

  test("read-only: any other method is refused", async () => {
    const res = await panel().fetch(new Request("https://panel.example.com/panel/api/memory/stores", {
      method: "POST", headers: { cookie: operator, "x-panel-csrf": "1" },
    }));
    expect(res!.status).toBe(405);
  });

  test("a disabled or remote brain is a 503 with a clear message", async () => {
    process.env.SLAUDE_BRAIN_DISABLED = "1";
    const off = await get("/panel/api/memory/stores");
    expect(off.status).toBe(503);
    expect(off.body.error).toContain("disabled");
    delete process.env.SLAUDE_BRAIN_DISABLED;
    process.env.SLAUDE_BRAIN_MODE = "remote";
    const remote = await get("/panel/api/memory/pages?store=shared&slug=notes%2Fa");
    expect(remote.status).toBe(503);
    expect(remote.body.error).toContain("separate brain server");
  });

  test("an operator never sees personal or profile stores, their pages or a page in them", async () => {
    const list = await get("/panel/api/memory/stores");
    expect((list.body as MemoryStoresResponse).stores.map((s) => s.id)).toEqual(["shared", "agent-uscout", "kb-handbook"]);
    for (const path of [
      "/panel/api/memory/stores/user-ualice/pages",
      "/panel/api/memory/stores/profile-tteam-ualice/pages",
      "/panel/api/memory/pages?store=user-ualice&slug=notes%2Fa",
      "/panel/api/memory/pages?store=profile-tteam-ualice&slug=notes%2Fa",
    ]) {
      const r = await get(path);
      expect(r.status).toBe(403);
      expect(r.body.required).toBe("superadmin");
      expect(JSON.stringify(r.body)).not.toContain("PRIVATE-CONTENT");
    }
    expect(calls).toEqual([]);
    await flushAudits();
    expect((await AuditEvents.list({ action: "memory.page.viewed" })).items).toEqual([]);
  });

  test("a superadmin reads them, and each page read is audited without its content", async () => {
    expect((await get("/panel/api/memory/stores/user-ualice/pages?limit=2", superadmin)).status).toBe(200);
    const r = await get("/panel/api/memory/pages?store=user-ualice&slug=notes%2Fa", superadmin);
    expect(r.status).toBe(200);
    expect(r.body.content).toBe("PRIVATE-CONTENT");
    expect((await get("/panel/api/memory/pages?store=profile-tteam-ualice&slug=notes%2Fa", superadmin)).status).toBe(200);
    // A miss viewed nothing; a shared page is not audited.
    expect((await get("/panel/api/memory/pages?store=user-ualice&slug=notes%2Fz", superadmin)).status).toBe(404);
    expect((await get("/panel/api/memory/pages?store=shared&slug=notes%2Fa", superadmin)).status).toBe(200);
    await flushAudits();
    const rows = (await AuditEvents.list({ action: "memory.page.viewed" })).items;
    expect(rows.map((e) => e.targetId).sort()).toEqual(["profile-tteam-ualice/notes/a", "user-ualice/notes/a"]);
    const personal = rows.find((e) => e.targetId === "user-ualice/notes/a")!;
    expect(personal).toMatchObject({ actorKind: "operator", actorId: "lead@example.com", targetKind: "memory_page" });
    expect(personal.details).toMatchObject({ store: "user-ualice", slug: "notes/a", storeKind: "personal" });
    expect(JSON.stringify(rows)).not.toContain("PRIVATE-CONTENT");
  });

  test("titles: a conversation record reads as Conversation, date and short id; a frontmatter title wins", async () => {
    const id = "0842e8f7-b41a-44b6-9c3d-2f1e0a9b7c55";
    const at = Date.UTC(2026, 10, 7);
    const conv: MemoryBrowser = {
      ...stub,
      async pages() {
        return [
          { slug: `conversations/${id}`, type: "conversation", title: "0842e8f7 B41a 44b6 9c3d 2f1e0a9b7c55", updatedAt: at, createdAt: at },
          { slug: "notes/x", type: "note", title: "X", updatedAt: at, frontmatterTitle: "Named in frontmatter" },
        ];
      },
      async page() {
        return { ...PAGE, slug: `conversations/${id}`, title: "0842e8f7 B41a 44b6 9c3d 2f1e0a9b7c55", createdAt: at, frontmatter: {} };
      },
    };
    const list = await get("/panel/api/memory/stores/shared/pages", operator, conv);
    expect(list.body.items.map((p: { title: string }) => p.title)).toEqual(["Conversation 2026-11-07 (0842e8f7)", "Named in frontmatter"]);
    expect(list.body.items[0].slug).toBe(`conversations/${id}`);
    const one = await get(`/panel/api/memory/pages?store=shared&slug=${encodeURIComponent(`conversations/${id}`)}`, operator, conv);
    expect(one.body.title).toBe("Conversation 2026-11-07 (0842e8f7)");
  });
});
