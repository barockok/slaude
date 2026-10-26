/**
 * Promise checks on the background scheduler (phase E): the hook runs first
 * every tick for every agent group, a throwing hook never stops the tick, and
 * the production wiring opens a real `commitment` ledger run scoped to whom
 * the promise belongs to.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import * as Commitments from "../../src/db/commitments";
import { setAgentId, resetAgentId } from "../../src/knowledge/agent-identity";
import { createBackgroundScheduler, defaultSchedulerDeps, promiseChecks, type AgentGroup } from "../../src/background/scheduler";
import type { PromiseTransport } from "../../src/proactive/promises";

const T0 = Date.parse("2026-10-26T10:00:00Z");
const group = (agentId: string): AgentGroup => ({ agentId, personaId: "default", personaIds: ["default"], timeZone: "UTC" });

let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  await db.run("DELETE FROM commitments");
  await db.run("DELETE FROM background_runs");
  await db.run("DELETE FROM background_slots");
  setAgentId("U0AGENT");
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  warnSpy.mockRestore();
  resetAgentId();
});

describe("scheduler hook", () => {
  test("runs for every group each tick, and a throw does not stop the tick", async () => {
    const seen: string[] = [];
    const s = createBackgroundScheduler({
      now: () => new Date(T0),
      brainReady: () => true,
      agents: async () => [group("A1"), group("A2")],
      handlers: {},
      sweep: async () => 0,
      expire: async () => 0,
      commitments: async (g) => {
        seen.push(g.agentId);
        if (g.agentId === "A1") throw new Error("boom");
      },
    });
    await s.tick();
    expect(seen).toEqual(["A1", "A2"]);
  });

  test("promises for every group run before any group's passes", async () => {
    const order: string[] = [];
    const s = createBackgroundScheduler({
      now: () => new Date(T0),
      brainReady: () => true,
      agents: async () => [group("A1"), group("A2")],
      handlers: { heartbeat: async (r) => void order.push(`heartbeat:${r.agentId}`) },
      sweep: async () => 0,
      expire: async () => 0,
      quietDue: async () => [],
      proactiveOn: () => true,
      commitments: async (g) => void order.push(`promises:${g.agentId}`),
    });
    await s.tick();
    expect(order).toEqual(["promises:A1", "promises:A2", "heartbeat:A1", "heartbeat:A2"]);
  });

  test("without a promise transport, the default deps check no promises", () => {
    expect(defaultSchedulerDeps().commitments).toBeUndefined();
  });
});

describe("promiseChecks (production wiring)", () => {
  test("opens a commitment run scoped to the promise's person, dispatches it, and charges nothing on a failed dispatch", async () => {
    await Commitments.upsertOpen({
      agentId: "U0AGENT", source: "user-u0alice", slug: "commitments/deploy", personaId: "default", teamId: "T0TEAM",
      channelId: "C0CHAN", threadTs: "1.1", beneficiary: "U0ALICE", runAs: "U0ALICE", dueText: "after the deploy", dueKind: "event",
      checkText: "", onNoChange: "silent", nextCheckAt: T0, expiresAt: T0 + 86_400_000, createdAt: T0,
    });
    const dispatched: string[] = [];
    let fail = false;
    const transport: PromiseTransport = {
      isBusy: async () => false,
      dispatch: async (_r, _e, run) => {
        if (fail) throw new Error("queue down");
        dispatched.push(run.runId);
      },
      post: async () => {},
    };
    process.env.SLAUDE_MODEL = "claude-sonnet-4-5";
    try {
      expect(await promiseChecks(transport)(group("U0AGENT"), new Date(T0))).toBe(1);
      const run = await Runs.get(dispatched[0]!);
      expect(run).toMatchObject({ pass: "commitment", scope: "user:U0ALICE", agentId: "U0AGENT", outcome: null });
      fail = true;
      expect(await promiseChecks(transport)(group("U0AGENT"), new Date(T0 + 15 * 60_000))).toBe(0);
      const rows = await db.query<{ pass: string; outcome: string | null; cost_usd: number }>("SELECT pass, outcome, cost_usd FROM background_runs WHERE outcome = 'error'");
      expect(rows).toEqual([{ pass: "commitment", outcome: "error", cost_usd: 0 }]);
    } finally {
      delete process.env.SLAUDE_MODEL;
    }
  });
});
