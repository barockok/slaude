/**
 * Failover mid-check (phase E), over real Redis leader election: two
 * background schedulers contend for the `background` role. The leader claims a
 * due promise and dies inside its dispatch (the call never returns, and its
 * term ends). The other replica takes over: it never checks the promise a
 * second time while the dead leader's claim is fresh, and checks it exactly
 * once after STALE_CLAIM_MS. Gated on SLAUDE_REDIS_TEST_URL.
 */
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Redis } from "ioredis";
import { cleanupPrefix, realEnabled, realRedis, testPrefix, until } from "../queue/real";
import { makeKeys } from "../../src/queue/keys";
import { leaderLoop } from "../../src/queue/locks";
import { db } from "../../src/db/schema";
import * as Commitments from "../../src/db/commitments";
import { startBackgroundScheduler, type AgentGroup } from "../../src/background/scheduler";
import { runDueCommitments, STALE_CLAIM_MS, type PromiseTransport } from "../../src/proactive/promises";
import { NO_PREFS } from "../../src/proactive/prefs";

const prefix = testPrefix("promfail");
const keys = makeKeys(prefix);
let redis: Redis | null = null;

const AGENT = "U0AGENT";
const T0 = Date.parse("2026-10-26T10:00:00Z");
const group: AgentGroup = { agentId: AGENT, personaId: "default", personaIds: ["default"], timeZone: "UTC" };

afterAll(async () => {
  if (redis) {
    await cleanupPrefix(redis, prefix);
    redis.disconnect();
  }
});

let spies: Array<ReturnType<typeof spyOn>> = [];
beforeEach(async () => {
  await db.run("DELETE FROM commitments");
  await db.run("DELETE FROM background_slots");
  for (const s of spies) s.mockRestore();
  spies = (["log", "warn", "debug"] as const).map((k) => spyOn(console, k).mockImplementation(() => {}));
});

describe.skipIf(!realEnabled)("promise check failover against real Redis", () => {
  test("a leader that dies mid-check: the next leader waits out its claim, then checks the promise once", async () => {
    redis ??= realRedis();
    await Commitments.upsertOpen({
      agentId: AGENT, source: "agent-u0agent", slug: "commitments/deploy", personaId: "default", teamId: "T0TEAM",
      channelId: "C0CHAN", threadTs: "1.1", beneficiary: "U0ALICE", runAs: null, dueText: "after the deploy", dueKind: "event",
      checkText: "", onNoChange: "silent", nextCheckAt: T0, expiresAt: T0 + 86_400_000, createdAt: T0,
    });
    let clock = T0;
    const dispatched: string[] = [];
    const replica = (name: string, dies: boolean) => {
      const transport: PromiseTransport = {
        isBusy: async () => false,
        // The dying leader never comes back from its dispatch.
        dispatch: async () => {
          dispatched.push(name);
          if (dies) await new Promise(() => {});
        },
        post: async () => {},
      };
      return startBackgroundScheduler(
        {
          now: () => new Date(clock),
          brainReady: () => true,
          agents: async () => [group],
          handlers: {},
          sweep: async () => 0,
          expire: async () => 0,
          quietDue: async () => [],
          sleep: (ms, signal) => new Promise((r) => { const t = setTimeout(r, 30); signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); }),
          commitments: (g, now) =>
            runDueCommitments(g.agentId, now, {
              transport,
              timeZone: "UTC",
              prefs: async () => NO_PREFS,
              openRun: async () => ({ ok: true, runId: `${name}-run`, agentId: AGENT }),
              dropRun: async () => {},
            }),
        },
        { elect: (fn) => leaderLoop("background", fn, { redis: redis!, keys, ttlSec: 1 }) },
      );
    };

    // A leads (started first, alone) and dies inside the check.
    const a = replica("A", true);
    await until(() => dispatched.includes("A"), 5_000);
    const b = replica("B", false);
    await a.stop(50);

    // B takes over. The claim is fresh: B must not check the promise again.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(dispatched).toEqual(["A"]);
    expect((await Commitments.get({ agentId: AGENT, source: "agent-u0agent", slug: "commitments/deploy" }))!.nextCheckAt).toBe(T0);

    // Past STALE_CLAIM_MS the claim is a dead leader's: B checks it, once.
    clock = T0 + STALE_CLAIM_MS + 60_000;
    await until(() => dispatched.includes("B"), 5_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(dispatched).toEqual(["A", "B"]);
    expect(await Commitments.get({ agentId: AGENT, source: "agent-u0agent", slug: "commitments/deploy" })).toMatchObject({ checks: 1, status: "open" });
    await b.stop(50);
  }, 30_000);
});
