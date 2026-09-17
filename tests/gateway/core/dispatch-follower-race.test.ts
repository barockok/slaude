/**
 * The dispatch follower re-emits a turn's events from the Redis stream so the
 * gateway can render them in Slack. It skips events already on the stream when
 * it starts, because those belong to earlier turns.
 *
 * It used to read that starting cursor inside the follower, which starts only
 * after the job is enqueued. A node fast enough to claim the job and append the
 * whole turn in that window had its events counted as backlog and skipped. The
 * job-completion authority check still synthesized the outcome, so the turn
 * "finished" — but every intermediate event (streamed text, tool calls, status)
 * was silently lost.
 *
 * These tests use a fake node that appends the entire turn BEFORE enqueueTurn
 * returns: the losing ordering, made deterministic instead of left to CI timing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";
import type { SessionRow } from "../../../src/db/schema";

type Entry = { id: string; event: any };

const seq = (id: string) => Number(id.split("-")[0]);

function fakeInfra(opts: { failCursorRead?: boolean } = {}) {
  const streams = new Map<string, Entry[]>();
  let next = 1;
  const stream = (s: string) => streams.get(s) ?? (streams.set(s, []), streams.get(s)!);

  const pubsub = {
    appendEvent: async (sessionId: string, event: unknown) => {
      const id = `${next++}-0`;
      stream(sessionId).push({ id, event });
      return id;
    },
    readEvents: async (sessionId: string, fromId?: string) =>
      stream(sessionId).filter((e) => fromId === undefined || seq(e.id) > seq(fromId)),
    lastEventId: async (sessionId: string) => {
      if (opts.failCursorRead) throw new Error("redis unavailable");
      return stream(sessionId).at(-1)?.id ?? null;
    },
    consumeAbortFlag: async () => null,
    close: async () => {},
  };

  // A node that claims the job instantly: the whole turn is on the stream, and
  // the job is complete, before enqueueTurn returns to the dispatcher.
  const completed = new Set<string>();
  const turns = {
    enqueueTurn: async (job: any, _target: unknown, jobId: string) => {
      await pubsub.appendEvent(job.sessionId, { type: "assistantText", sessionId: job.sessionId, text: "new turn" });
      await pubsub.appendEvent(job.sessionId, { type: "done", sessionId: job.sessionId });
      completed.add(jobId);
      return { queue: "turns", jobId, coalesced: false };
    },
    queue: () => ({
      getJob: async (id: string) => ({ getState: async () => (completed.has(id) ? "completed" : "active") }),
    }),
    close: async () => {},
  };

  return { pubsub, turns, registry: { lookup: async () => null, close: async () => {} } };
}

const META = { teamId: "T1", channelId: "C1", threadTs: "1.1", eventTs: "1.1", userId: "UTESTUSER1" };
const session = (id: string) => ({ id }) as unknown as SessionRow;

async function until(cond: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("dispatch follower cursor", () => {
  let events: any[];
  let dispatch: ReturnType<typeof makeQueueDispatch>;

  const build = (infra: ReturnType<typeof fakeInfra>) =>
    makeQueueDispatch({ emit: (_: string, e: unknown) => (events.push(e), true) } as any, {
      infra: infra as any,
      followPollMs: 5,
      followLingerMs: 30,
      followMaxMs: 2_000,
    });

  beforeEach(() => {
    process.env.SLAUDE_JOB_SECRET = "test-secret";
    events = [];
  });

  afterEach(async () => {
    await dispatch?.close();
  });

  test("a turn finished before the follower starts still has its events re-emitted", async () => {
    dispatch = build(fakeInfra());

    await dispatch.dispatch(session("s1"), "hello", META);
    await until(() => events.some((e) => e.type === "done"));
    await new Promise((r) => setTimeout(r, 60)); // outlast the linger window

    expect(events.filter((e) => e.type === "assistantText").map((e) => e.text)).toEqual(["new turn"]);
  });

  test("the outcome is emitted exactly once, from the stream, not synthesized", async () => {
    dispatch = build(fakeInfra());
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));

    try {
      await dispatch.dispatch(session("s1"), "hello", META);
      await until(() => events.some((e) => e.type === "done"));
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      console.warn = warn;
    }

    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    // The synthesizer only fires when the stream failed to deliver the outcome.
    expect(warnings.some((w) => w.includes("events-stream gap"))).toBe(false);
  });

  // The reason the follower skips a backlog at all must still hold.
  test("events from earlier turns already on the stream are still skipped", async () => {
    const infra = fakeInfra();
    await infra.pubsub.appendEvent("s1", { type: "assistantText", sessionId: "s1", text: "earlier turn" });
    await infra.pubsub.appendEvent("s1", { type: "done", sessionId: "s1" });
    dispatch = build(infra);

    await dispatch.dispatch(session("s1"), "hello", META);
    await until(() => events.some((e) => e.type === "done"));
    await new Promise((r) => setTimeout(r, 60));

    expect(events.filter((e) => e.type === "assistantText").map((e) => e.text)).toEqual(["new turn"]);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  test("a failed cursor read does not fail the dispatch", async () => {
    dispatch = build(fakeInfra({ failCursorRead: true }));

    await dispatch.dispatch(session("s1"), "hello", META);
    await until(() => events.some((e) => e.type === "done"));

    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });
});
