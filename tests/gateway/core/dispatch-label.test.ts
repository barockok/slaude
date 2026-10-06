import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { verifyJobToken } from "../../../src/gateway/api/auth";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";
import { __resetPersonaRegistry, runsOnFor, setPersonaRegistry, type PersonaRegistry } from "../../../src/persona/registry";
import type { SessionRow } from "../../../src/db/schema";

/**
 * The node label is decided at dispatch and signed into the job token and the
 * job payload (node labels and routing spec §4.3, §4.6): the persona's
 * `runs_on`, or `default`. Warm routing is used only when the warm node still
 * carries that label.
 */
function harness(opts: { warm?: { node: string; labels: string[] } } = {}) {
  const enqueued: { job: any; target: any }[] = [];
  const dispatch = makeQueueDispatch({ emit: () => false, resolveEffectiveIdentity: async () => undefined } as any, {
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
        lookup: async () => (opts.warm ? { node: opts.warm.node, since: 1, lastBeat: Date.now(), fresh: true } : null),
        nodeCarries: async (node: string, label: string) => node === opts.warm?.node && opts.warm.labels.includes(label),
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
  return { enqueued, dispatch };
}

/** A managed registry snapshot: ana runs on engineering, bea sets nothing. */
function managed(): PersonaRegistry {
  const people: Record<string, any> = {
    ana: { name: "ana", slackUserId: "UANA", runsOn: "engineering" },
    bea: { name: "bea", slackUserId: "UBEA", runsOn: null },
  };
  return {
    lookupByUserId: () => null,
    lookupByName: (n) => people[n] ?? null,
    list: () => Object.values(people),
    isMultiPersonaMode: () => true,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => ({ model: null, mcp: null, runsOn: null }),
  };
}

const META = { teamId: "T1", channelId: "C1", threadTs: "1.1", eventTs: "1.1", userId: "U1" };
const S = { id: "S1" } as unknown as SessionRow;

describe("label at dispatch", () => {
  beforeEach(() => {
    process.env.SLAUDE_JOB_SECRET = "test-secret";
  });
  afterEach(() => {
    __resetPersonaRegistry();
  });

  test("an unmanaged (filesystem) registry runs every persona on default", () => {
    expect(runsOnFor(undefined)).toBe("default");
    expect(runsOnFor("finance-bot")).toBe("default");
  });

  test("the token's label claim and the payload's label agree; default targets the default label", async () => {
    const h = harness();
    await h.dispatch.dispatch(S, "hi", { ...META, personaId: "finance-bot" });
    const v = verifyJobToken(h.enqueued[0]!.job.jobToken);
    expect(v.ok && v.claims.label).toBe("default");
    expect(h.enqueued[0]!.job.label).toBe("default");
    expect(h.enqueued[0]!.target).toEqual({ label: "default" });
    await h.dispatch.close();
  });

  test("a persona with runs_on targets its label queue, and the label is signed and in the payload", async () => {
    setPersonaRegistry(managed());
    const h = harness();
    await h.dispatch.dispatch(S, "hi", { ...META, personaId: "ana" });
    const v = verifyJobToken(h.enqueued[0]!.job.jobToken);
    expect(v.ok && v.claims.label).toBe("engineering");
    expect(h.enqueued[0]!.job.label).toBe("engineering");
    expect(h.enqueued[0]!.target).toEqual({ label: "engineering" });
    // A persona with null runs_on runs on default.
    await h.dispatch.dispatch({ id: "S2" } as unknown as SessionRow, "hi", { ...META, personaId: "bea" });
    expect(h.enqueued[1]!.target).toEqual({ label: "default" });
    await h.dispatch.close();
  });

  test("warm routing is used when the warm node carries the label", async () => {
    setPersonaRegistry(managed());
    const h = harness({ warm: { node: "node-eng", labels: ["engineering"] } });
    await h.dispatch.dispatch(S, "hi", { ...META, personaId: "ana" });
    expect(h.enqueued[0]!.target).toEqual({ node: "node-eng" });
    await h.dispatch.close();
  });

  test("the follower follows a moved job instead of closing the turn when the original completes", async () => {
    // The original completes on `turns` as moved (a label mismatch at claim);
    // the turn itself is still waiting on turns.label.engineering.
    const states = new Map<string, string>([["turns/J1", "completed"], ["turns.label.engineering/J1", "waiting"]]);
    const events: any[] = [];
    const dispatch = makeQueueDispatch({ emit: (_: string, e: unknown) => (events.push(e), true), resolveEffectiveIdentity: async () => undefined } as any, {
      followPollMs: 5,
      followLingerMs: 10,
      infra: {
        turns: {
          enqueueTurn: async () => ({ queue: "turns", jobId: "J1", coalesced: false }),
          queue: (name: string) => ({ getJob: async (id: string) => ({ getState: async () => states.get(`${name}/${id}`) ?? "missing" }) }),
          movedTo: async (id: string) => (id === "J1" ? { queue: "turns.label.engineering", jobId: "J1" } : null),
          close: async () => {},
        } as any,
        registry: { lookup: async () => null, close: async () => {} } as any,
        pubsub: { consumeAbortFlag: async () => null, lastEventId: async () => null, readEvents: async () => [], close: async () => {} } as any,
      },
    });
    await dispatch.dispatch(S, "hi", META);
    await new Promise((r) => setTimeout(r, 80));
    expect(events).toEqual([]); // no synthesized done for the move
    states.set("turns.label.engineering/J1", "completed");
    const deadline = Date.now() + 2000;
    while (events.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual([{ type: "done", sessionId: "S1" }]);
    await dispatch.close();
  });

  test("warm routing is ignored when the warm node lacks the persona's (new) label", async () => {
    setPersonaRegistry(managed());
    const h = harness({ warm: { node: "node-old", labels: ["default"] } });
    await h.dispatch.dispatch(S, "hi", { ...META, personaId: "ana" });
    expect(h.enqueued[0]!.target).toEqual({ label: "engineering" });
    await h.dispatch.close();
  });
});
