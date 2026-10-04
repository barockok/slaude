/**
 * D1.6: a failed job reaches the gateway as ONE error event carrying a typed
 * code and the job id, whether the node's error rode the stream or the job
 * settled failed with the stream silent. The gateway maps the code to fixed text.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";
import type { SessionRow } from "../../../src/db/schema";

function infra(opts: { streamError: boolean }) {
  const stream: Array<{ id: string; event: any }> = [];
  let next = 1;
  const failed = new Set<string>();
  const pubsub = {
    appendEvent: async (_s: string, event: unknown) => {
      const id = `${next++}-0`;
      stream.push({ id, event });
      return id;
    },
    readEvents: async (_s: string, from?: string) =>
      stream.filter((e) => from === undefined || Number(e.id.split("-")[0]) > Number(from.split("-")[0])),
    lastEventId: async () => stream.at(-1)?.id ?? null,
    consumeAbortFlag: async () => null,
    close: async () => {},
  };
  const turns = {
    enqueueTurn: async (job: any, _t: unknown, jobId: string) => {
      if (opts.streamError) {
        await pubsub.appendEvent(job.sessionId, {
          type: "error",
          sessionId: job.sessionId,
          error: "Invalid API key · Please run /login",
          code: "TURN_FAILED",
        });
      }
      failed.add(jobId);
      return { queue: "turns", jobId, coalesced: false };
    },
    queue: () => ({ getJob: async (id: string) => ({ getState: async () => (failed.has(id) ? "failed" : "active") }) }),
    movedTo: async () => null,
    close: async () => {},
  };
  return { pubsub, turns, registry: { lookup: async () => null, close: async () => {} } };
}

const META = { teamId: "T1", channelId: "C1", threadTs: "1.1", eventTs: "1.1", userId: "UTESTUSER1" };
const session = (id: string) => ({ id }) as unknown as SessionRow;

describe("dispatch failure events", () => {
  let events: any[];
  let dispatch: ReturnType<typeof makeQueueDispatch>;
  beforeEach(() => {
    process.env.SLAUDE_JOB_SECRET = "test-secret";
    events = [];
  });
  afterEach(async () => {
    await dispatch?.close();
  });

  const run = async (streamError: boolean) => {
    dispatch = makeQueueDispatch({ emit: (_: string, e: unknown) => (events.push(e), true), resolveEffectiveIdentity: async () => undefined } as any, {
      infra: infra({ streamError }) as any,
      followPollMs: 5,
      followLingerMs: 30,
      followMaxMs: 2_000,
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      await dispatch.dispatch(session("s1"), "hello", META);
      const deadline = Date.now() + 3_000;
      while (!events.some((e) => e.type === "error") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 80)); // outlast the linger window
    } finally {
      console.warn = warn;
    }
  };

  test("a stream error and a failed job give one error event, tagged with the job id", async () => {
    await run(true);
    const errs = events.filter((e) => e.type === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe("TURN_FAILED");
    expect(typeof errs[0].jobId).toBe("string");
  });

  test("a failed job with a silent stream synthesizes a coded event with no provider text", async () => {
    await run(false);
    const errs = events.filter((e) => e.type === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe("TURN_FAILED");
    expect(typeof errs[0].jobId).toBe("string");
  });
});
