import { beforeEach, describe, expect, test } from "bun:test";
import { verifyJobToken } from "../../../src/gateway/api/auth";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";
import { runsOnFor } from "../../../src/persona/registry";
import type { SessionRow } from "../../../src/db/schema";

/**
 * The node label is decided at dispatch and signed into the job token and the
 * job payload (node labels and routing spec §4.3). Until `personas.runs_on`
 * lands every persona runs on `default`.
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
        close: async () => {},
      } as any,
      registry: { lookup: async () => null, close: async () => {} } as any,
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

describe("label at dispatch", () => {
  beforeEach(() => {
    process.env.SLAUDE_JOB_SECRET = "test-secret";
  });

  test("runsOnFor is default for every persona for now", () => {
    expect(runsOnFor(undefined)).toBe("default");
    expect(runsOnFor("finance-bot")).toBe("default");
  });

  test("the token's label claim and the payload's label agree", async () => {
    const h = harness();
    await h.dispatch.dispatch({ id: "S1" } as unknown as SessionRow, "hi", {
      teamId: "T1", channelId: "C1", threadTs: "1.1", eventTs: "1.1", userId: "U1", personaId: "finance-bot",
    });
    const v = verifyJobToken(h.enqueued[0].jobToken);
    expect(v.ok && v.claims.label).toBe("default");
    expect(h.enqueued[0].label).toBe("default");
    await h.dispatch.close();
  });
});
