/**
 * LABEL_MISMATCH at the gateway (node labels spec §4.6): the dispatch
 * follower re-dispatches the turn ONCE to the persona's current label and
 * posts nothing; when the second attempt also fails the user sees one error
 * event (one fixed message). The node's LABEL_MISMATCH stream event is held
 * back either way. A follower that loses the cross-replica once-guard follows
 * the winner's job-moved marker instead.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";
import { verifyJobToken } from "../../../src/gateway/api/auth";
import { __resetPersonaRegistry, setPersonaRegistry } from "../../../src/persona/registry";
import type { SessionRow } from "../../../src/db/schema";

type Outcome = "failed-mismatch" | "completed";

function infra(outcomes: Outcome[], o: { loseGuard?: boolean } = {}) {
  const stream: Array<{ id: string; event: any }> = [];
  let next = 1;
  const jobs = new Map<string, { data: any; state: string; failedReason?: string; queue: string }>();
  const moved = new Map<string, { queue: string; jobId: string }>();
  const redispatches: Array<{ failedJobId: string; data: any; label: string; newJobId: string }> = [];
  let n = 0;
  /** Settle a job as the node would, with the next scripted outcome. */
  const settle = (jobId: string, data: any) => {
    const out = outcomes[n++] ?? "completed";
    if (out === "failed-mismatch") {
      // The node's turn-end event: held back by the follower.
      stream.push({ id: `${next++}-0`, event: { type: "error", sessionId: data.sessionId, error: "label gate", code: "LABEL_MISMATCH" } });
      jobs.get(jobId)!.state = "failed";
      jobs.get(jobId)!.failedReason = "LABEL_MISMATCH";
    } else {
      stream.push({ id: `${next++}-0`, event: { type: "done", sessionId: data.sessionId } });
      jobs.get(jobId)!.state = "completed";
    }
  };
  const pubsub = {
    readEvents: async (_s: string, from?: string) =>
      stream.filter((e) => from === undefined || Number(e.id.split("-")[0]) > Number(from.split("-")[0])),
    lastEventId: async () => stream.at(-1)?.id ?? null,
    consumeAbortFlag: async () => null,
    close: async () => {},
  };
  const turns = {
    enqueueTurn: async (data: any, _t: unknown, jobId: string) => {
      jobs.set(jobId, { data, state: "active", queue: "turns.label.engineering" });
      setTimeout(() => settle(jobId, data), 10);
      return { queue: "turns.label.engineering", jobId, coalesced: false };
    },
    redispatch: async (failedJobId: string, data: any, label: string, newJobId: string) => {
      redispatches.push({ failedJobId, data, label, newJobId });
      if (o.loseGuard) {
        // Another replica won: it enqueued and wrote the marker.
        const otherId = "other-replica-job";
        jobs.set(otherId, { data, state: "active", queue: `turns.label.${label}` });
        moved.set(failedJobId, { queue: `turns.label.${label}`, jobId: otherId });
        setTimeout(() => settle(otherId, data), 10);
        return null;
      }
      const q = `turns.label.${label}`;
      jobs.set(newJobId, { data, state: "active", queue: q });
      moved.set(failedJobId, { queue: q, jobId: newJobId });
      setTimeout(() => settle(newJobId, data), 10);
      return { queue: q, jobId: newJobId, coalesced: false };
    },
    queue: () => ({
      getJob: async (id: string) => {
        const j = jobs.get(id);
        if (!j) return undefined;
        return { id, data: j.data, failedReason: j.failedReason, getState: async () => j.state };
      },
    }),
    movedTo: async (id: string) => moved.get(id) ?? null,
    close: async () => {},
  };
  return { infra: { pubsub, turns, registry: { lookup: async () => null, close: async () => {} } }, redispatches };
}

/** The default persona now runs on finance. */
const managedDefault = (label: string | null) => ({
  lookupByUserId: () => null,
  lookupByName: () => null,
  list: () => [],
  isMultiPersonaMode: () => false,
  isManaged: () => true,
  tombstonedPersonaFor: () => null,
  defaultPersona: () => ({ model: null, mcp: null, runsOn: label }),
});

const META = { teamId: "T1", channelId: "C1", threadTs: "1.1", eventTs: "1.1", userId: "UTESTUSER1" };
const session = (id: string) => ({ id }) as unknown as SessionRow;

describe("dispatch: LABEL_MISMATCH re-dispatch", () => {
  let events: any[];
  let dispatch: ReturnType<typeof makeQueueDispatch>;
  beforeEach(() => {
    process.env.SLAUDE_JOB_SECRET = "test-secret";
    events = [];
  });
  afterEach(async () => {
    await dispatch?.close();
    __resetPersonaRegistry();
  });

  const run = async (outcomes: Outcome[], o: { loseGuard?: boolean } = {}) => {
    // The turn was dispatched on engineering; the persona has since moved.
    setPersonaRegistry(managedDefault("engineering") as any);
    const inf = infra(outcomes, o);
    dispatch = makeQueueDispatch({ emit: (_: string, e: unknown) => (events.push(e), true), resolveEffectiveIdentity: async () => undefined } as any, {
      infra: inf.infra as any,
      followPollMs: 5,
      followLingerMs: 30,
      followMaxMs: 3_000,
    });
    const warn = console.warn;
    const log = console.log;
    console.warn = () => {};
    console.log = () => {};
    try {
      await dispatch.dispatch(session("s1"), "hello", META);
      setPersonaRegistry(managedDefault("finance") as any);
      const deadline = Date.now() + 3_000;
      while (!events.some((e) => e.type === "error" || e.type === "done") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 120)); // outlast the linger window
    } finally {
      console.warn = warn;
      console.log = log;
    }
    return inf.redispatches;
  };

  test("the first mismatch is re-dispatched once to the current label, silently, and the turn completes", async () => {
    const rd = await run(["failed-mismatch", "completed"]);
    expect(rd).toHaveLength(1);
    expect(rd[0]!.label).toBe("finance");
    expect(rd[0]!.data.label).toBe("finance");
    expect(rd[0]!.data.relabelAttempts).toBe(1);
    expect(rd[0]!.data.messages.map((m: any) => m.text)).toEqual(["hello"]);
    // A fresh token signed for the new label and the new job id.
    const v = verifyJobToken(rd[0]!.data.jobToken);
    expect(v.ok && v.claims.label).toBe("finance");
    expect(v.ok && v.claims.job).toBe(rd[0]!.newJobId);
    expect(v.ok && v.claims.session).toBe("s1");
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  test("a second mismatch is shown once, never re-dispatched again", async () => {
    const rd = await run(["failed-mismatch", "failed-mismatch"]);
    expect(rd).toHaveLength(1);
    const errs = events.filter((e) => e.type === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe("LABEL_MISMATCH");
    expect(errs[0].jobId).toBe(rd[0]!.newJobId);
    expect(events.filter((e) => e.type === "done")).toEqual([]);
  });

  test("a follower that loses the once-guard follows the winner's job", async () => {
    const rd = await run(["failed-mismatch", "completed"], { loseGuard: true });
    expect(rd).toHaveLength(1);
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });
});
