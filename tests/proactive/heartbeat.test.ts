/**
 * The heartbeat (phase E, spec §10.3, §10.4): it runs only while the SOUL
 * enables proactiveness, only with a checklist, as an agent-scope pass, and
 * speaks only through `proactive_post`, which the restraint rules gate in code.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Posts from "../../src/db/proactive-posts";
import { composePage } from "../../src/knowledge/memory-pages";
import { agentSourceId, profileSourceId, type BrainScope } from "../../src/knowledge/scope";
import { HEARTBEAT_MAX_POSTS, HEARTBEAT_SLUG, heartbeatChecklist, proactivePost, proactivePostTool, runHeartbeat, type ProactivePostContext } from "../../src/proactive/heartbeat";
import { createBackgroundScheduler, heartbeatSlot, type AgentGroup, type SlotRun } from "../../src/background/scheduler";
import { parseProactive, type ResolvedProactive } from "../../src/soul/proactive";
import type { PassSpec, RunnerDeps } from "../../src/background/runner";
import { fakeBrain } from "../memory/fake-brain";

const AGENT = "U0AGENT";
const MGR = "U0MANAGER";
const NOW = new Date("2026-10-26T12:00:00Z");
const scopeOf = (source: string): BrainScope => ({ clientId: "t", sourceId: source, allowedSources: [source] });

function configFrom(soul: string): (ch?: string) => ResolvedProactive {
  const c = parseProactive(soul);
  return (ch) => {
    const { channels, ...g } = c;
    return ch !== undefined && channels[ch] !== undefined ? { ...g, enabled: channels[ch]! } : g;
  };
}
const ON = configFrom("## Proactive\n- Enabled: yes\n- Max per person per day: 9\n- Cooldown: 0 hours\n");

function ctx(over: Partial<ProactivePostContext> = {}) {
  const brain = fakeBrain();
  const posted: { channel: string; text: string }[] = [];
  const c: ProactivePostContext = {
    agentId: AGENT,
    personaId: "default",
    app: { apiAppId: "A0APP", teamId: "T0TEAM" },
    managerId: MGR,
    post: async (m) => {
      posted.push({ channel: m.channel, text: m.text });
      return { channel: m.channel.startsWith("U") ? "D0DM" : m.channel, ts: `17000000${posted.length}.000100` };
    },
    call: brain.call,
    now: () => NOW,
    timeZone: "UTC",
    config: ON,
    ...over,
  };
  return { c, brain, posted };
}
const args = (over: Record<string, unknown> = {}) => ({ audience: "manager" as const, topic: "deploys", text: "Deploy 42 has been stuck in review for two days.", evidence: "investigations/deploy-42", ...over });
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

let logSpy: ReturnType<typeof spyOn>;
let debugSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  await db.run("DELETE FROM proactive_posts");
  await db.run("DELETE FROM background_slots");
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  debugSpy = spyOn(console, "debug").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  debugSpy.mockRestore();
  errSpy.mockRestore();
});

describe("proactive_post", () => {
  test("a manager post when enabled lands in their DM and in the ledger", async () => {
    const h = ctx();
    const r = await proactivePost(args(), h.c, { posts: 0 });
    expect(r.isError).toBeFalsy();
    expect(h.posted).toEqual([{ channel: MGR, text: "Deploy 42 has been stuck in review for two days." }]);
    const rows = await Posts.recentFor(AGENT, MGR, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ audience: "manager", topic: "deploys", channelId: "D0DM", messageTs: "170000001.000100", teamId: "T0TEAM" });
  });

  test("a refusal names the rule and posts nothing", async () => {
    const h = ctx({ config: configFrom("## Proactive\n- Enabled: no\n") });
    const r = await proactivePost(args(), h.c, { posts: 0 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("refused: disabled");
    expect(h.posted).toEqual([]);
    expect(await Posts.recentFor(AGENT, MGR, 0)).toEqual([]);
  });

  test("the same text twice: the second is unchanged", async () => {
    const h = ctx();
    const state = { posts: 0 };
    await proactivePost(args(), h.c, state);
    const r = await proactivePost(args(), h.c, state);
    expect(text(r)).toContain("refused: unchanged");
    expect(h.posted).toHaveLength(1);
  });

  test(`at most ${HEARTBEAT_MAX_POSTS} posts per run`, async () => {
    const h = ctx();
    const state = { posts: HEARTBEAT_MAX_POSTS };
    expect(text(await proactivePost(args(), h.c, state))).toContain(`at most ${HEARTBEAT_MAX_POSTS}`);
    expect(h.posted).toEqual([]);
  });

  test("evidence, topic, text and a well-formed recipient are required", async () => {
    const h = ctx();
    expect(text(await proactivePost(args({ evidence: " " }), h.c, { posts: 0 }))).toContain("needs evidence");
    expect(text(await proactivePost(args({ topic: "" }), h.c, { posts: 0 }))).toContain("needs a topic");
    expect(text(await proactivePost(args({ text: "" }), h.c, { posts: 0 }))).toContain("text must be");
    expect(text(await proactivePost(args({ audience: "person", recipient: "alice" }), h.c, { posts: 0 }))).toContain("user id");
    expect(text(await proactivePost(args({ audience: "channel", recipient: "U0ALICE" }), h.c, { posts: 0 }))).toContain("channel id");
    expect(text(await proactivePost(args(), { ...h.c, managerId: null }, { posts: 0 }))).toContain("user id");
    expect(h.posted).toEqual([]);
  });

  test("a DM to a person reads their own profile: opted in to the topic posts, otherwise refused", async () => {
    const h = ctx();
    const page = composePage({ slug: "profile", content: "x", type: "profile", subject: "U0ALICE", fields: { pings: "yes", topics: "deploys" } }, NOW);
    if ("error" in page) throw new Error(page.error);
    await h.brain.call("put_page", { slug: "profile", content: page.content }, scopeOf(profileSourceId("T0TEAM", "U0ALICE")));
    const ok = await proactivePost(args({ audience: "person", recipient: "U0ALICE" }), h.c, { posts: 0 });
    expect(ok.isError).toBeFalsy();
    const no = await proactivePost(args({ audience: "person", recipient: "U0BOB", text: "other" }), h.c, { posts: 0 });
    expect(text(no)).toContain("refused: not-opted-in");
  });

  test("a channel post needs the channel switch", async () => {
    const h = ctx({ config: configFrom("## Proactive\n- Enabled: no\n\n## Channel C0TEAMCHAN\n### Proactive\n- Enabled: yes\n") });
    expect((await proactivePost(args({ audience: "channel", recipient: "C0TEAMCHAN" }), h.c, { posts: 0 })).isError).toBeFalsy();
    expect(text(await proactivePost(args({ audience: "channel", recipient: "C0OTHER", text: "x" }), h.c, { posts: 0 }))).toContain("channel-disabled");
  });

  test("the tool binds its own per-run count", () => {
    const t = proactivePostTool(ctx().c);
    expect(t.name).toBe("proactive_post");
  });
});

describe("runHeartbeat", () => {
  const group: AgentGroup = { agentId: AGENT, personaId: "default", personaIds: ["default"], timeZone: "UTC" };
  const runner = { now: () => NOW } as unknown as RunnerDeps;

  test("no checklist: nothing runs, nothing is recorded", async () => {
    const brain = fakeBrain();
    let ran = 0;
    const r = await runHeartbeat({ ...group, slot: "2026-10-26T12:00", now: NOW }, {
      runner, call: brain.call, post: async () => {}, managerId: () => MGR, app: async () => undefined,
      run: async () => { ran++; return { outcome: "ok", costUsd: 0, runId: "x" }; },
    });
    expect(r).toBeNull();
    expect(ran).toBe(0);
  });

  test("with a checklist: an agent-scope heartbeat pass with proactive_post", async () => {
    const brain = fakeBrain();
    const page = composePage({ slug: HEARTBEAT_SLUG, content: "- Any investigation untouched for 3 days: tell the manager.", type: "heartbeat" }, NOW);
    if ("error" in page) throw new Error(page.error);
    await brain.call("put_page", { slug: HEARTBEAT_SLUG, content: page.content }, scopeOf(agentSourceId(AGENT)));
    expect(await heartbeatChecklist(AGENT, brain.call)).toContain("untouched for 3 days");
    let spec: PassSpec | undefined;
    const r = await runHeartbeat({ ...group, slot: "2026-10-26T12:00", now: NOW }, {
      runner, call: brain.call, post: async () => {}, managerId: () => MGR, app: async () => ({ teamId: "T0TEAM" }),
      run: async (s) => { spec = s; return { outcome: "ok", costUsd: 0.01, runId: "r1" }; },
    });
    expect(r).toEqual({ outcome: "ok" });
    expect(spec).toMatchObject({ pass: "heartbeat", scope: { kind: "agent" }, agentId: AGENT });
    expect(spec!.prompt).toContain("untouched for 3 days");
    expect(spec!.prompt).toContain(`<@${MGR}>`);
    expect(spec!.extraTools!.map((t) => t.name)).toEqual(["proactive_post"]);
  });
});

describe("scheduler", () => {
  const group: AgentGroup = { agentId: AGENT, personaId: "default", personaIds: ["default"], timeZone: "UTC" };

  test("heartbeatSlot rounds down to the interval, persona-local", () => {
    expect(heartbeatSlot(new Date("2026-10-26T12:44:00Z"), "UTC", 30)).toBe("2026-10-26T12:30");
    expect(heartbeatSlot(new Date("2026-10-26T12:44:00Z"), "Asia/Jakarta", 30)).toBe("2026-10-26T19:30");
    expect(heartbeatSlot(new Date("2026-10-26T00:05:00Z"), "UTC", 15)).toBe("2026-10-26T00:00");
  });

  const sched = (on: boolean, ran: string[]) =>
    createBackgroundScheduler({
      now: () => NOW,
      brainReady: () => true,
      agents: async () => [group],
      handlers: { heartbeat: async (r: SlotRun) => void ran.push(r.slot) },
      sweep: async () => 0,
      expire: async () => 0,
      quietDue: async () => [],
      proactiveOn: () => on,
    });

  test("never due while the SOUL keeps proactiveness off", async () => {
    const ran: string[] = [];
    await sched(false, ran).tick();
    expect(ran).toEqual([]);
  });

  test("on: one run per slot, across two schedulers", async () => {
    const ran: string[] = [];
    const a = sched(true, ran);
    await a.tick();
    await a.tick();
    await sched(true, ran).tick();
    expect(ran).toEqual(["2026-10-26T12:00"]);
  });
});
