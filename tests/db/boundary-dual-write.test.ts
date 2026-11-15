import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
import { flushFirstSightWork } from "../../src/domain/first-sight-flush";

const WS = "T0EXAMPLE";
const CH = "C0EXAMPLE";
const TS = "1700000000.000100";
const TABLES = ["one_on_one_locks", "mention_only_threads", "ignores", "cron_jobs", "commitments", "env_bindings", "proactive_posts", "channel_wake_state", "remote_targets", "environments"];

async function clean(): Promise<void> {
  await flushFirstSightWork();
  for (const t of TABLES) await db.run(`DELETE FROM ${t}`);
  await Domain._wipeForTests();
  __setBoundaryResolver(undefined);
  delete process.env.SLAUDE_BOUNDARY_WRITE;
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

describe("guard: every writer that inserts a thread or channel key names the pair", () => {
  const root = join(import.meta.dir, "../..");
  const writers: Array<[string, RegExp, string]> = [
    ["src/db/sessions.ts", /INSERT INTO sessions/, "boundary_id"],
    ["src/db/one-on-one.ts", /INSERT INTO one_on_one_locks/, "boundary_id"],
    ["src/db/mention-only.ts", /INSERT INTO mention_only_threads/, "boundary_id"],
    ["src/db/ignores.ts", /INSERT INTO ignores/, "boundary_id"],
    ["src/db/cron-jobs.ts", /INSERT INTO cron_jobs/, "boundary_id"],
    ["src/db/commitments.ts", /INSERT INTO commitments/, "boundary_id"],
    ["src/db/environments.ts", /INSERT INTO env_bindings/, "boundary_id"],
    ["src/db/proactive-posts.ts", /INSERT INTO proactive_posts/, "boundary_id"],
    ["src/db/channel-wake-state.ts", /INSERT INTO channel_wake_state/, "boundary_id"],
  ];
  test("each INSERT statement lists boundary_id", () => {
    for (const [file, re, col] of writers) {
      const src = readFileSync(join(root, file), "utf8");
      const stmts = src.split(/(?=`INSERT INTO)/).filter((p) => p.startsWith("`INSERT INTO") && re.test(p)).map((p) => p.slice(0, p.indexOf("VALUES")));
      expect(stmts.length).toBeGreaterThan(0);
      for (const s of stmts) expect(s, `${file}: ${s.slice(0, 80)}`).toContain(col);
    }
  });

  test("no other module inserts into these tables", () => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const names = writers.map(([f]) => f);
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f)) {
          const rel = p.slice(root.length + 1);
          if (names.includes(rel) || rel === "src/db/drivers/sqlite.ts" || rel === "src/cli/migrate-sqlite.ts") continue;
          if (/INSERT\s+(OR\s+\w+\s+)?INTO\s+(sessions|one_on_one_locks|mention_only_threads|ignores|cron_jobs|commitments|env_bindings|proactive_posts|channel_wake_state)\b/i.test(readFileSync(p, "utf8"))) hits.push(rel);
        }
      }
    };
    walk(join(root, "src"));
    expect(hits).toEqual([]);
  });
});
