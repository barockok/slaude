import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as Domain from "../../src/db/domain";
import * as Commitments from "../../src/db/commitments";
import * as Cron from "../../src/db/cron-jobs";
import * as Envs from "../../src/db/environments";
import * as Ignores from "../../src/db/ignores";
import * as MentionOnly from "../../src/db/mention-only";
import * as OneOnOne from "../../src/db/one-on-one";
import * as Posts from "../../src/db/proactive-posts";
import * as Wake from "../../src/db/channel-wake-state";
import { cronLocator } from "../../src/db/boundary-columns";
import { db } from "../../src/db/schema";
import { __setBoundaryResolver, primeBoundary } from "../../src/domain/boundary-for";
import { resetBoundaryState } from "../helpers/boundary-state";
import { flushFirstSightWork } from "../../src/domain/first-sight-flush";

const WS = "T0EXAMPLE";
const CH = "C0EXAMPLE";
const TS = "1700000000.000100";
const TABLES = ["one_on_one_locks", "mention_only_threads", "ignores", "cron_jobs", "commitments", "env_bindings", "proactive_posts", "channel_wake_state", "remote_targets", "environments"];

// The first statement opens the database and applies the migrations (seconds on a cold PGLite): do it once, with room.
beforeAll(async () => {
  await db.query("SELECT 1");
}, 60_000);

async function clean(): Promise<void> {
  await resetBoundaryState();
  for (const t of TABLES) await db.run(`DELETE FROM ${t}`);
  await Domain._wipeForTests();
}
beforeEach(clean);
afterEach(clean);

const warm = async (): Promise<string> => {
  const id = (await Domain.ensureBoundary({ service: "slack", workspace: WS, value: CH, kind: "channel", state: "observed" })).boundary.id;
  primeBoundary(WS, CH, id);
  return id;
};
const pair = async (table: string, where = "1 = 1") => db.one<{ boundary_id: string | null; locator: string | null }>(`SELECT boundary_id, locator FROM ${table} WHERE ${where}`);

describe("one_on_one_locks", () => {
  test("cold writes NULL, warm writes the pair, a relock keeps a filled pair and fills a NULL one", async () => {
    await OneOnOne.lock({ channelId: CH, threadTs: TS, lockedUser: "U0EXAMPLE", createdBy: "U0EXAMPLE", teamId: WS });
    expect(await pair("one_on_one_locks")).toEqual({ boundary_id: null, locator: null });
    const b = await warm();
    await OneOnOne.lock({ channelId: CH, threadTs: TS, lockedUser: "U0EXAMPLE", createdBy: "U0EXAMPLE", teamId: WS });
    expect(await pair("one_on_one_locks")).toEqual({ boundary_id: b, locator: TS });
    // a relock whose writer did not know the team must not null the pair
    await OneOnOne.lock({ channelId: CH, threadTs: TS, lockedUser: "U0EXAMPLE", createdBy: "U0EXAMPLE" });
    expect(await pair("one_on_one_locks")).toEqual({ boundary_id: b, locator: TS });
    expect((await OneOnOne.find(CH, TS))!.locked_user).toBe("U0EXAMPLE");
  });
});

describe("mention_only_threads and ignores (team-less tables)", () => {
  test("the caller's team decides; without it the pair stays NULL", async () => {
    const b = await warm();
    await MentionOnly.set({ channelId: CH, threadTs: "1.1", createdBy: "U0EXAMPLE" });
    await MentionOnly.set({ channelId: CH, threadTs: "2.2", createdBy: "U0EXAMPLE", teamId: WS });
    expect(await pair("mention_only_threads", "thread_ts = '1.1'")).toEqual({ boundary_id: null, locator: null });
    expect(await pair("mention_only_threads", "thread_ts = '2.2'")).toEqual({ boundary_id: b, locator: "2.2" });
    await MentionOnly.set({ channelId: CH, threadTs: "2.2", createdBy: "U0OTHER" });
    expect(await pair("mention_only_threads", "thread_ts = '2.2'")).toEqual({ boundary_id: b, locator: "2.2" });
  });

  test("thread ignores carry the pair, user ignores never do", async () => {
    const b = await warm();
    await Ignores.create({ targetType: "thread", channelId: CH, threadTs: TS, teamId: WS, createdBy: "U0EXAMPLE" });
    await Ignores.create({ targetType: "user", userId: "U0EXAMPLE", teamId: WS, createdBy: "U0EXAMPLE" });
    expect(await pair("ignores", "target_type = 'thread'")).toEqual({ boundary_id: b, locator: TS });
    expect(await pair("ignores", "target_type = 'user'")).toEqual({ boundary_id: null, locator: null });
    expect((await Ignores.findActiveForThread(CH, TS))!.threadTs).toBe(TS);
  });
});

describe("cron_jobs", () => {
  const mk = (extra: Partial<Parameters<typeof Cron.create>[0]>) =>
    Cron.create({ slackTeamId: WS, slackChannelId: CH, channelId: CH, createdBy: "U0EXAMPLE", cronExpr: "* * * * *", prompt: "p", nextRunAt: 1, ...extra });

  test("the locator is the session key the scheduler uses", async () => {
    const b = await warm();
    const thread = await mk({ slackThreadTs: TS, threadTs: TS, target: "thread" });
    const chan = await mk({ slackThreadTs: undefined, target: "channel" });
    const none = await mk({ target: "thread" });
    const rows = Object.fromEntries((await db.query<{ id: string; boundary_id: string | null; locator: string | null }>("SELECT id, boundary_id, locator FROM cron_jobs")).map((r) => [r.id, r]));
    expect(rows[thread.id]).toMatchObject({ boundary_id: b, locator: TS });
    expect(rows[chan.id]).toMatchObject({ boundary_id: b, locator: `cron:${chan.id}` });
    expect(rows[none.id]).toMatchObject({ boundary_id: b, locator: `cron:${none.id}` });
  });

  test("cronLocator: a channel target ignores a thread, a thread target falls back to cron:<id>", () => {
    expect(cronLocator({ id: "j", target: "channel", slackThreadTs: TS })).toBe("cron:j");
    expect(cronLocator({ id: "j", target: "thread", slackThreadTs: TS })).toBe(TS);
    expect(cronLocator({ id: "j", target: "thread", slackThreadTs: null })).toBe("cron:j");
  });

  test("cold writes NULL and the legacy columns are as before", async () => {
    const j = await mk({ slackThreadTs: TS, threadTs: TS });
    expect(await pair("cron_jobs")).toEqual({ boundary_id: null, locator: null });
    expect(j).toMatchObject({ slackTeamId: WS, slackChannelId: CH, slackThreadTs: TS, channelId: CH, threadTs: TS });
  });
});

describe("commitments", () => {
  const c = (over: Partial<Commitments.CommitmentRow> = {}) => ({
    agentId: "a", source: "s", slug: "x", personaId: "default", teamId: WS as string | null, channelId: CH, threadTs: TS, beneficiary: "U0EXAMPLE", runAs: null,
    dueText: "d", dueKind: "time" as const, checkText: "", onNoChange: "silent" as const, nextCheckAt: 1, expiresAt: 2, createdAt: 1, ...over,
  });
  test("pair on insert; a rewrite without a team keeps a filled pair; a NULL pair is filled", async () => {
    await Commitments.upsertOpen(c());
    expect(await pair("commitments")).toEqual({ boundary_id: null, locator: null });
    const b = await warm();
    await Commitments.upsertOpen(c());
    expect(await pair("commitments")).toEqual({ boundary_id: b, locator: TS });
    await Commitments.upsertOpen(c({ teamId: null }));
    expect(await pair("commitments")).toEqual({ boundary_id: b, locator: TS });
  });
});

describe("env_bindings", () => {
  test("bind writes the pair when the caller passes the team and a rebind keeps it", async () => {
    const b = await warm();
    await Envs.bind({ channelId: CH, threadTs: "1.1", envId: "e", dir: "/d", lockByEnv: false });
    await Envs.bind({ channelId: CH, threadTs: "2.2", envId: "e", dir: "/d", lockByEnv: true, teamId: WS });
    expect(await pair("env_bindings", "thread_ts = '1.1'")).toEqual({ boundary_id: null, locator: null });
    expect(await pair("env_bindings", "thread_ts = '2.2'")).toEqual({ boundary_id: b, locator: "2.2" });
    await Envs.bind({ channelId: CH, threadTs: "2.2", envId: "e2", dir: "/d2", lockByEnv: false });
    expect(await pair("env_bindings", "thread_ts = '2.2'")).toEqual({ boundary_id: b, locator: "2.2" });
    expect((await Envs.bindingsForEnv("e2"))[0]!.dir).toBe("/d2");
    await Envs.bind({ channelId: CH, threadTs: "1.1", envId: "e", dir: "/d", lockByEnv: false, teamId: WS });
    expect(await pair("env_bindings", "thread_ts = '1.1'")).toEqual({ boundary_id: b, locator: "1.1" });
  });

  test("convertLegacy derives the pair from the legacy row's team and keeps a filled pair", async () => {
    const b = await warm();
    await db.run("INSERT INTO remote_targets (channel_id, thread_ts, team_id, user_id, addr, dir, lock_by_remote, created_at) VALUES (?, ?, ?, 'U0EXAMPLE', 'host.example.com', '/d', 0, 1)", [CH, TS, WS]);
    const row = await Envs.findBinding(CH, TS);
    expect(row).not.toBeNull();
    expect(await pair("env_bindings")).toEqual({ boundary_id: b, locator: TS });
  });
});

describe("proactive_posts and channel_wake_state (boundary only)", () => {
  test("a post carries boundary_id from its team and channel", async () => {
    const b = await warm();
    await Posts.recordPost({ agentId: "a", audience: "person", recipient: "U0EXAMPLE", topic: "t", textHash: "h", evidenceHash: null, channelId: CH, messageTs: "1.1", teamId: WS, postedAt: 1 });
    await Posts.recordPost({ agentId: "a", audience: "person", recipient: "U0EXAMPLE", topic: "t", textHash: "h", evidenceHash: null, channelId: CH, messageTs: "1.2", teamId: null, postedAt: 2 });
    expect((await db.one<{ boundary_id: string | null }>("SELECT boundary_id FROM proactive_posts WHERE message_ts = '1.1'"))!.boundary_id).toBe(b);
    expect((await db.one<{ boundary_id: string | null }>("SELECT boundary_id FROM proactive_posts WHERE message_ts = '1.2'"))!.boundary_id).toBeNull();
  });

  test("noteStart, noteFinished and noteSettled keep a filled boundary and fill a NULL one", async () => {
    await Wake.noteFinished("A1", CH, 500, 150);
    expect((await db.one<{ boundary_id: string | null }>("SELECT boundary_id FROM channel_wake_state"))!.boundary_id).toBeNull();
    const b = await warm();
    await Wake.noteSettled("A1", CH, { outcome: "ok", failures: 0, nextCheckAt: null }, 160, WS);
    expect((await db.one<{ boundary_id: string | null }>("SELECT boundary_id FROM channel_wake_state"))!.boundary_id).toBe(b);
    await Wake.noteFinished("A1", CH, 600, 170);
    await Wake.noteSettled("A1", CH, { outcome: "ok", failures: 0, nextCheckAt: null }, 180);
    await Wake.noteStart("A1", CH, "h", "run1", 190);
    expect((await db.one<{ boundary_id: string | null }>("SELECT boundary_id FROM channel_wake_state"))!.boundary_id).toBe(b);
    expect((await Wake.get("A1", CH))).toMatchObject({ nextCheckAt: 600, lastOutcome: "ok" });
  });
});

describe("an upsert keeps the pair that belongs to the row's own key", () => {
  const cm = (over: Record<string, unknown> = {}) => ({
    agentId: "a", source: "s", slug: "x", personaId: "default", teamId: WS as string | null, channelId: CH, threadTs: TS, beneficiary: "U0EXAMPLE", runAs: null,
    dueText: "d", dueKind: "time" as const, checkText: "", onNoChange: "silent" as const, nextCheckAt: 1, expiresAt: 2, createdAt: 1, ...over,
  });

  test("a commitment saved again into another channel or thread takes the new pair, even NULL, never the old one", async () => {
    const b = await warm();
    await Commitments.upsertOpen(cm());
    expect(await pair("commitments")).toEqual({ boundary_id: b, locator: TS });
    // another channel, boundary not known: the old pair must not stay
    await Commitments.upsertOpen(cm({ channelId: "C0ELSEWHERE" }));
    expect(await pair("commitments")).toEqual({ boundary_id: null, locator: null });
    // back, then another thread of the same channel: the locator follows the thread
    await Commitments.upsertOpen(cm());
    expect(await pair("commitments")).toEqual({ boundary_id: b, locator: TS });
    await Commitments.upsertOpen(cm({ threadTs: "9.9" }));
    expect(await pair("commitments")).toEqual({ boundary_id: b, locator: "9.9" });
  });

  test("a commitment writer with a different team replaces the pair; the same team or no team keeps it", async () => {
    const b = await warm();
    await Commitments.upsertOpen(cm());
    await Commitments.upsertOpen(cm({ teamId: null }));
    await Commitments.upsertOpen(cm({ teamId: WS }));
    expect(await pair("commitments")).toEqual({ boundary_id: b, locator: TS });
    await Commitments.upsertOpen(cm({ teamId: "T0OTHER" }));
    expect(await pair("commitments")).toEqual({ boundary_id: null, locator: null });
  });

  test("a lock taken by another team replaces the pair; the same team or no team keeps it", async () => {
    const b = await warm();
    const lock = (teamId?: string) => OneOnOne.lock({ channelId: CH, threadTs: TS, lockedUser: "U0EXAMPLE", createdBy: "U0EXAMPLE", teamId });
    await lock(WS);
    await lock();
    await lock(WS);
    expect(await pair("one_on_one_locks")).toEqual({ boundary_id: b, locator: TS });
    await lock("T0OTHER");
    expect(await pair("one_on_one_locks")).toEqual({ boundary_id: null, locator: null });
  });

  test("a primary-key table never swaps a filled pair for another one", async () => {
    const b = await warm();
    await MentionOnly.set({ channelId: CH, threadTs: TS, createdBy: "U0EXAMPLE", teamId: WS });
    primeBoundary("T0OTHER", CH, "b-other-team");
    await MentionOnly.set({ channelId: CH, threadTs: TS, createdBy: "U0EXAMPLE", teamId: "T0OTHER" });
    expect(await pair("mention_only_threads")).toEqual({ boundary_id: b, locator: TS });
    await Envs.bind({ channelId: CH, threadTs: TS, envId: "e", dir: "/d", lockByEnv: false, teamId: WS });
    await Envs.bind({ channelId: CH, threadTs: TS, envId: "e", dir: "/d", lockByEnv: false, teamId: "T0OTHER" });
    expect(await pair("env_bindings")).toEqual({ boundary_id: b, locator: TS });
    await Wake.noteFinished("A1", CH, 500, 150, WS);
    await Wake.noteFinished("A1", CH, 500, 150, "T0OTHER");
    expect((await db.one<{ boundary_id: string | null }>("SELECT boundary_id FROM channel_wake_state"))!.boundary_id).toBe(b);
  });
});

describe("kill switch", () => {
  test("SLAUDE_BOUNDARY_WRITE=off stores NULL pairs everywhere", async () => {
    await warm();
    process.env.SLAUDE_BOUNDARY_WRITE = "off";
    await OneOnOne.lock({ channelId: CH, threadTs: TS, lockedUser: "U0EXAMPLE", createdBy: "U0EXAMPLE", teamId: WS });
    await MentionOnly.set({ channelId: CH, threadTs: TS, createdBy: "U0EXAMPLE", teamId: WS });
    await Wake.noteFinished("A1", CH, 500, 150, WS);
    for (const t of ["one_on_one_locks", "mention_only_threads"]) expect((await pair(t))!.boundary_id).toBeNull();
    expect((await db.one<{ boundary_id: string | null }>("SELECT boundary_id FROM channel_wake_state"))!.boundary_id).toBeNull();
  });
});

describe("guard: every INSERT into a thread or channel table names the pair", () => {
  const root = join(import.meta.dir, "../..");
  const TABLES = ["sessions", "one_on_one_locks", "mention_only_threads", "ignores", "cron_jobs", "commitments", "env_bindings", "proactive_posts", "channel_wake_state"];
  // Statement counts per file: a new INSERT shows up here and has to be reviewed.
  const EXPECTED: Record<string, number> = {
    "src/db/sessions.ts": 1,
    "src/db/one-on-one.ts": 1,
    "src/db/mention-only.ts": 1,
    "src/db/ignores.ts": 1,
    "src/db/cron-jobs.ts": 1,
    "src/db/commitments.ts": 1,
    "src/db/environments.ts": 2, // bind and convertLegacy
    "src/db/proactive-posts.ts": 1,
    "src/db/channel-wake-state.ts": 3, // noteStart, noteFinished, noteSettled
  };
  const SKIP = new Set(["src/db/drivers/sqlite.ts"]); // the sqlite rebuild copies old rows before the columns exist
  const all = (): string[] => {
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

  test("each statement's column list names boundary_id, and the statements are exactly the reviewed ones", () => {
    const found: Record<string, number> = {};
    const re = new RegExp(`INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+(${TABLES.join("|")})\\b([\\s\\S]*?)(?:VALUES|SELECT)`, "gi");
    for (const f of all()) {
      if (SKIP.has(f)) continue;
      const text = readFileSync(join(root, f), "utf8");
      for (const m of text.matchAll(re)) {
        found[f] = (found[f] ?? 0) + 1;
        expect(m[2], `${f}: INSERT INTO ${m[1]}`).toContain("boundary_id");
        if (TABLES.slice(0, 7).includes(m[1]!) && !["proactive_posts", "channel_wake_state"].includes(m[1]!)) expect(m[2], `${f}: INSERT INTO ${m[1]}`).toContain("locator");
      }
    }
    expect(found).toEqual(EXPECTED);
  });

  test("no INSERT into a dynamic table name in src (it could bypass the list above)", () => {
    const hits: string[] = [];
    for (const f of all()) {
      if (f === "src/cli/migrate-sqlite.ts" || f === "src/domain/boundary-backfill.ts") continue;
      if (/INSERT\s+(OR\s+\w+\s+)?INTO\s+\$\{/i.test(readFileSync(join(root, f), "utf8"))) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});
