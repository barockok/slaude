/**
 * The weekly digest (spec §9.1, §9.2, §9.3, §9.4 "the digest renders from the
 * ledger"): exact spend from a fixed ledger, skipped passes listed, buttons
 * only for open manager proposals, a slot once a week, lesson changes against
 * the previous digest's snapshot, delivery to the manager (and backup) only,
 * and expiry of unanswered proposals after 14 days.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { ensureHome, paths } from "../../src/config/home";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import type { BackgroundRun, RunOutcome } from "../../src/db/background-runs";
import * as Proposals from "../../src/db/proposals";
import { coveredDays, diffLessons, digestRecipientOf, personaApp, renderDigest, runDigest, type DigestDeps } from "../../src/background/digest";
import * as Sessions from "../../src/db/sessions";
import { approveActionId, rejectActionId, restoreActionId, type Block, type CardPost } from "../../src/background/proposal-cards";
import { createBackgroundScheduler, type AgentGroup } from "../../src/background/scheduler";
import { LESSONS_SLUG } from "../../src/background/passes/lessons-upkeep";
import { agentSourceId } from "../../src/knowledge/scope";
import { skillOps } from "../../src/skills/mcp-tools";
import { fakeBrain } from "./fake-brain";

const AGENT = "U0AGENT";
const MANAGER = "U0MANAGER";
const BACKUP = "U0BACKUP";
const PERSON = "U0ALICE";
const MONDAY = new Date("2026-10-26T09:05:00Z"); // ISO week 2026-W44; covers 2026-10-19..2026-10-25
const DAY = 86_400_000;
const ZERO = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
const group: AgentGroup = { agentId: AGENT, personaId: "default", personaIds: ["default"], timeZone: "UTC" };

let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let debugSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  ensureHome();
  if (existsSync(paths.skills)) rmSync(paths.skills, { recursive: true, force: true });
  mkdirSync(paths.skills, { recursive: true });
  for (const t of ["proposals", "background_runs", "background_slots"]) await db.run(`DELETE FROM ${t}`);
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
  debugSpy = spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  debugSpy.mockRestore();
});

const run = (day: string, pass: string, costUsd: number, outcome: RunOutcome | null, scope = "agent"): BackgroundRun => ({
  id: `${day}-${pass}-${costUsd}-${scope}`,
  agentId: AGENT,
  pass,
  scope,
  model: "m",
  tokens: ZERO,
  costUsd,
  startedAt: Date.parse(`${day}T03:00:00Z`),
  finishedAt: outcome ? Date.parse(`${day}T03:05:00Z`) : null,
  outcome,
  day,
});

const proposal = (over: Partial<Proposals.Proposal>): Proposals.Proposal => ({
  id: "p-1",
  agentId: AGENT,
  kind: "team-fact",
  toKind: "manager",
  toUser: null,
  scope: "agent",
  payload: { summary: "Who owns deploys", pages: [{ slug: "team/deploys", content: "The platform team owns deploys.", type: "team-fact" }] },
  createdAt: Date.parse("2026-10-20T03:00:00Z"),
  expiresAt: Date.parse("2026-11-03T03:00:00Z"),
  status: "open",
  decidedBy: null,
  decidedAt: null,
  slackAppId: null,
  slackTeamId: null,
  ...over,
});

const allText = (blocks: Block[]): string => JSON.stringify(blocks);
const actionIds = (blocks: Block[]): string[] =>
  blocks.filter((b) => b.type === "actions").flatMap((b) => (b.elements as Block[]).map((e) => e.action_id as string));

const DAYS = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];

describe("renderDigest", () => {
  test("exact spend per day from a fixed ledger, the skipped list, and buttons only for open manager proposals", () => {
    const runs = [
      run("2026-10-19", "nightly-review", 0.31, "ok"),
      run("2026-10-19", "lessons-upkeep", 0.04, "ok"),
      run("2026-10-20", "nightly-review", 0.12, "ok", `user:${PERSON}`),
      run("2026-10-20", "quiet-moment", 0, "skipped-budget", `user:${PERSON}`),
      run("2026-10-20", "quiet-moment", 0, "skipped-budget"),
      run("2026-10-22", "skill-check", 0.0275, "stopped-budget"),
      run("2026-10-25", "skill-review", 1.25, "ok"),
      run("2026-10-25", "skill-check", 0, "skipped-budget"),
      run("2026-10-18", "nightly-review", 9, "ok"), // outside the week: never counted
    ];
    const open = proposal({ id: "p-open" });
    const decided = proposal({ id: "p-decided", status: "approved", decidedBy: MANAGER, decidedAt: 1 });
    const personal = proposal({ id: "p-person", kind: "promote", toKind: "person", toUser: PERSON, scope: `user:${PERSON}`, payload: { summary: "SECRET-PERSON-CONTENT" } });
    const { text, blocks } = renderDigest({
      week: "2026-W44",
      days: DAYS,
      limitUsd: 1,
      runs,
      lessons: { added: ["- 2026-10-21 ask before paging"], dropped: ["- old lesson"], total: 3, first: false },
      skillsAdded: [{ slug: "triage", at: "2026-10-23" }],
      retirements: [],
      proposals: [open, decided, personal],
    });
    const all = allText(blocks);
    expect(all).toContain("2026-10-19: $0.3500 of $1.0000");
    expect(all).toContain("2026-10-20: $0.1200 of $1.0000");
    expect(all).toContain("2026-10-21: $0.0000 of $1.0000");
    expect(all).toContain("2026-10-22: $0.0275 of $1.0000");
    expect(all).toContain("2026-10-25: $1.2500 of $1.0000 (over)");
    expect(all).toContain("Week: $1.7475 of $7.0000");
    expect(all).toContain("quiet-moment: skipped-budget 2");
    expect(all).toContain("skill-check: skipped-budget 1, stopped-budget 1");
    expect(all).toContain("2026-10-20 quiet-moment (2×)");
    expect(all).toContain("2026-10-25 skill-check");
    expect(all).not.toContain(PERSON); // a skipped run's scope never names the person
    expect(all).toContain("+ - 2026-10-21 ask before paging");
    expect(all).toContain("− - old lesson");
    expect(all).toContain("`triage` (2026-10-23)");
    expect(actionIds(blocks)).toEqual([approveActionId("p-open"), rejectActionId("p-open")]);
    expect(all).not.toContain("SECRET-PERSON-CONTENT");
    expect(text).toContain("$1.7475 spent, 2 skipped, 1 open proposal");
    expect(blocks.length).toBeLessThanOrEqual(50);
  });

  test("many proposals stay within Slack's 50 blocks; model text is escaped", () => {
    const many = Array.from({ length: 30 }, (_, i) => proposal({ id: `p-${i}`, payload: { summary: "<!channel> & <https://x|y>" } }));
    const { blocks } = renderDigest({ week: "2026-W44", days: DAYS, limitUsd: 1, runs: [], lessons: null, skillsAdded: [], retirements: [], proposals: many });
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(actionIds(blocks).length).toBe(16); // MAX_DIGEST_PROPOSALS × 2
    const all = allText(blocks);
    expect(all).not.toContain("<!channel>");
    expect(all).toContain("&lt;!channel&gt; &amp;");
    expect(all).toContain("22 more open");
  });

  test("coveredDays is the Monday-to-Sunday week before, in the persona's zone", () => {
    expect(coveredDays(MONDAY, "UTC")).toEqual(DAYS);
    // A late digest (Wednesday) still covers the same week.
    expect(coveredDays(new Date("2026-10-28T12:00:00Z"), "UTC")).toEqual(DAYS);
    // 2026-10-26T02:00Z is still Sunday the 25th in New York.
    expect(coveredDays(new Date("2026-10-26T02:00:00Z"), "America/New_York")[6]).toBe("2026-10-18");
  });

  test("diffLessons: added and dropped by line; the first digest lists the page", () => {
    expect(diffLessons(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], dropped: ["a"], total: 2, first: false });
    expect(diffLessons(null, ["a"])).toEqual({ added: ["a"], dropped: [], total: 1, first: true });
  });
});

function digestDeps(over: Partial<DigestDeps> = {}) {
  const brain = fakeBrain();
  const sent: Array<{ channel: string; text: string; blocks: Block[] }> = [];
  const post: CardPost = async (m) => void sent.push(m);
  const deps: DigestDeps = {
    call: brain.call,
    post,
    recipient: () => MANAGER,
    budget: () => ({ limitUsd: 1, timeZone: "UTC" }),
    skills: () => [],
    app: async () => ({ teamId: "T0TEAM" }),
    ...over,
  };
  return { deps, sent, brain };
}

const lessonsPage = (lines: string[]) => `---\ntype: lessons\n---\n${lines.join("\n")}\n`;

describe("runDigest", () => {
  test("posts only to the manager, never a person's proposal, and records an ok run", async () => {
    await Proposals.insert({ agentId: AGENT, kind: "team-fact", toKind: "manager", toUser: null, scope: "agent", payload: { summary: "MANAGER-FACT", pages: [{ slug: "team/x", content: "x" }] }, createdAt: MONDAY.getTime() - DAY });
    await Proposals.insert({ agentId: AGENT, kind: "promote", toKind: "person", toUser: PERSON, scope: `user:${PERSON}`, payload: { summary: "PRIVATE-PROMOTE" }, createdAt: MONDAY.getTime() - DAY });
    const id = await Runs.start({ agentId: AGENT, pass: "nightly-review", scope: "agent", day: "2026-10-21", startedAt: Date.parse("2026-10-21T02:30:00Z") });
    await Runs.finish(id, { tokens: ZERO, costUsd: 0.2, outcome: "ok" });
    const { deps, sent } = digestDeps();
    const res = await runDigest({ ...group, slot: "2026-W44", now: MONDAY }, deps);
    expect(res).toEqual({ outcome: "ok", sentTo: [MANAGER] });
    expect(sent.map((m) => m.channel)).toEqual([MANAGER]);
    const all = allText(sent[0]!.blocks);
    expect(all).toContain("MANAGER-FACT");
    expect(all).toContain("2026-10-21: $0.2000 of $1.0000");
    expect(all).not.toContain("PRIVATE-PROMOTE");
    expect(all).not.toContain(PERSON);
    const rows = await Runs.listBetween(AGENT, "2026-10-26", "2026-10-26");
    expect(rows.map((r) => [r.pass, r.outcome, r.costUsd])).toEqual([["digest", "ok", 0]]);
  });

  test("the digest goes to the manager; to the backup only when no manager is set", () => {
    expect(digestRecipientOf({ manager: { userId: MANAGER }, backupManager: { userId: BACKUP } })).toBe(MANAGER);
    expect(digestRecipientOf({ manager: {}, backupManager: { userId: BACKUP } })).toBe(BACKUP);
    expect(digestRecipientOf({ manager: {}, backupManager: {} })).toBeNull();
  });

  test("posts as the group persona's own app, never another persona's in the group, and binds the cards to it", async () => {
    const mk = async (persona: string, app: string, ts: string, at: number) => {
      const s = await Sessions.createForThread({ thread: { team_id: "T0TEAM", channel_id: "C0ONE", thread_ts: ts, persona_id: persona }, model: "m", working_dir: "/tmp" });
      await Sessions.setSlackApp(s.id, app);
      await db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [at, s.id]);
      return s.id;
    };
    const ids = [await mk("default", "A0DEFAULT", "1.1", MONDAY.getTime() - 5 * DAY), await mk("helper", "A0HELPER", "1.2", MONDAY.getTime() - DAY)];
    try {
      expect(await personaApp("default")).toEqual({ apiAppId: "A0DEFAULT", teamId: "T0TEAM" });
      const pid = await Proposals.insert({ agentId: AGENT, kind: "team-fact", toKind: "manager", toUser: null, scope: "agent", payload: { pages: [{ slug: "team/x", content: "x" }] }, createdAt: MONDAY.getTime() - DAY });
      const posts: Array<{ app?: unknown }> = [];
      const { deps } = digestDeps({ post: async (m) => void posts.push(m) });
      delete (deps as { app?: unknown }).app;
      await runDigest({ ...group, personaIds: ["default", "helper"], slot: "2026-W44", now: MONDAY }, deps);
      expect(posts.map((m) => m.app)).toEqual([{ apiAppId: "A0DEFAULT", teamId: "T0TEAM" }]);
      const row = (await Proposals.get(pid))!;
      expect([row.slackAppId, row.slackTeamId]).toEqual(["A0DEFAULT", "T0TEAM"]);
    } finally {
      for (const id of ids) await db.run("DELETE FROM sessions WHERE id = ?", [id]);
    }
  });

  test("with no manager configured nothing is sent; the run is ok and logged", async () => {
    const { deps, sent } = digestDeps({ recipient: () => null });
    expect(await runDigest({ ...group, slot: "2026-W44", now: MONDAY }, deps)).toEqual({ outcome: "ok", sentTo: [] });
    expect(sent).toEqual([]);
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain("no manager configured");
    expect((await Runs.listBetween(AGENT, "2026-10-26", "2026-10-26")).map((r) => r.outcome)).toEqual(["ok"]);
  });

  test("every post failing records an error run", async () => {
    const { deps } = digestDeps({ post: async () => { throw new Error("channel_not_found"); } });
    expect((await runDigest({ ...group, slot: "2026-W44", now: MONDAY }, deps)).outcome).toBe("error");
  });

  test("lesson changes are diffed against the previous digest's snapshot, stored with its slot", async () => {
    const { deps, sent, brain } = digestDeps();
    const src = agentSourceId(AGENT);
    brain.seed(src, LESSONS_SLUG, lessonsPage(["- a", "- b"]));
    await db.run("INSERT INTO background_slots (agent_id, pass, slot, claimed_at) VALUES (?, 'digest', '2026-W44', ?)", [AGENT, MONDAY.getTime()]);
    await runDigest({ ...group, slot: "2026-W44", now: MONDAY }, deps);
    expect(allText(sent[0]!.blocks)).toContain("first digest");
    const state = await db.one<{ state: string }>("SELECT state FROM background_slots WHERE agent_id = ? AND pass = 'digest' AND slot = '2026-W44'", [AGENT]);
    expect(JSON.parse(state!.state)).toEqual({ lessons: ["- a", "- b"] });

    brain.seed(src, LESSONS_SLUG, lessonsPage(["- b", "- c"]));
    const next = new Date(MONDAY.getTime() + 7 * DAY);
    await db.run("INSERT INTO background_slots (agent_id, pass, slot, claimed_at) VALUES (?, 'digest', '2026-W45', ?)", [AGENT, next.getTime()]);
    await runDigest({ ...group, slot: "2026-W45", now: next }, deps);
    const all = allText(sent[1]!.blocks);
    expect(all).toContain("+ - c");
    expect(all).toContain("− - a");
    expect(all).not.toContain("+ - b");
  });

  test("a skill retired in the week is listed with Restore", async () => {
    const at = Date.parse("2026-10-25T04:10:00Z");
    const rid = await Proposals.recordSkillRetired({ agentId: AGENT, payload: { slug: "old-helper", retiredId: "old-helper-20261025T041000Z", persona: "default", reason: "unused", uses: 0, lastUsedAt: null }, at });
    await Proposals.recordSkillRetired({ agentId: AGENT, payload: { slug: "older", retiredId: "older-20261011T041000Z", persona: "default", reason: "unused", uses: 0, lastUsedAt: null }, at: at - 14 * DAY });
    const { deps, sent } = digestDeps();
    await runDigest({ ...group, slot: "2026-W44", now: MONDAY }, deps);
    expect(actionIds(sent[0]!.blocks)).toEqual([restoreActionId(rid)]);
    expect(allText(sent[0]!.blocks)).toContain("Retired `old-helper` on 2026-10-25");
  });

  test("skills written in the week are listed", async () => {
    skillOps.write("triage", "triage", "d", "b", undefined, new Date("2026-10-23T10:00:00Z"));
    skillOps.write("ancient", "ancient", "d", "b", undefined, new Date("2026-09-01T10:00:00Z"));
    const { deps, sent } = digestDeps({ skills: undefined });
    await runDigest({ ...group, slot: "2026-W44", now: MONDAY }, deps);
    const all = allText(sent[0]!.blocks);
    expect(all).toContain("`triage` (2026-10-23)");
    expect(all).not.toContain("ancient");
  });
});

describe("the digest slot in the scheduler", () => {
  test("runs once a week (claimSlot), Monday 09:00 persona-local, across ticks and schedulers", async () => {
    const ran: string[] = [];
    let at = new Date("2026-10-26T08:59:00Z");
    const mk = () =>
      createBackgroundScheduler({
        now: () => at,
        brainReady: () => true,
        agents: async () => [group],
        handlers: { digest: async (r) => void ran.push(r.slot) },
        sweep: async () => {},
      });
    const a = mk();
    const b = mk();
    await a.tick();
    expect(ran).toEqual([]);
    at = new Date("2026-10-26T09:00:00Z");
    await a.tick();
    await b.tick();
    at = new Date("2026-10-29T12:00:00Z");
    await a.tick();
    await mk().tick(); // a restarted scheduler
    expect(ran).toEqual(["2026-W44"]);
    at = new Date("2026-11-02T09:01:00Z");
    await a.tick();
    expect(ran).toEqual(["2026-W44", "2026-W45"]);
  });

  test("every tick expires open proposals past 14 days, even with the brain closed", async () => {
    const created = Date.parse("2026-10-01T00:00:00Z");
    const id = await Proposals.insert({ agentId: AGENT, kind: "team-fact", toKind: "manager", toUser: null, scope: "agent", payload: {}, createdAt: created });
    let at = new Date(created + 14 * DAY - 1);
    const s = createBackgroundScheduler({ now: () => at, brainReady: () => false, agents: async () => [], handlers: {}, sweep: async () => {} });
    await s.tick();
    expect((await Proposals.get(id))!.status).toBe("open");
    at = new Date(created + 14 * DAY);
    await s.tick();
    expect((await Proposals.get(id))!.status).toBe("expired");
    expect(await Proposals.decide(id, "approved", MANAGER, at.getTime())).toBe(false);
  });

  test("an expiry failure is logged and the tick goes on", async () => {
    const ran: string[] = [];
    const s = createBackgroundScheduler({
      now: () => MONDAY,
      brainReady: () => true,
      agents: async () => [group],
      handlers: { digest: async (r) => void ran.push(r.slot) },
      sweep: async () => {},
      expire: async () => {
        throw new Error("db down");
      },
    });
    await s.tick();
    expect(ran).toEqual(["2026-W44"]);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain("proposal expiry failed");
  });
});

