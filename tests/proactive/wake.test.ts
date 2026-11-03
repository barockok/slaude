import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import * as WakeState from "../../src/db/heartbeat-wake-state";
import { finishSkillCheck } from "../../src/background/skill-check";
import { __setProactiveSoulSource } from "../../src/soul/proactive";
import { checklistHash, runWake, type WakeDeps, type WakeRunOptions } from "../../src/proactive/wake";
import { agentScope } from "../../src/proactive/heartbeat";
import { WAKE_JOURNAL_SLUG } from "../../src/proactive/wake-tools";
import { composePage } from "../../src/knowledge/memory-pages";
import { fakeBrain } from "../memory/fake-brain";

const AGENT = "U0AGENT";
const MGR = "U0MANAGER";
const NOW = new Date("2026-10-26T12:00:00Z");
const MIN = 60_000;
const H = 60 * MIN;
const group = { agentId: AGENT, personaId: "default", timeZone: "UTC", slot: "2026-10-26T12:00", now: NOW } as never;
const SOUL = "## Proactive\n- Enabled: yes\n- Wake: yes\n- Highest: act\n\n## Channel C0ONCHANNE\n### Proactive\n- Enabled: yes\n";
const CHECKLIST = "Every morning: post the brief.";
const MANDATE = "Do without asking: research and draft. Ask first: publish.";
const JOB_HASH = checklistHash(`${CHECKLIST}\nKeep things moving.\n${MANDATE}`);

async function withChecklist(brain: ReturnType<typeof fakeBrain>, text = CHECKLIST) {
  const page = composePage({ slug: "self/heartbeat", content: text, type: "heartbeat" }, NOW);
  if ("error" in page) throw new Error(page.error);
  await brain.call("put_page", { slug: "self/heartbeat", content: page.content }, agentScope(AGENT));
}

function harness(over: Partial<WakeDeps> = {}) {
  const brain = fakeBrain();
  const posted: { channel: string; text: string }[] = [];
  const sent: { target: any; envelope: string; run: { runId: string }; caps: WakeRunOptions }[] = [];
  const deps: WakeDeps = {
    call: brain.call,
    post: async (m) => void posted.push({ channel: m.channel, text: m.text }),
    transport: { dispatch: async (target, envelope, run, caps) => void sent.push({ target, envelope, run, caps }) },
    managerId: () => MGR,
    mandates: () => ({ global: "Keep things moving.", channels: { C0ONCHANNE: "Do without asking: research and draft. Ask first: publish." } }),
    app: async () => ({ apiAppId: "A0APP", teamId: "T0TEAM" }),
    gate: () => ({ slotMs: 30 * MIN, maxSleepMs: 24 * H }),
    channelsOn: () => ["C0ONCHANNE"],
    caps: () => ({ maxUsd: 1, maxTurns: 40, maxMinutes: 15 }),
    left: async () => 2.5,
    startRun: async () => {
      const runId = await Runs.start({ agentId: AGENT, pass: "heartbeat-wake", scope: "agent", day: "2026-10-26", startedAt: NOW.getTime(), costUsd: 0.1 });
      return { ok: true, runId, agentId: AGENT, estimate: 0.1 };
    },
    ...over,
  };
  return { deps, brain, posted, sent };
}

beforeEach(async () => {
  __setProactiveSoulSource(() => SOUL);
  await db.run("DELETE FROM background_runs");
  await db.run("DELETE FROM heartbeat_wake_state");
  await db.run("DELETE FROM background_slots");
});
afterEach(() => __setProactiveSoulSource(null));

describe("runWake", () => {
  test("a mandate alone is a job: no checklist page is needed", async () => {
    const h = harness();
    expect(await runWake(group, h.deps)).toBe("woke");
    expect(h.sent[0]!.envelope).toContain("your mandate above is your job");
  });

  test("a changed mandate wakes it again, unasked", async () => {
    const h = harness();
    await withChecklist(h.brain);
    await WakeState.noteStart(AGENT, JOB_HASH, NOW.getTime() - H);
    await WakeState.noteFinished(AGENT, NOW.getTime() + H, NOW.getTime() - H);
    expect(await runWake(group, h.deps)).toBe("idle");
    const changed = { ...h.deps, mandates: () => ({ global: "", channels: { C0ONCHANNE: "A new goal." } }) };
    expect(await runWake(group, changed)).toBe("woke");
  });

  test("the activity block is read before the model and handed over", async () => {
    const h = harness({
      activity: () => ({
        history: async () => [{ ts: String(NOW.getTime() / 1000 - 60), user: MGR, text: "Approved, go." }],
        replies: async () => [],
      }),
    });
    await runWake(group, h.deps);
    expect(h.sent[0]!.envelope).toContain("Approved, go.");
  });

  test("a failed Slack read is said, not read as silence", async () => {
    const h = harness({
      activity: () => ({
        history: async () => {
          throw Object.assign(new Error("x"), { data: { error: "missing_scope" } });
        },
        replies: async () => [],
      }),
    });
    await runWake(group, h.deps);
    expect(h.sent[0]!.envelope).toContain("could not be read (missing_scope)");
  });

  test("no mandate and no checklist: nothing runs", async () => {
    const h = harness({ mandates: () => ({ global: "", channels: {} }) });
    expect(await runWake(group, h.deps)).toBe("no-checklist");
    expect(h.sent).toEqual([]);
    expect(await Runs.spentOn(AGENT, "2026-10-26")).toBe(0);
  });

  test("a first wake is a fresh session of its own, with the checklist, notes and mandates", async () => {
    const h = harness();
    await withChecklist(h.brain);
    const page = composePage({ slug: WAKE_JOURNAL_SLUG, content: "Open: batch 2.", type: "heartbeat-journal" }, NOW);
    if ("error" in page) throw new Error(page.error);
    await h.brain.call("put_page", { slug: WAKE_JOURNAL_SLUG, content: page.content }, agentScope(AGENT));
    expect(await runWake(group, h.deps)).toBe("woke");
    const s = h.sent[0]!;
    expect(s.target).toEqual({ teamId: "T0TEAM", managerId: MGR, threadTs: `wake:${AGENT}:2026-10-26T12:00`, personaId: "default", agentId: AGENT, appId: "A0APP" });
    expect(s.envelope.startsWith('<runtime-check kind="wake">')).toBe(true);
    expect(s.envelope).toContain(CHECKLIST);
    expect(s.envelope).toContain("Open: batch 2.");
    expect(s.envelope).toContain("<#C0ONCHANNE>: Do without asking: research and draft. Ask first: publish.");
    const st = await WakeState.get(AGENT);
    expect(st?.lastWakeAt).toBe(NOW.getTime());
    expect(st?.checklistHash).toBe(JOB_HASH);
  });

  test("the slot after: idle, with no model call", async () => {
    const h = harness();
    await withChecklist(h.brain);
    await WakeState.noteStart(AGENT, JOB_HASH, NOW.getTime() - H);
    await WakeState.noteFinished(AGENT, NOW.getTime() + H, NOW.getTime() - H);
    expect(await runWake(group, h.deps)).toBe("idle");
    expect(h.sent).toEqual([]);
  });

  test("the caps: the smaller of the cap and what is left", async () => {
    const h = harness({ left: async () => 0.4 });
    await withChecklist(h.brain);
    await runWake(group, h.deps);
    expect(h.sent[0]!.caps).toEqual({ maxBudgetUsd: 0.4, maxTurns: 40, maxMinutes: 15 });
  });

  test("each cap can be off; the pool still bounds the USD", async () => {
    const h = harness({ caps: () => ({ maxUsd: 0, maxTurns: 0, maxMinutes: 0 }) });
    await withChecklist(h.brain);
    await runWake(group, h.deps);
    expect(h.sent[0]!.caps).toEqual({ maxBudgetUsd: 2.5 });
  });

  test("one wake at a time", async () => {
    const h = harness();
    await withChecklist(h.brain);
    await Runs.start({ agentId: AGENT, pass: "heartbeat-wake", scope: "agent", day: "2026-10-26", startedAt: NOW.getTime() - MIN });
    expect(await runWake(group, h.deps)).toBe("busy");
    expect(h.sent).toEqual([]);
  });

  test("another agent's open wake does not block this one", async () => {
    const h = harness();
    await withChecklist(h.brain);
    await Runs.start({ agentId: "U0OTHER", pass: "heartbeat-wake", scope: "agent", day: "2026-10-26", startedAt: NOW.getTime() - MIN });
    expect(await runWake(group, h.deps)).toBe("woke");
  });

  test("out of budget: no turn, and the manager hears once a day", async () => {
    const h = harness({ startRun: async () => ({ ok: false, reason: "budget" }) });
    await withChecklist(h.brain);
    expect(await runWake(group, h.deps)).toBe("no-budget");
    expect(await runWake(group, h.deps)).toBe("no-budget");
    expect(h.sent).toEqual([]);
    expect(h.posted.map((p) => p.channel)).toEqual([MGR]);
    expect(h.posted[0]!.text).toContain("budget");
  });

  test("a failed dispatch ends the run as an error and backs off", async () => {
    const h = harness({ transport: { dispatch: async () => { throw new Error("queue down"); } } });
    await withChecklist(h.brain);
    expect(await runWake(group, h.deps)).toBe("failed");
    expect((await Runs.listOpen("heartbeat-wake", NOW.getTime() + 1)).length).toBe(0);
    const st = await WakeState.get(AGENT);
    expect(st?.failures).toBe(1);
    expect(st?.lastOutcome).toBe("error");
    expect(st?.nextCheckAt).toBeGreaterThan(Date.now() - 1000);
  });

  test("three failures in a row: the manager hears once", async () => {
    const h = harness();
    await withChecklist(h.brain);
    await WakeState.noteStart(AGENT, JOB_HASH, NOW.getTime() - H);
    await WakeState.noteSettled(AGENT, { outcome: "error", failures: 3, nextCheckAt: NOW.getTime() + H }, NOW.getTime() - MIN);
    await runWake(group, h.deps);
    await runWake(group, h.deps);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.text).toContain("failed");
  });
});

describe("a wake's run ending", () => {
  const finish = (runId: string, outcome: "ok" | "error" | "stopped-budget", usage = {}) =>
    finishSkillCheck({ runId, agentId: AGENT, usage, outcome, pass: "heartbeat-wake", stats: { turns: 3 } }, { now: () => NOW, priceTable: {} as never });

  async function started() {
    const h = harness();
    await withChecklist(h.brain);
    await runWake(group, h.deps);
    return h.sent[0]!.run.runId;
  }

  test("ok after finish_round: failures clear, its time stays", async () => {
    const runId = await started();
    await WakeState.noteFinished(AGENT, NOW.getTime() + 5 * H, NOW.getTime() + 1);
    await WakeState.noteSettled(AGENT, { outcome: "error", failures: 2, nextCheckAt: null }, NOW.getTime());
    await finish(runId, "ok");
    const st = await WakeState.get(AGENT);
    expect(st?.failures).toBe(0);
    expect(st?.nextCheckAt).toBe(NOW.getTime() + 5 * H);
    expect(st?.lastOutcome).toBe("ok");
  });

  test("ok without finish_round: a failure, two slots on", async () => {
    const runId = await started();
    await finish(runId, "ok");
    const st = await WakeState.get(AGENT);
    expect(st?.failures).toBe(1);
    expect(st?.nextCheckAt).toBe(NOW.getTime() + H);
  });

  test("a wall clock with no usage is never free: it counts at the cap", async () => {
    const runId = await started();
    const r = await finish(runId, "stopped-budget");
    expect(r).toEqual({ ok: true, costUsd: 1 });
    expect((await WakeState.get(AGENT))?.lastOutcome).toBe("stopped-budget");
  });
});
