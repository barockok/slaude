import { beforeEach, describe, it, expect } from "bun:test";
import { db } from "../../src/db/schema";
import * as Sessions from "../../src/db/sessions";
import { enumerateSessions } from "../../src/gateway/panel/enumerator";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function seed(persona: string, ch: string, ts: string, status?: string) {
  const row = await Sessions.createForThread({
    thread: { team_id: "T1", channel_id: ch, thread_ts: ts, persona_id: persona },
    model: "test-model",
    working_dir: `/tmp/${ch}-${ts}`,
  });
  if (status) await Sessions.setStatus(row.id, status);
  return row;
}

beforeEach(async () => {
  await db.run("DELETE FROM sessions");
});

describe("listSessions", () => {
  it("orders newest-first by updated_at", async () => {
    const a = await seed("default", "C1", "1.0");
    await sleep(3);
    const b = await seed("default", "C2", "2.0");
    await sleep(3);
    const c = await seed("default", "C3", "3.0");
    const ids = (await Sessions.listSessions()).map((r) => r.id);
    expect(ids).toEqual([c.id, b.id, a.id]);
  });

  it("applies limit and offset", async () => {
    await seed("default", "C1", "1.0");
    await sleep(3);
    await seed("default", "C2", "2.0");
    await sleep(3);
    await seed("default", "C3", "3.0");
    const page1 = await Sessions.listSessions({ limit: 2, offset: 0 });
    const page2 = await Sessions.listSessions({ limit: 2, offset: 2 });
    expect(page1.length).toBe(2);
    expect(page2.length).toBe(1);
  });

  it("filters by persona", async () => {
    await seed("default", "C1", "1.0");
    await seed("noah", "C2", "2.0");
    const noah = await Sessions.listSessions({ persona: "noah" });
    expect(noah.length).toBe(1);
    expect(noah[0]!.persona_id).toBe("noah");
  });

  it("filters by status", async () => {
    await seed("default", "C1", "1.0", "running");
    await seed("default", "C2", "2.0", "idle");
    const running = await Sessions.listSessions({ status: "running" });
    expect(running.length).toBe(1);
    expect(running[0]!.status).toBe("running");
  });

  it("filters by tenant on Postgres; drops the filter on sqlite (no tenant_id column)", async () => {
    await seed("default", "C1", "1.0"); // tenant_id defaults to "default"
    if (db.dialect === "pg") {
      // pg carries a tenant_id column: a non-matching tenant filters the row
      // out; the matching (default) tenant returns it.
      expect((await Sessions.listSessions({ tenant: "whatever" })).length).toBe(0);
      expect((await Sessions.listSessions({ tenant: "default" })).length).toBe(1);
    } else {
      // sqlite has no tenant_id column: the filter is silently dropped, not errored.
      expect((await Sessions.listSessions({ tenant: "whatever" })).length).toBe(1);
    }
  });
});

describe("enumerateSessions (registry join)", () => {
  it("marks warm/cold + owning node from the registry", async () => {
    const warm = await seed("default", "C1", "1.0");
    const cold = await seed("default", "C2", "2.0");
    const registry = {
      lookup: async (id: string) =>
        id === warm.id ? { node: "node-A", since: 1, lastBeat: 2, fresh: true } : null,
    } as any;
    const rows = await enumerateSessions({}, { registry });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[warm.id]!.warm).toBe(true);
    expect(byId[warm.id]!.node).toBe("node-A");
    expect(byId[cold.id]!.warm).toBe(false);
    expect(byId[cold.id]!.node).toBeUndefined();
  });

  it("treats a stale registry entry (fresh:false) as cold", async () => {
    const s = await seed("default", "C1", "1.0");
    const registry = {
      lookup: async () => ({ node: "node-A", since: 1, lastBeat: 2, fresh: false }),
    } as any;
    const rows = await enumerateSessions({}, { registry });
    expect(rows[0]!.warm).toBe(false);
  });

  it("degrades to cold when there is no registry (mono/no-redis)", async () => {
    await seed("default", "C1", "1.0");
    const rows = await enumerateSessions({}, { registry: null });
    expect(rows[0]!.warm).toBe(false);
  });

  it("swallows a registry lookup failure per row", async () => {
    await seed("default", "C1", "1.0");
    const registry = {
      lookup: async () => {
        throw new Error("redis down");
      },
    } as any;
    const rows = await enumerateSessions({}, { registry });
    expect(rows[0]!.warm).toBe(false);
  });

  it("enriches with the panel lock owner when provided", async () => {
    const s = await seed("default", "C1", "1.0");
    const rows = await enumerateSessions(
      {},
      { registry: null, panelOwner: async (id) => (id === s.id ? "op@example.com" : null) },
    );
    expect(rows[0]!.panel_locked_by).toBe("op@example.com");
  });
});
