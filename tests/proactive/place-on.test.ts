/** Checklist, commitments and rules in the place (rc.46, memory places on). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import { claimedAt } from "../../src/db/background-slots";
import { composePage, readPageRecord } from "../../src/knowledge/memory-pages";
import { agentSourceId, AGENT_SOURCE, SHARED_SOURCE, type BrainScope } from "../../src/knowledge/scope";
import { placeSourceId, type PlaceRef } from "../../src/memory/place";
import { __resetPlaceBindingForTests, bindPlace } from "../../src/memory/place-binding";
import { buildTurnMemoryContext } from "../../src/memory/turn-context";
import { runChannelWakes } from "../../src/proactive/channel-wake";
import { placeHome, placeScopeFor, type PlaceHomeDeps } from "../../src/proactive/place-home";
import { agentScope, channelChecklistSlug } from "../../src/proactive/post";
import { composeRulePage, loadRules } from "../../src/proactive/rules";
import { proactiveRule } from "../../src/proactive/rule-tool";
import { backgroundAgentId } from "../../src/background/skill-check";
import { writeSoulFixture, WORLD } from "../../src/gateway/sim/soul-fixture";
import type { SlackContext } from "../../src/gateway/slack/mcp-tools";
import type { WakeDeps } from "../../src/proactive/wake";
import { __setProactiveSoulSource } from "../../src/soul/proactive";
import { fakeBrain } from "../memory/fake-brain";

const AGENT = "U0AGENT";
const NOW = new Date("2026-10-26T12:00:00Z");
const MIN = 60_000;
const H = 60 * MIN;
const group = { agentId: AGENT, personaId: "default", timeZone: "UTC", slot: "2026-10-26T12:00", now: NOW } as never;
const SOUL = "## Channel C1\n### Proactive\n- Enabled: yes\n### Session\n- Mode: channel\n\n## Channel C2\n### Proactive\n- Enabled: yes\n### Session\n- Mode: channel\n";
const ref = (b: string): Extract<PlaceRef, { kind: "place" }> => ({ kind: "place", source: placeSourceId(AGENT, b), boundaryId: b, boundaryKind: "channel" });
const P1 = ref("b1");
const P2 = ref("b2");
const byChannel: Record<string, PlaceRef> = { C1: P1, C2: P2 };
const placeDeps = (on: boolean): PlaceHomeDeps => ({ place: async (i) => byChannel[i.channel ?? ""] ?? { kind: "none", reason: "no-boundary" }, placesOn: () => on });

function harness(on: boolean, channels = ["C1"]) {
  const brain = fakeBrain();
  const sent: { envelope: string; target: { channelId: string } }[] = [];
  const deps: WakeDeps = {
    call: brain.call,
    post: async () => {},
    transport: { dispatch: async (target, envelope) => void sent.push({ envelope, target }) },
    managerId: () => "U0MANAGER",
    mandates: () => ({ global: "", channels: {} }),
    app: async () => ({ apiAppId: "A0APP", teamId: "T0TEAM" }),
    gate: () => ({ slotMs: 30 * MIN, maxSleepMs: 24 * H }),
    channelsOn: () => channels,
    caps: () => ({ maxUsd: 1, maxTurns: 40, maxMinutes: 15 }),
    left: async () => 0.4,
    startRun: async (a) => {
      const runId = await Runs.start({ agentId: AGENT, pass: "heartbeat-wake", scope: a.scope, day: "2026-10-26", startedAt: NOW.getTime(), costUsd: 0.1 });
      return { ok: true, runId, agentId: AGENT, estimate: 0.1 };
    },
    placeHome: placeDeps(on),
  };
  return { deps, brain, sent };
}
const put = async (brain: ReturnType<typeof fakeBrain>, scope: BrainScope, slug: string, body: string) => {
  const page = composePage({ slug, content: body, type: "heartbeat" }, NOW);
  if ("error" in page) throw new Error(page.error);
  await brain.call("put_page", { slug, content: page.content }, scope);
};

beforeEach(async () => {
  __setProactiveSoulSource(() => SOUL);
  __resetPlaceBindingForTests();
  await db.run("DELETE FROM background_runs");
  await db.run("DELETE FROM channel_wake_state");
  await db.run("DELETE FROM background_slots");
  await db.run("DELETE FROM memory_scopes");
});
afterEach(() => __setProactiveSoulSource(null));

describe("the checklist", () => {
  test("on: the first wake copies the legacy page into the place, once; the wake reads the place's page", async () => {
    const h = harness(true);
    await put(h.brain, agentScope(AGENT), channelChecklistSlug("C1"), "- legacy line");
    expect(await runChannelWakes(group, h.deps)).toBe("woke");
    expect(h.brain.contentOf(P1.source, channelChecklistSlug("C1"))).toContain("- legacy line");
    expect(h.sent[0]!.envelope).toContain("- legacy line");
    expect(await claimedAt(AGENT, "heartbeat-place-migration", "C1")).not.toBeNull();
    // The place's page is the truth from now on: a later edit there is read, and nothing is copied again.
    await put(h.brain, placeScopeFor(AGENT, P1.source), channelChecklistSlug("C1"), "- place line");
    await put(h.brain, agentScope(AGENT), channelChecklistSlug("C1"), "- legacy changed later");
    await db.run("DELETE FROM channel_wake_state");
    await db.run("DELETE FROM background_runs");
    h.sent.length = 0;
    expect(await runChannelWakes(group, h.deps)).toBe("woke");
    expect(h.sent[0]!.envelope).toContain("- place line");
    expect(h.sent[0]!.envelope).not.toContain("legacy changed later");
    expect(h.brain.contentOf(P1.source, channelChecklistSlug("C1"))).toContain("- place line");
  });

  test("on: a page already in the place is never overwritten by the copy", async () => {
    const h = harness(true);
    await put(h.brain, agentScope(AGENT), channelChecklistSlug("C1"), "- legacy");
    await put(h.brain, placeScopeFor(AGENT, P1.source), channelChecklistSlug("C1"), "- mine");
    await runChannelWakes(group, h.deps);
    expect(h.brain.contentOf(P1.source, channelChecklistSlug("C1"))).toContain("- mine");
  });

  test("on: another channel's place is never read (a wake in C2 finds nothing from C1)", async () => {
    const h = harness(true, ["C2"]);
    await put(h.brain, placeScopeFor(AGENT, P1.source), channelChecklistSlug("C1"), "- only in C1");
    expect(await runChannelWakes(group, h.deps)).toBe("idle"); // no mandate and no page: nothing to do
    expect(h.sent).toEqual([]);
  });

  test("off, never bound: the persona-wide page, byte for byte as before; nothing is copied", async () => {
    const h = harness(false);
    await put(h.brain, agentScope(AGENT), channelChecklistSlug("C1"), "- legacy line");
    await runChannelWakes(group, h.deps);
    expect(h.sent[0]!.envelope).toContain("- legacy line");
    expect(h.brain.contentOf(P1.source, channelChecklistSlug("C1"))).toBeUndefined();
    expect(await claimedAt(AGENT, "heartbeat-place-migration", "C1")).toBeNull();
  });

  test("off after on (rollback): the place's page is read first, the persona-wide page after", async () => {
    await bindPlace(AGENT, P1);
    const h = harness(false);
    await put(h.brain, agentScope(AGENT), channelChecklistSlug("C1"), "- legacy line");
    await put(h.brain, placeScopeFor(AGENT, P1.source), channelChecklistSlug("C1"), "- written while on");
    await runChannelWakes(group, h.deps);
    expect(h.sent[0]!.envelope).toContain("- written while on");
    const h2 = harness(false);
    await db.run("DELETE FROM channel_wake_state");
    await db.run("DELETE FROM background_runs");
    await put(h2.brain, agentScope(AGENT), channelChecklistSlug("C1"), "- legacy line");
    await runChannelWakes(group, h2.deps);
    expect(h2.sent[0]!.envelope).toContain("- legacy line");
  });
});

describe("rules", () => {
  const rule = (kind: string, scope: string, level: "ask" | "ignore") => {
    const c = composeRulePage({ kind, scope, level, how: null, taughtBy: "U0P", taughtAt: NOW.toISOString(), thread: "C1/1.0", quote: null }, NOW);
    if ("error" in c) throw new Error(c.error);
    return c;
  };
  test("loadRules reads the place beside the persona-wide rules; a place rule of the same slug wins; no place is as before", async () => {
    const brain = fakeBrain();
    const place = placeScopeFor(AGENT, P1.source);
    const g = rule("invoices", "global", "ask");
    const here = rule("newsletters", "C1", "ignore");
    await brain.call("put_page", { slug: g.slug, content: g.content }, agentScope(AGENT));
    await brain.call("put_page", { slug: here.slug, content: here.content }, place);
    await bindPlace(AGENT, P1);
    expect((await loadRules(AGENT, brain.call)).map((r) => r.slug)).toEqual([g.slug]);
    expect((await loadRules(AGENT, brain.call, null)).map((r) => r.slug)).toEqual([g.slug]);
    expect((await loadRules(AGENT, brain.call, place)).map((r) => r.slug).sort()).toEqual([g.slug, here.slug].sort());
    const override = rule("invoices", "global", "ignore");
    await brain.call("put_page", { slug: override.slug, content: override.content }, place);
    expect((await loadRules(AGENT, brain.call, place)).find((r) => r.slug === g.slug)!.level).toBe("ignore");
  });

  describe("proactive_rule", () => {
    const SOUL_R = ["## Proactive", "- Highest: ask", "", "## Channel <#C0TEAM>", "### Proactive", "- Highest: act", ""].join("\n");
    let agent: string;
    const ctx = (over: Partial<SlackContext> = {}): SlackContext => ({
      client: {} as never, channel: "C1", threadTs: "100.0", inboundTs: "100.0", userId: "U0PERSON", teamId: "T0TEAM", origin: "slack",
      turnSenders: () => [{ userId: "U0PERSON", teamId: "T0TEAM", origin: "slack" }], ...over,
    });
    beforeEach(async () => {
      writeSoulFixture(WORLD);
      __setProactiveSoulSource(() => SOUL_R);
      agent = await backgroundAgentId("default");
    });
    const args = (scope: "here" | "global") => ({ kind: "newsletters", scope, level: "ignore" as const, quote: "no newsletters" });

    test("on: a rule for this channel is stored in the place, a global rule stays persona-wide", async () => {
      const brain = fakeBrain();
      const deps = { call: brain.call, now: () => NOW, place: { place: async () => ({ ...P1, source: placeSourceId(agent, "b1") }) as PlaceRef, placesOn: () => true } };
      expect((await proactiveRule(ctx(), args("here"), deps)).isError).toBeUndefined();
      expect((await proactiveRule(ctx({ userId: "U0MGR", turnSenders: () => [{ userId: "U0MGR", teamId: "T0TEAM", origin: "slack" }] }), { ...args("global"), kind: "invoices", level: "ask" as const }, { ...deps })).isError).toBeUndefined();
      const placeSrc = placeSourceId(agent, "b1");
      expect(readPageRecord({ content: brain.contentOf(placeSrc, "rules/proactive/newsletters-c1")! })?.meta.level).toBe("ignore");
      expect(brain.contentOf(agentSourceId(agent), "rules/proactive/newsletters-c1")).toBeUndefined();
      expect(brain.contentOf(agentSourceId(agent), "rules/proactive/invoices-global")).toBeDefined();
    });

    test("off: both are stored persona-wide, as before", async () => {
      const brain = fakeBrain();
      const deps = { call: brain.call, now: () => NOW, place: { place: async () => ({ ...P1, source: placeSourceId(agent, "b1") }) as PlaceRef, placesOn: () => false } };
      await proactiveRule(ctx(), args("here"), deps);
      expect(brain.contentOf(agentSourceId(agent), "rules/proactive/newsletters-c1")).toBeDefined();
    });
  });
});

describe("commitments in the turn block", () => {
  const AGENT_SRC = agentSourceId("U_SLAUDE");
  const place = placeSourceId("U_SLAUDE", "b1");
  const scope: BrainScope = { clientId: "U_SLAUDE", sourceId: place, allowedSources: [place, AGENT_SRC, AGENT_SOURCE, SHARED_SOURCE], placeAgent: "U_SLAUDE" };
  async function seed(brain: ReturnType<typeof fakeBrain>, source: string, slug: string, thread: string) {
    const c = composePage({ slug, content: `promise ${slug}`, type: "commitment", fields: { promiser: "U_SLAUDE", beneficiary: "U0ALICE", thread, status: "open" } }, new Date("2026-10-01T00:00:00Z"));
    if ("error" in c) throw new Error(c.error);
    await brain.call("put_page", { slug, content: c.content }, { clientId: "x", sourceId: source, allowedSources: [source] });
  }
  const run = (brain: ReturnType<typeof fakeBrain>, placesOn: boolean) =>
    buildTurnMemoryContext({ call: brain.call, scope, agentSource: AGENT_SRC, speaker: "U0ALICE", threadKey: "C1:100.1", channelId: "C1", ...(placesOn ? { placesOn: true } : {}) });

  test("the place is scanned; the legacy slice drops a commitment whose thread names another channel", async () => {
    const brain = fakeBrain();
    await seed(brain, place, "commitments/in-place", "C1:100.1");
    await seed(brain, AGENT_SRC, "commitments/legacy-here", "C1:100.2");
    await seed(brain, AGENT_SRC, "commitments/legacy-other", "C2:200.1");
    await seed(brain, AGENT_SRC, "commitments/legacy-nothread", "none");
    const on = (await run(brain, true))!;
    expect(on).toContain("promise commitments/in-place");
    expect(on).toContain("promise commitments/legacy-here");
    expect(on).toContain("promise commitments/legacy-nothread");
    expect(on).not.toContain("legacy-other");
    // not on: the legacy scan is untouched
    expect((await run(brain, false))!).toContain("promise commitments/legacy-other");
  });
});

describe("placeHome", () => {
  test("no place, an unbound place with the mode off, and a place that cannot bind give no scope", async () => {
    const i = { agentId: AGENT, personaId: "default", teamId: "T0TEAM", channel: "C1" };
    expect((await placeHome({ ...i, channel: "C9" }, placeDeps(true))).scope).toBeNull();
    expect((await placeHome(i, placeDeps(false))).scope).toBeNull();
    expect((await placeHome(i, placeDeps(true))).scope?.sourceId).toBe(P1.source);
    expect((await placeHome(i, placeDeps(false))).scope?.sourceId).toBe(P1.source); // bound by the line above: rollback read
    expect((await placeHome({ ...i, channel: null }, placeDeps(true))).scope).toBeNull();
  });
});
