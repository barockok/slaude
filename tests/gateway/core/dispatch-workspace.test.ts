import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";
import { proactiveWorkspaceDir } from "../../../src/agent/workspace-claim";
import type { SessionRow } from "../../../src/db/schema";

/**
 * A turn in the agent's proactive folder carries that folder on its job, so
 * the node serialises it against every other turn in the folder. Any other
 * session's job has no `workspace` key.
 */
function harness() {
  const enqueued: any[] = [];
  const dispatch = makeQueueDispatch({ emit: () => false, resolveEffectiveIdentity: async () => undefined } as any, {
    infra: {
      turns: {
        enqueueTurn: async (job: any) => {
          enqueued.push(job);
          return { queue: "turns", jobId: "J1", coalesced: false };
        },
        queue: () => ({ getJob: async () => ({ getState: async () => "active" }) }),
        movedTo: async () => null,
        close: async () => {},
      } as any,
      registry: { lookup: async () => null, nodeCarries: async () => false, close: async () => {} } as any,
      pubsub: {
        consumeAbortFlag: async () => null,
        lastEventId: async () => null,
        appendEvent: async () => {},
        readEvents: async () => [],
        close: async () => {},
      } as any,
    },
  });
  return { enqueued, dispatch };
}

const META = { teamId: "T1", channelId: "C0EXAMPLE", threadTs: "1.1", eventTs: "1.1", userId: "U0MANAGER" };

describe("workspace on the turn job", () => {
  const saved = process.env.SLAUDE_JOB_SECRET;
  beforeEach(() => {
    process.env.SLAUDE_JOB_SECRET = "test-secret";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SLAUDE_JOB_SECRET;
    else process.env.SLAUDE_JOB_SECRET = saved;
  });

  test("a session in the proactive folder enqueues a job carrying that folder", async () => {
    const h = harness();
    const dir = proactiveWorkspaceDir("U0AGENT");
    await h.dispatch.dispatch({ id: "S1", working_dir: dir } as unknown as SessionRow, "hi", META);
    expect(h.enqueued[0]!.workspace).toBe(dir);
    await h.dispatch.close();
  });

  test("the job carries the folder resolved, however the session row spells it", async () => {
    const h = harness();
    const dir = proactiveWorkspaceDir("U0AGENT");
    await h.dispatch.dispatch({ id: "S4", working_dir: `${dir}/` } as unknown as SessionRow, "hi", META);
    expect(h.enqueued[0]!.workspace).toBe(dir);
    await h.dispatch.close();
  });

  test("an ordinary session's job has no workspace key", async () => {
    const h = harness();
    await h.dispatch.dispatch({ id: "S2", working_dir: "/tmp/elsewhere/S2" } as unknown as SessionRow, "hi", META);
    await h.dispatch.dispatch({ id: "S3" } as unknown as SessionRow, "hi", META);
    expect("workspace" in h.enqueued[0]!).toBe(false);
    expect("workspace" in h.enqueued[1]!).toBe(false);
    await h.dispatch.close();
  });
});
