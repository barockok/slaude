import { beforeEach, describe, it, expect } from "bun:test";
import { db } from "../../src/db/schema";
import * as Sessions from "../../src/db/sessions";
import { enumerateSessions } from "../../src/gateway/panel/enumerator";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A registry fake from a per-session lookup (the enumerator reads it batched). */
const reg = (lookup: (id: string) => Promise<unknown>) =>
  ({ lookupMany: async (ids: string[]) => Promise.all(ids.map(lookup)) }) as any;

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
    const registry = reg(async (id: string) =>
        id === warm.id ? { node: "node-A", since: 1, lastBeat: 2, fresh: true } : null);
    const rows = await enumerateSessions({}, { registry });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[warm.id]!.warm).toBe(true);
    expect(byId[warm.id]!.node).toBe("node-A");
    expect(byId[cold.id]!.warm).toBe(false);
    expect(byId[cold.id]!.node).toBeUndefined();
  });

  it("treats a stale registry entry (fresh:false) as cold", async () => {
    const s = await seed("default", "C1", "1.0");
    const registry = reg(async () => ({ node: "node-A", since: 1, lastBeat: 2, fresh: false }));
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
    const registry = { lookupMany: async () => { throw new Error("redis down"); } } as any;
    const rows = await enumerateSessions({}, { registry });
    expect(rows[0]!.warm).toBe(false);
  });

  it("enriches with the panel lock owner when provided", async () => {
    const s = await seed("default", "C1", "1.0");
    const rows = await enumerateSessions(
      {},
      { registry: null, panelOwners: async (ids) => ids.map((id) => (id === s.id ? "op@example.com" : null)) },
    );
    expect(rows[0]!.panel_locked_by).toBe("op@example.com");
  });

  it("activity: a stored running row no node holds is idle; a warm one is warm or working", async () => {
    const stale = await seed("default", "C1", "1.0", "running"); // node restarted days ago
    const warm = await seed("default", "C2", "2.0", "running");
    const busy = await seed("default", "C3", "3.0", "running");
    const failed = await seed("default", "C4", "4.0", "error");
    const registry = reg(async (id: string) =>
        id === warm.id || id === busy.id ? { node: "node-A", since: 1, lastBeat: 2, fresh: true } : null);
    const rows = await enumerateSessions({}, { registry, turnsInFlight: async (ids) => new Map(ids.map((id) => [id, id === busy.id])) });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[stale.id]!.activity).toBe("idle");
    expect(byId[stale.id]!.status).toBe("running"); // the stored status is untouched
    expect(byId[warm.id]!.activity).toBe("warm");
    expect(byId[busy.id]!.activity).toBe("working");
    expect(byId[failed.id]!.activity).toBe("error");
  });

  it("mono: liveness comes from the in-process sessions, not the registry", async () => {
    const live = await seed("default", "C1", "1.0", "running");
    const cold = await seed("default", "C2", "2.0", "running");
    const registry = reg(async () => ({ node: "node-A", since: 1, lastBeat: 2, fresh: true }));
    const local = { isWarm: (id: string) => id === live.id, turnInFlight: () => true, count: () => 1 };
    const rows = await enumerateSessions({}, { registry, local });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[live.id]!.warm).toBe(true);
    expect(byId[live.id]!.activity).toBe("working");
    expect(byId[cold.id]!.warm).toBe(false);
    expect(byId[cold.id]!.activity).toBe("idle");
  });
});

describe("streamTurnInFlight", () => {
  const pubsub = (events: unknown[]) =>
    ({ recentEventsMany: async (ids: string[]) => ids.map(() => events.map((event, i) => ({ id: String(i), event }))) }) as any;
  it("reads the newest turn boundary", async () => {
    const { streamTurnInFlight } = await import("../../src/gateway/panel/activity");
    expect(await streamTurnInFlight(pubsub([{ type: "toolCall" }, { type: "turnStart" }, { type: "done" }]), "s")).toBe(true);
    expect(await streamTurnInFlight(pubsub([{ type: "done" }, { type: "turnStart" }]), "s")).toBe(false);
    // The skill check's done after a turn is not a boundary of its own.
    expect(await streamTurnInFlight(pubsub([{ type: "done", autoEvolve: true }, { type: "turnStart" }]), "s")).toBe(true);
    expect(await streamTurnInFlight(pubsub([{ type: "error" }, { type: "turnStart" }]), "s")).toBe(false);
    expect(await streamTurnInFlight(pubsub([{ type: "assistantText" }]), "s")).toBeUndefined();
    expect(await streamTurnInFlight(null, "s")).toBeUndefined();
    const broken = { recentEventsMany: async () => { throw new Error("redis down"); } } as any;
    expect(await streamTurnInFlight(broken, "s")).toBeUndefined();
  });
});

describe("enumerateSessions round trips", () => {
  it("reads the registry, the streams and the lock owners in a bounded number of batched calls", async () => {
    for (let i = 0; i < 12; i++) await seed("default", `CB${i}`, `${i}.0`, "running");
    const calls = { lookupMany: 0, lookup: 0, streams: 0, owners: 0 };
    const registry = {
      lookup: async () => { calls.lookup++; return null; },
      lookupMany: async (ids: string[]) => { calls.lookupMany++; return ids.map((_, i) => (i % 2 ? { node: "n", since: 1, lastBeat: 2, fresh: true } : null)); },
    } as any;
    // A long turn: 20 tool events since its turnStart, so the small window
    // has no boundary and one widened read follows.
    const busyStream = [...Array.from({ length: 20 }, () => ({ id: "x", event: { type: "toolCall" } })), { id: "s", event: { type: "turnStart" } }];
    const pubsub = {
      recentEventsMany: async (ids: string[], count: number) => { calls.streams++; return ids.map(() => busyStream.slice(0, count)); },
    } as any;
    const { streamTurnsInFlight } = await import("../../src/gateway/panel/activity");
    const rows = await enumerateSessions({}, {
      registry,
      turnsInFlight: (ids) => streamTurnsInFlight(pubsub, ids),
      panelOwners: async (ids) => { calls.owners++; return ids.map(() => null); },
    });
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => r.activity === "working")).toHaveLength(6);
    expect(calls).toEqual({ lookupMany: 1, lookup: 0, streams: 2, owners: 1 });
  });
});
