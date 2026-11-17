import { beforeEach, describe, expect, test } from "bun:test";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";
import type { SessionRow } from "../../../src/db/schema";
import { db } from "../../../src/db/schema";
import { flushAudits } from "../../../src/audit/emit";
import { GUARDRAILS_CAPABILITY } from "../../../src/guardrails/capability";

/**
 * Version skew (design section 2): an agent with enforced owner rules runs
 * only on a node that advertises the guardrails capability. Warm routing to a
 * node without it is skipped; a mixed fleet pins the turn to a capable node's
 * own queue; with none, the turn waits, then the thread gets a notice and the
 * refusal is audited as guardrail.node.unsupported.
 */
function harness(o: { needs: boolean; warm?: { node: string; caps: string[] }; nodes?: () => Array<{ node: string; has: boolean }>; waitMs?: number }) {
  const enqueued: { job: any; target: any }[] = [];
  const events: any[] = [];
  const dispatch = makeQueueDispatch({ emit: (_n: string, e: any) => (events.push(e), true), resolveEffectiveIdentity: async () => undefined } as any, {
    needsGuardrails: async () => o.needs,
    guardrailWaitMs: o.waitMs ?? 50,
    guardrailPollMs: 5,
    infra: {
      turns: {
        enqueueTurn: async (job: any, target: any) => {
          enqueued.push({ job, target });
          return { queue: "turns", jobId: "J1", coalesced: false };
        },
        queue: () => ({ getJob: async () => ({ getState: async () => "active" }) }),
        movedTo: async () => null,
        close: async () => {},
      } as any,
      registry: {
        lookup: async () => (o.warm ? { node: o.warm.node, since: 1, lastBeat: Date.now(), fresh: true } : null),
        nodeCarries: async () => true,
        nodeCaps: async (node: string) => new Set(node === o.warm?.node ? o.warm.caps : []),
        liveNodesWithCap: async () => (o.nodes ? o.nodes() : []),
        close: async () => {},
      } as any,
      pubsub: {
        consumeAbortFlag: async () => null,
        lastEventId: async () => null,
        appendEvent: async () => {},
        readEvents: async () => [],
        close: async () => {},
      } as any,
    },
  });
  return { enqueued, events, dispatch };
}

const META = { teamId: "T1", channelId: "C1", threadTs: "1.1", eventTs: "1.1", userId: "U1", personaId: "ana" };
const S = { id: "S-gr" } as unknown as SessionRow;

beforeEach(() => {
  process.env.SLAUDE_JOB_SECRET = "test-secret";
});

describe("dispatch and the guardrails capability", () => {
  test("no enforced rules: routing is unchanged (warm node without the capability is fine)", async () => {
    const h = harness({ needs: false, warm: { node: "old-node", caps: [] } });
    await h.dispatch.dispatch(S, "hi", META);
    expect(h.enqueued[0]!.target).toEqual({ node: "old-node" });
    expect(h.enqueued[0]!.job.requiresCaps).toBeUndefined();
  });

  test("enforced rules: a warm node with the capability keeps the session; one without is skipped", async () => {
    const ok = harness({ needs: true, warm: { node: "new-node", caps: [GUARDRAILS_CAPABILITY] } });
    await ok.dispatch.dispatch(S, "hi", META);
    expect(ok.enqueued[0]!.target).toEqual({ node: "new-node" });
    const skip = harness({ needs: true, warm: { node: "old-node", caps: [] }, nodes: () => [{ node: "a", has: true }, { node: "b", has: true }] });
    await skip.dispatch.dispatch(S, "hi", META);
    expect(skip.enqueued[0]!.target).toEqual({ label: "default" });
  });

  test("a mixed fleet pins the turn to a capable node's own queue", async () => {
    const h = harness({ needs: true, nodes: () => [{ node: "old", has: false }, { node: "new-1", has: true }, { node: "new-2", has: true }] });
    await h.dispatch.dispatch(S, "hi", META);
    expect(["new-1", "new-2"]).toContain(h.enqueued[0]!.target.node);
    // The reaper may move it later: the job says what its node needs.
    expect(h.enqueued[0]!.job.requiresCaps).toEqual(["guardrails/1"]);
  });

  test("the turn waits for a capable node to come up", async () => {
    let calls = 0;
    const h = harness({ needs: true, waitMs: 2000, nodes: () => (++calls < 3 ? [{ node: "old", has: false }] : [{ node: "old", has: false }, { node: "new", has: true }]) });
    await h.dispatch.dispatch(S, "hi", META);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(h.enqueued[0]!.target).toEqual({ node: "new" });
  });

  test("no capable node within the wait: not dispatched, a thread notice, audited", async () => {
    await db.run("DELETE FROM audit_events WHERE action = 'guardrail.node.unsupported'");
    const h = harness({ needs: true, nodes: () => [{ node: "old", has: false }] });
    await h.dispatch.dispatch(S, "hi", META);
    expect(h.enqueued).toHaveLength(0);
    expect(h.events).toEqual([{ type: "error", sessionId: "S-gr", error: "no guardrails-capable node", code: "GUARDRAILS_UNSUPPORTED" }]);
    await flushAudits();
    const rows = await db.query<{ action: string; persona: string; target_id: string }>(`SELECT action, persona, target_id FROM audit_events WHERE action = 'guardrail.node.unsupported'`);
    expect(rows).toEqual([{ action: "guardrail.node.unsupported", persona: "ana", target_id: "default" }]);
  });
});
