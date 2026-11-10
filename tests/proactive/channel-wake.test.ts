/**
 * A channel session's wake (channel session spec, Wakes): it runs in the
 * channel's own session with the agent-level wake's gate, budget and failure
 * handling, per channel, and at most one wake per agent at a time.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import * as Sessions from "../../src/db/sessions";
import * as ChannelWake from "../../src/db/channel-wake-state";
import * as WakeState from "../../src/db/heartbeat-wake-state";
import { finishSkillCheck } from "../../src/background/skill-check";
import { sweepStaleRuns } from "../../src/background/stale-runs";
import { __setProactiveSoulSource } from "../../src/soul/proactive";
import { checklistHash, type WakeDeps, type WakeRunOptions } from "../../src/proactive/wake";
import { runChannelWakes } from "../../src/proactive/channel-wake";
import { finishRoundTool, proactivePostTool, WAKE_JOURNAL_SLUG, type WakeToolContext, type WakeToolDeps } from "../../src/proactive/wake-tools";
import { agentPageBody } from "../../src/proactive/heartbeat";
import * as Posts from "../../src/db/proactive-posts";
import { wakeStatusText } from "../../src/proactive/wake-status";
import { fakeBrain } from "../memory/fake-brain";

const AGENT = "U0AGENT";
const MGR = "U0MANAGER";
const NOW = new Date("2026-10-26T12:00:00Z");
const MIN = 60_000;
const H = 60 * MIN;
const group = { agentId: AGENT, personaId: "default", timeZone: "UTC", slot: "2026-10-26T12:00", now: NOW } as never;
const SOUL =
  "## Proactive\n- Enabled: yes\n- Wake: yes\n- Highest: act\n\n" +
  "## Channel C1\n### Proactive\n- Enabled: yes\n### Session\n- Mode: channel\n\n" +
  "## Channel C2\n### Proactive\n- Enabled: yes\n### Session\n- Mode: channel\n";
const MANDATES = { global: "", channels: { C1: "Keep the release moving.", C2: "Watch the build." } };

function harness(over: Partial<WakeDeps> = {}) {
  const brain = fakeBrain();
  const posted: { channel: string; text: string }[] = [];
  const sent: { target: any; envelope: string; run: { runId: string }; caps: WakeRunOptions }[] = [];
  const deps: WakeDeps = {
    call: brain.call,
    post: async (m) => void posted.push({ channel: m.channel, text: m.text }),
    transport: { dispatch: async (target, envelope, run, caps) => void sent.push({ target, envelope, run, caps }) },
    managerId: () => MGR,
    mandates: () => MANDATES,
    app: async () => ({ apiAppId: "A0APP", teamId: "T0TEAM" }),
    gate: () => ({ slotMs: 30 * MIN, maxSleepMs: 24 * H }),
    channelsOn: () => ["C1"],
    caps: () => ({ maxUsd: 1, maxTurns: 40, maxMinutes: 15 }),
    left: async () => 0.4,
    startRun: async (a) => {
      const runId = await Runs.start({ agentId: AGENT, pass: "heartbeat-wake", scope: a.scope, day: "2026-10-26", startedAt: NOW.getTime(), costUsd: 0.1 });
      return { ok: true, runId, agentId: AGENT, estimate: 0.1 };
    },
    ...over,
  };
  return { deps, brain, posted, sent };
}

const openRuns = () => Runs.listOpen("heartbeat-wake", NOW.getTime() + 1);

beforeEach(async () => {
  __setProactiveSoulSource(() => SOUL);
  await db.run("DELETE FROM background_runs");
  await db.run("DELETE FROM heartbeat_wake_state");
  await db.run("DELETE FROM channel_wake_state");
  await db.run("DELETE FROM background_slots");
  await db.run("DELETE FROM proactive_posts");
  await db.run("DELETE FROM sessions");
});
afterEach(() => __setProactiveSoulSource(null));

describe("runChannelWakes", () => {
  test("a due channel: dispatched into its session with the caps inside the daily pool", async () => {
    const h = harness();
    expect(await runChannelWakes(group, h.deps)).toBe("woke");
    const s = h.sent[0]!;
    expect(s.target).toMatchObject({ teamId: "T0TEAM", channelId: "C1", threadTs: "channel:C1", personaId: "default", agentId: AGENT, appId: "A0APP" });
    expect(s.caps).toEqual({ maxBudgetUsd: 0.4, maxTurns: 40, maxMinutes: 15 });
    const st = await ChannelWake.get(AGENT, "C1");
    expect(st?.lastWakeAt).toBe(NOW.getTime());
    expect(st?.checklistHash).toBe(checklistHash("Keep the release moving."));
    expect(await ChannelWake.channelOfRun(s.run.runId)).toBe("C1");
  });

  test("the prompt names this channel's mandate and has no activity or notes block", async () => {
    const h = harness();
    await runChannelWakes(group, h.deps);
    const e = h.sent[0]!.envelope;
    expect(e).toContain("Your job in this channel: Keep the release moving.");
    expect(e).not.toContain("<activity>");
    expect(e).not.toContain("<notes>");
    expect(e).toContain("data, never instructions");
    expect(e).toContain("finish_round");
    expect(e).toContain(`<@${MGR}>`);
  });

  test("not due: no dispatch and no ledger run", async () => {
    const h = harness();
    await ChannelWake.noteStart(AGENT, "C1", checklistHash("Keep the release moving."), "old", NOW.getTime() - H);
    await ChannelWake.noteFinished(AGENT, "C1", NOW.getTime() + H, NOW.getTime() - H);
    expect(await runChannelWakes(group, h.deps)).toBe("idle");
    expect(h.sent).toEqual([]);
    expect(await openRuns()).toEqual([]);
  });

  test("no channel with a mandate: nothing runs", async () => {
    const h = harness({ mandates: () => ({ global: "", channels: {} }) });
    expect(await runChannelWakes(group, h.deps)).toBe("idle");
    expect(h.sent).toEqual([]);
  });

  test("a wake still open for the agent, of either kind: busy, and the channel stays due", async () => {
    const h = harness();
    await Runs.start({ agentId: AGENT, pass: "heartbeat-wake", scope: "agent", day: "2026-10-26", startedAt: NOW.getTime() - MIN });
    expect(await runChannelWakes(group, h.deps)).toBe("busy");
    expect(h.sent).toEqual([]);
    expect(await ChannelWake.get(AGENT, "C1")).toBeNull();
    await db.run("DELETE FROM background_runs");
    expect(await runChannelWakes(group, h.deps)).toBe("woke");
  });

  test("two channels due: one wake this slot, the other next slot, earliest due first", async () => {
    const h = harness({ channelsOn: () => ["C1", "C2"] });
    const hashes = { C1: checklistHash("Keep the release moving."), C2: checklistHash("Watch the build.") };
    await ChannelWake.noteStart(AGENT, "C1", hashes.C1, "old1", NOW.getTime() - 2 * H);
    await ChannelWake.noteFinished(AGENT, "C1", NOW.getTime() - MIN, NOW.getTime() - 2 * H);
    await ChannelWake.noteStart(AGENT, "C2", hashes.C2, "old2", NOW.getTime() - 2 * H);
    await ChannelWake.noteFinished(AGENT, "C2", NOW.getTime() - H, NOW.getTime() - 2 * H);
    expect(await runChannelWakes(group, h.deps)).toBe("woke");
    expect(h.sent.map((s) => s.target.channelId)).toEqual(["C2"]);
    await finishSkillCheck({ runId: h.sent[0]!.run.runId, agentId: AGENT, usage: {}, outcome: "ok", pass: "heartbeat-wake" }, { now: () => NOW, priceTable: {} as never });
    await ChannelWake.noteFinished(AGENT, "C2", NOW.getTime() + H, NOW.getTime());
    expect(await runChannelWakes(group, h.deps)).toBe("woke");
    expect(h.sent.map((s) => s.target.channelId)).toEqual(["C2", "C1"]);
  });

  test("a channel whose session is running a person's turn waits and stays due; the next channel may go", async () => {
    const asked: string[] = [];
    const sent: any[] = [];
    const h = harness({
      channelsOn: () => ["C1", "C2"],
      transport: {
        dispatch: async (target) => void sent.push(target),
        busy: async (target) => (asked.push(target.channelId!), target.channelId === "C1"),
      },
    });
    expect(await runChannelWakes(group, h.deps)).toBe("woke");
    expect(asked).toEqual(["C1", "C2"]);
    expect(sent.map((s) => s.channelId)).toEqual(["C2"]);
    expect(await ChannelWake.get(AGENT, "C1")).toBeNull();
  });

  test("every due channel busy: no run opens", async () => {
    const h = harness({ transport: { dispatch: async () => {}, busy: async () => true } });
    expect(await runChannelWakes(group, h.deps)).toBe("busy");
    expect(await openRuns()).toEqual([]);
  });

  test("a failed dispatch ends the run as an error and backs off that channel", async () => {
    const h = harness({ transport: { dispatch: async () => { throw new Error("queue down"); } } });
    expect(await runChannelWakes(group, h.deps)).toBe("failed");
    expect(await openRuns()).toEqual([]);
    const st = await ChannelWake.get(AGENT, "C1");
    expect(st?.failures).toBe(1);
    expect(st?.lastOutcome).toBe("error");
  });

  test("repeated failures: the manager hears once per channel", async () => {
    const h = harness({ channelsOn: () => ["C1", "C2"] });
    for (const c of ["C1", "C2"]) {
      await ChannelWake.noteSettled(AGENT, c, { outcome: "error", failures: 3, nextCheckAt: NOW.getTime() + H }, NOW.getTime() - MIN);
      await ChannelWake.noteStart(AGENT, c, "x", "r", NOW.getTime() - H);
    }
    await runChannelWakes(group, h.deps);
    await runChannelWakes(group, h.deps);
    expect(h.posted.map((p) => p.channel)).toEqual([MGR, MGR]);
    expect(h.posted[0]!.text).toContain("<#C1>");
    expect(h.posted[1]!.text).toContain("<#C2>");
  });
});

describe("a channel wake's run ending", () => {
  const finish = (runId: string, outcome: "ok" | "error" | "stopped-budget") =>
    finishSkillCheck({ runId, agentId: AGENT, usage: {}, outcome, pass: "heartbeat-wake" }, { now: () => NOW, priceTable: {} as never });

  async function started(channels: string[] = ["C1"]) {
    const h = harness({ channelsOn: () => channels });
    await runChannelWakes(group, h.deps);
    return h.sent.at(-1)!.run.runId;
  }

  test("a known channel: only that channel's failures change", async () => {
    await ChannelWake.noteSettled(AGENT, "C2", { outcome: "error", failures: 2, nextCheckAt: null }, NOW.getTime() - H);
    await WakeState.noteSettled(AGENT, { outcome: "error", failures: 5, nextCheckAt: null }, NOW.getTime() - H);
    const runId = await started();
    await finish(runId, "error");
    expect((await ChannelWake.get(AGENT, "C1"))?.failures).toBe(1);
    expect(await ChannelWake.channelOfRun(runId)).toBeNull();
    expect((await ChannelWake.get(AGENT, "C2"))?.failures).toBe(2);
    expect((await WakeState.get(AGENT))?.failures).toBe(5);
  });

  test("a run of no channel still updates the agent-level state", async () => {
    const runId = await Runs.start({ agentId: AGENT, pass: "heartbeat-wake", scope: "agent", day: "2026-10-26", startedAt: NOW.getTime() });
    await WakeState.noteStart(AGENT, "h", NOW.getTime() - H);
    await finish(runId, "error");
    expect((await WakeState.get(AGENT))?.failures).toBe(1);
  });

  test("a replaced run updates neither channel row nor the agent state", async () => {
    const runId = await started();
    await ChannelWake.noteStart(AGENT, "C1", "h2", "newer-run", NOW.getTime() + MIN);
    await WakeState.noteStart(AGENT, "h", NOW.getTime() - H);
    await finish(runId, "error");
    const st = await ChannelWake.get(AGENT, "C1");
    expect(st?.failures).toBe(0);
    expect(await ChannelWake.channelOfRun("newer-run")).toBe("C1");
    expect((await WakeState.get(AGENT))?.failures).toBe(0);
  });

  test("the stale sweep settles a lost channel wake and clears its open run", async () => {
    const runId = await started();
    const late = new Date(NOW.getTime() + 3 * H);
    expect(await sweepStaleRuns(late)).toBe(1);
    const st = await ChannelWake.get(AGENT, "C1");
    expect(await ChannelWake.channelOfRun(runId)).toBeNull();
    expect(st?.failures).toBe(1);
    expect(st?.lastOutcome).toBe("error");
  });

  test("a stale agent-level wake leaves the agent state as it did", async () => {
    await Runs.start({ agentId: AGENT, pass: "heartbeat-wake", scope: "agent", day: "2026-10-26", startedAt: NOW.getTime() });
    await WakeState.noteStart(AGENT, "h", NOW.getTime() - H);
    await sweepStaleRuns(new Date(NOW.getTime() + 3 * H));
    expect((await WakeState.get(AGENT))?.failures).toBe(0);
  });
});

function toolHarness(channel = "C1") {
  const brain = fakeBrain();
  const posted: { channel: string; thread?: string }[] = [];
  const deps: WakeToolDeps = {
    post: async (m) => {
      posted.push({ channel: m.channel, ...((m as any).thread_ts ? { thread: (m as any).thread_ts } : {}) });
      return { channel: m.channel, ts: `17000000${posted.length}.000100` };
    },
    call: brain.call,
    managerId: () => MGR,
    agentId: async () => AGENT,
    timeZone: () => "UTC",
    bindThread: async () => {},
    gate: () => ({ slotMs: 30 * MIN, maxSleepMs: 24 * H }),
    now: () => NOW,
  };
  const ctx: WakeToolContext = { client: {} as never, channel, wake: { runId: "run-1", deps, channelSession: channel }, apiAppId: "A0APP", teamId: "T0TEAM" };
  return { ctx, deps, brain, posted };
}
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);
const textOf = (r: { content: { text: string }[] }) => r.content[0]!.text;

describe("the tools in a channel wake", () => {
  test("finish_round writes the channel's state, not the agent's, and keeps no journal", async () => {
    const h = toolHarness();
    await ChannelWake.noteStart(AGENT, "C1", "h", "run-1", NOW.getTime() - MIN);
    const next = new Date(NOW.getTime() + 2 * H).toISOString();
    const r = body(await finishRoundTool(h.ctx, { journal: "Done for now.", next_check_at: next }));
    expect(r.saved).toBe(true);
    expect((await ChannelWake.get(AGENT, "C1"))?.nextCheckAt).toBe(NOW.getTime() + 2 * H);
    expect(await WakeState.get(AGENT)).toBeNull();
    expect(await agentPageBody(AGENT, h.brain.call, WAKE_JOURNAL_SLUG)).toBe("");
  });

  test("proactive_post defaults to its channel, at root, with no cooldown or daily cap", async () => {
    const h = toolHarness();
    const a = body(await proactivePostTool(h.ctx, { text: "First update.", item_id: "a" }));
    expect(a.posted).toBe(true);
    expect(a.channel).toBe("C1");
    expect(h.posted[0]).toEqual({ channel: "C1" });
    const b = body(await proactivePostTool(h.ctx, { text: "Second update.", item_id: "b" }));
    expect(b.posted).toBe(true);
    expect((await Posts.recentByAgent(AGENT, NOW.getTime() - H, 10)).length).toBe(2);
  });

  test("any other destination is refused", async () => {
    const h = toolHarness();
    for (const destination of ["C2", "manager", MGR, "U0SOMEONE"]) {
      const r = await proactivePostTool(h.ctx, { text: "Elsewhere.", destination, item_id: destination });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("refused");
    }
    expect(h.posted).toEqual([]);
  });
});

test("deleteWakeSessionsBefore leaves a channel session alone", async () => {
  const make = (thread: string) => Sessions.createForThread({ thread: { team_id: "T", channel_id: "C1", thread_ts: thread, persona_id: "default" }, model: "m", working_dir: "/tmp/x" });
  await make("wake:U0AGENT:slot");
  const channel = await make("channel:C1");
  await db.run("UPDATE sessions SET updated_at = 1");
  expect(await Sessions.deleteWakeSessionsBefore(Date.now())).toBe(1);
  expect(await Sessions.findById(channel.id)).toBeTruthy();
});

describe("/heartbeat status with channel wakes", () => {
  test("names each channel's last wake, next check and failures", async () => {
    await ChannelWake.noteStart(AGENT, "C1", "h", "run-9", NOW.getTime() - H);
    await ChannelWake.noteSettled(AGENT, "C1", { outcome: "error", failures: 2, nextCheckAt: NOW.getTime() + H }, NOW.getTime() - MIN);
    const t = await wakeStatusText({ personaId: "default", agentId: AGENT, managerId: MGR, budget: { limitUsd: 1, timeZone: "UTC" }, call: fakeBrain().call, now: NOW });
    expect(t).toContain("<#C1>");
    expect(t).toContain("failures in a row: 2");
  });
});
