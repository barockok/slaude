import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import * as Sessions from "../../src/db/sessions";
import { __setBoundaryResolver, createBoundaryResolver, primeBoundary, resetBoundaryResolver } from "../../src/domain/boundary-for";
import { resetBoundaryState } from "../helpers/boundary-state";
import { flushFirstSightWork } from "../../src/domain/first-sight-flush";
import { resetFirstSight } from "../../src/domain/first-sight";

const WS = "T0EXAMPLE";
const CH = "C0EXAMPLE";
const thread = (ts: string, persona?: string) => ({ team_id: WS, channel_id: CH, thread_ts: ts, ...(persona ? { persona_id: persona } : {}) });
/** Creates through the public API and adds the stored pair (read from the table: the public row never carries it). */
const mk = async (ts: string, persona?: string) => {
  const r = await Sessions.createForThread({ thread: thread(ts, persona), model: "m", working_dir: "/w" });
  const p = (await db.one<{ boundary_id: string | null; locator: string | null }>("SELECT boundary_id, locator FROM sessions WHERE id = ?", [r.id]))!;
  return { ...r, ...p };
};

type Row = { id: string; boundary_id: string | null; locator: string | null; slack_thread_ts: string | null };
const rows = (where = "1 = 1") => db.query<Row>(`SELECT id, boundary_id, locator, slack_thread_ts FROM sessions WHERE ${where} ORDER BY created_at, id`);

async function seedBoundary(channel = CH): Promise<string> {
  const id = (await Domain.ensureBoundary({ service: "slack", workspace: WS, value: channel, kind: "channel", state: "observed" })).boundary.id;
  primeBoundary(WS, channel, id);
  return id;
}

// The first statement opens the database and applies the migrations (seconds on a cold PGLite): do it once, with room.
beforeAll(async () => {
  await db.query("SELECT 1");
}, 60_000);

async function clean(): Promise<void> {
  await resetBoundaryState(); // settles background work first, then resets every piece of boundary state
  await db.run("DELETE FROM sessions");
  await Domain._wipeForTests();
}
beforeEach(clean);
afterEach(clean);

describe("the public row is the rc.21 shape", () => {
  test("no store method returns boundary_id or locator", async () => {
    await seedBoundary();
    const made = await Sessions.createForThread({ thread: thread("1.1"), model: "m", working_dir: "/w" });
    const k = { team_id: WS, channel_id: CH, thread_ts: "1.1" };
    const all = [made, await Sessions.findById(made.id), await Sessions.findByThread(k), await Sessions.findAnyByThread(k), ...(await Sessions.listSessions()), ...(await Sessions.updatedSince(["default"], 0))];
    expect(all.length).toBeGreaterThanOrEqual(6);
    for (const r of all) {
      expect(Object.keys(r!)).not.toContain("boundary_id");
      expect(Object.keys(r!)).not.toContain("locator");
    }
    // and the table does carry them
    expect((await db.one<{ boundary_id: string | null }>("SELECT boundary_id FROM sessions WHERE id = ?", [made.id]))!.boundary_id).not.toBeNull();
  });
});

describe("createForThread dual write", () => {
  test("cold cache: the pair is NULL and the legacy columns are what they always were", async () => {
    const r = await mk("1700000000.000100");
    expect(r).toMatchObject({ slack_team_id: WS, slack_channel_id: CH, slack_thread_ts: "1700000000.000100", persona_id: "default", status: "idle", claude_started: 0, permission_mode: "default", model: "m", working_dir: "/w", title: null });
    expect(r.boundary_id).toBeNull();
    expect(r.locator).toBeNull();
  });

  test("warm cache: boundary_id and the verbatim locator ride in the same insert", async () => {
    const b = await seedBoundary();
    const r = await mk("1700000000.000100");
    expect(r.boundary_id).toBe(b);
    expect(r.locator).toBe("1700000000.000100");
    // synthetic keys are stored verbatim
    expect((await mk("channel:C0EXAMPLE")).locator).toBe("channel:C0EXAMPLE");
    expect((await mk("cron:abc")).locator).toBe("cron:abc");
    expect((await mk("wake:C0EXAMPLE:1")).locator).toBe("wake:C0EXAMPLE:1");
  });

  test("a second persona on one thread gets its own row with the same pair", async () => {
    const b = await seedBoundary();
    const a = await mk("5.5");
    const c = await mk("5.5", "scout");
    expect(a.id).not.toBe(c.id);
    expect([a.boundary_id, c.boundary_id]).toEqual([b, b]);
    expect([a.locator, c.locator]).toEqual(["5.5", "5.5"]);
  });

  test("SLAUDE_BOUNDARY_WRITE=off stores NULL even when the boundary is cached", async () => {
    await seedBoundary();
    process.env.SLAUDE_BOUNDARY_WRITE = "off";
    const r = await mk("6.6");
    expect(r.boundary_id).toBeNull();
    expect(r.locator).toBeNull();
  });

  test("a missing team stores NULL and never fails", async () => {
    await seedBoundary();
    const r = await Sessions.createForThread({ thread: { team_id: "", channel_id: CH, thread_ts: "7.7" }, model: "m", working_dir: "/w" });
    expect((await db.one<{ boundary_id: string | null }>("SELECT boundary_id FROM sessions WHERE id = ?", [r.id]))!.boundary_id).toBeNull();
  });

  test("the resolver is never awaited before the insert: a hung boundaries read does not delay a create", async () => {
    let reads = 0;
    const hung = new Proxy(db, {
      get(t, k, r) {
        const v = Reflect.get(t, k, r);
        if (k === "one" || k === "query") return () => (reads++, new Promise(() => {}));
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    __setBoundaryResolver(createBoundaryResolver({ db: () => hung, role: () => "gateway", timeoutMs: () => 200 }));
    const winner = await Promise.race([mk("8.8").then(() => "created"), new Promise((res) => setTimeout(() => res("late"), 1500))]);
    expect(winner).toBe("created");
    expect(reads).toBeGreaterThanOrEqual(1); // the warm read was started, not awaited
    expect((await rows())[0]!.boundary_id).toBeNull();
  });

  test("the writer module only reads the cached resolver", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/db/sessions.ts"), "utf8");
    expect(src).toContain("boundaryForCached(");
    expect(src).not.toMatch(/\bboundaryFor\(/);
    expect(src).not.toMatch(/await\s+boundaryFor/);
  });
});

describe("late fill after first sight", () => {
  test("a row written before its boundary existed is completed, and a second message reuses it", async () => {
    const r = await mk("1700000000.000200");
    expect(r.boundary_id).toBeNull();
    await flushFirstSightWork(); // first sight creates the boundary, primes, then fills
    const b = await Domain.findBoundary({ service: "slack", workspace: WS, value: CH });
    expect(b).not.toBeNull();
    const after = (await rows())[0]!;
    expect(after.boundary_id).toBe(b!.id);
    expect(after.locator).toBe("1700000000.000200");
    // the next session in the channel carries the pair at once
    expect((await mk("1700000000.000300")).boundary_id).toBe(b!.id);
  });

  test("compare-and-set: a filled row is never overwritten, other channels and teams are untouched", async () => {
    const b = await seedBoundary();
    const filled = await mk("1.1");
    // The create started first sight in the background, and its late fill would complete any NULL row
    // inserted below before the explicit call. Let it finish first, so the call under test does the work.
    await flushFirstSightWork();
    await db.run("UPDATE sessions SET boundary_id = 'b-other', locator = 'x' WHERE id = ?", [filled.id]);
    await db.run(
      "INSERT INTO sessions (id, created_at, updated_at, model, working_dir, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ('n1', 1, 1, 'm', '/w', ?, ?, '2.2')",
      [WS, CH],
    );
    await db.run(
      "INSERT INTO sessions (id, created_at, updated_at, model, working_dir, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ('n2', 1, 1, 'm', '/w', 'T0OTHER', ?, '2.2')",
      [CH],
    );
    await db.run("INSERT INTO sessions (id, created_at, updated_at, model, working_dir, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ('n3', 1, 1, 'm', '/w', NULL, ?, '2.2')", [CH]);
    await db.run(
      "INSERT INTO sessions (id, created_at, updated_at, model, working_dir, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ('n4', 1, 1, 'm', '/w', ?, 'C0ELSEWHERE', '2.2')",
      [WS],
    );
    expect(await Sessions.fillBoundaryForChannel(WS, CH, b)).toBe(1);
    expect(await Sessions.fillBoundaryForChannel(WS, CH, b)).toBe(0); // idempotent
    const byId = Object.fromEntries((await rows()).map((x) => [x.id, x]));
    expect(byId[filled.id]).toMatchObject({ boundary_id: "b-other", locator: "x" });
    expect(byId.n1).toMatchObject({ boundary_id: b, locator: "2.2" });
    for (const id of ["n2", "n3", "n4"]) expect(byId[id]!.boundary_id).toBeNull();
  });

  test("the kill switch stops the late fill", async () => {
    const b = await seedBoundary();
    await db.run("INSERT INTO sessions (id, created_at, updated_at, model, working_dir, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ('n1', 1, 1, 'm', '/w', ?, ?, '2.2')", [WS, CH]);
    process.env.SLAUDE_BOUNDARY_WRITE = "off";
    expect(await Sessions.fillBoundaryForChannel(WS, CH, b)).toBe(0);
  });
});

describe("archiveChannelSession (/new)", () => {
  const dupGroups = () =>
    db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sessions WHERE boundary_id IS NOT NULL GROUP BY boundary_id, locator, persona_id HAVING COUNT(*) > 1`,
    );

  test("the archived row carries the archived locator and the new channel session does not duplicate it", async () => {
    const b = await seedBoundary();
    const key = `channel:${CH}`;
    const old = await mk(key);
    expect([old.boundary_id, old.locator]).toEqual([b, key]);
    const now = 1_800_000_000_000;
    await Sessions.archiveChannelSession(old.id, CH, now);
    const archived = (await rows(`id = '${old.id}'`))[0]!;
    expect(archived.slack_thread_ts).toBe(`channel-archived:${CH}:${now}`);
    expect(archived.locator).toBe(`channel-archived:${CH}:${now}`);
    expect(archived.boundary_id).toBe(b);
    const fresh = await mk(key);
    expect(fresh.id).not.toBe(old.id);
    expect([fresh.boundary_id, fresh.locator]).toEqual([b, key]);
    expect(await dupGroups()).toEqual([]);
    // archiving twice in a row (two /new) keeps every locator distinct
    await Sessions.archiveChannelSession(fresh.id, CH, now + 1);
    await mk(key);
    expect(await dupGroups()).toEqual([]);
  });

  test("a row with no boundary keeps a NULL locator, and the fill derives it from the rewritten thread key", async () => {
    const key = `channel:${CH}`;
    const old = await mk(key); // cold: NULL pair
    expect(old.boundary_id).toBeNull();
    await flushFirstSightWork(); // late fill would complete it; undo that to stage the NULL case
    await db.run("UPDATE sessions SET boundary_id = NULL, locator = NULL");
    await Sessions.archiveChannelSession(old.id, CH, 42);
    const archived = (await rows())[0]!;
    expect(archived.slack_thread_ts).toBe(`channel-archived:${CH}:42`);
    expect([archived.boundary_id, archived.locator]).toEqual([null, null]);
    const b = (await Domain.findBoundary({ service: "slack", workspace: WS, value: CH }))!.id;
    await Sessions.fillBoundaryForChannel(WS, CH, b);
    expect((await rows())[0]).toMatchObject({ boundary_id: b, locator: `channel-archived:${CH}:42` });
  });
});

describe("deleteWakeSessionsBefore", () => {
  test("pair-carrying wake rows delete cleanly, nothing resurrects them, real threads stay", async () => {
    await seedBoundary();
    const wake = await mk(`wake:${CH}:1`);
    const keep = await mk("1700000000.000400");
    expect(wake.boundary_id).not.toBeNull();
    await db.run("UPDATE sessions SET updated_at = 1 WHERE id = ?", [wake.id]);
    expect(await Sessions.deleteWakeSessionsBefore(Date.now() + 1000)).toBe(1);
    await flushFirstSightWork();
    expect((await rows()).map((r) => r.id)).toEqual([keep.id]);
    expect(await Sessions.deleteWakeSessionsBefore(Date.now() + 1000)).toBe(0);
  });
});

describe("a create never hands its caller null", () => {
  const key = { team_id: WS, channel_id: CH, thread_ts: "5.5" };
  const create = () => Sessions.createForThread({ thread: key, model: "m", working_dir: "/w" });

  test("a second create of an existing thread returns the first row (no unique violation)", async () => {
    const a = await create();
    const b = await create();
    expect(b.id).toBe(a.id);
    expect(await rows()).toHaveLength(1);
  });

  test("a row that is not visible to the first read-back is found by the retry", async () => {
    const orig = db.one.bind(db);
    let hidden = 1;
    (db as { one: typeof db.one }).one = (async (sql: string, params?: unknown[]) => {
      if (/FROM sessions WHERE id = \?/.test(sql) && hidden-- > 0) return null; // the first re-read misses the just-committed row
      return orig(sql, params);
    }) as typeof db.one;
    try {
      const r = await create();
      expect(r.slack_thread_ts).toBe("5.5");
    } finally {
      (db as { one: typeof db.one }).one = orig;
    }
  });

  test("a row that never becomes readable raises a typed error, not null", async () => {
    const orig = db.one.bind(db);
    (db as { one: typeof db.one }).one = (async (sql: string, params?: unknown[]) => (/FROM sessions WHERE id = \?/.test(sql) ? null : orig(sql, params))) as typeof db.one;
    try {
      await expect(create()).rejects.toThrow(Sessions.SessionCreateError);
    } finally {
      (db as { one: typeof db.one }).one = orig;
    }
  });
});

describe("concurrency", () => {
  test("20 parallel creates of one thread (warm): one row, every caller gets it, pair set once", async () => {
    const b = await seedBoundary();
    const out = await Promise.allSettled(Array.from({ length: 20 }, () => Sessions.createForThread({ thread: thread("9.9"), model: "m", working_dir: "/w" })));
    expect(out.every((o) => o.status === "fulfilled")).toBe(true);
    const ids = new Set(out.map((o) => (o as PromiseFulfilledResult<{ id: string }>).value.id));
    expect(ids.size).toBe(1);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ boundary_id: b, locator: "9.9" });
  });

  test("20 parallel creates of one thread (cold): one row, completed once first sight finishes", async () => {
    const out = await Promise.allSettled(Array.from({ length: 20 }, () => Sessions.createForThread({ thread: thread("9.9"), model: "m", working_dir: "/w" })));
    expect(out.every((o) => o.status === "fulfilled")).toBe(true);
    await flushFirstSightWork();
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.boundary_id).not.toBeNull();
    expect(all[0]!.locator).toBe("9.9");
  });

  test("a burst of threads in a new channel ends with every row filled", async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => mk(`1700000001.${String(i).padStart(6, "0")}`)));
    await flushFirstSightWork();
    const all = await rows();
    expect(all).toHaveLength(30);
    expect(all.every((r) => r.boundary_id !== null && r.locator === r.slack_thread_ts)).toBe(true);
    expect(new Set(all.map((r) => r.boundary_id)).size).toBe(1);
  });
});

describe("guard: who may assign boundary_id and locator on an existing row", () => {
  // Line counts of SQL assignments (`boundary_id = ?`, `locator = CASE ...`) per file. A new assignment anywhere,
  // or a new statement in one of these files, changes a count and fails here until it is reviewed: every one must be
  // a compare-and-set on NULL, a COALESCE or key-following upsert, or the archive's locator rewrite.
  const ALLOWED: Record<string, number> = {
    "src/db/sessions.ts": 2, // the late fill (CAS on NULL) and the archive's locator rewrite
    "src/domain/boundary-backfill.ts": 2, // the fill (CAS on NULL) and the locator repair (CAS on the old locator)
    "src/db/one-on-one.ts": 2,
    "src/db/mention-only.ts": 2,
    "src/db/commitments.ts": 2,
    "src/db/environments.ts": 4,
    "src/db/channel-wake-state.ts": 3,
  };
  const root = join(import.meta.dir, "../..");
  const files = (): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f)) out.push(p.slice(root.length + 1));
      }
    };
    walk(join(root, "src"));
    return out;
  };

  test("assignment lines per file are exactly the reviewed ones", () => {
    const found: Record<string, number> = {};
    for (const f of files()) {
      const n = readFileSync(join(root, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /\b(boundary_id|locator) = (\?|COALESCE|CASE|excluded|slack_|\$\{)/.test(l)).length;
      if (n) found[f] = n;
    }
    expect(found).toEqual(ALLOWED);
  });

  test("every assignment outside an upsert is guarded by IS NULL or the old value", () => {
    const sessions = readFileSync(join(root, "src/db/sessions.ts"), "utf8");
    expect(sessions).toMatch(/SET boundary_id = \?, locator = slack_thread_ts[\s\S]{0,200}boundary_id IS NULL/);
    const fill = readFileSync(join(root, "src/domain/boundary-backfill.ts"), "utf8");
    expect(fill).toContain("AND boundary_id IS NULL AND");
    expect(fill).toMatch(/locator IS NULL" : "locator = \?"/);
  });
});
