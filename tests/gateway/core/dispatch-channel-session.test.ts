import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";
import { createGateway, type GatewayHandle } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import type { SessionRow } from "../../../src/db/schema";
import { db } from "../../../src/db/schema";
import { flushAudits } from "../../../src/audit/emit";
import { CHANNEL_SESSION_CAPABILITY, GUARDRAILS_CAPABILITY } from "../../../src/guardrails/capability";
import { JOB_HEADER, mintJobToken, verifyJobToken, type JobClaims } from "../../../src/gateway/api/auth";
import { handleTokenRefresh, handleTokenReissue } from "../../../src/gateway/api/jobs";
import { sameTurnKind, type TurnJob } from "../../../src/queue/turns";
import { NODE_CAPS } from "../../../src/node/worker";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { CAPABILITIES_HEADER } from "../../../src/guardrails/capability";
import { bundleFetchFailure, NodeApiError } from "../../../src/node/client";
import { BootFailure } from "../../../src/gateway/core/failure-codes";

/**
 * Channel session mode on a cluster: a root turn's replies reach channel root
 * because the post target is signed into the job token (the /v1 tool plane
 * rebuilds its context from the claims), and only a node that advertises
 * channel-session/1 may run a job on a channel session.
 */
function harness(o: { needs?: boolean; warm?: { node: string; caps: string[] }; nodes?: () => Array<{ node: string; has: boolean }> } = {}) {
  const enqueued: { job: any; target: any }[] = [];
  const events: any[] = [];
  const dispatch = makeQueueDispatch({ emit: (_n: string, e: any) => (events.push(e), true), resolveEffectiveIdentity: async () => undefined } as any, {
    needsGuardrails: async () => o.needs ?? false,
    guardrailWaitMs: 50,
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
        liveNodesWithCap: async () => (o.nodes ? o.nodes() : [{ node: "n1", has: true }]),
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
  const claims = () => {
    const v = verifyJobToken(enqueued.at(-1)!.job.jobToken);
    if (!v.ok) throw new Error(v.reason);
    return v.claims;
  };
  return { enqueued, events, dispatch, claims };
}

const META = { teamId: "T1", channelId: "C1", threadTs: "1.1", eventTs: "1.1", userId: "U1", personaId: "ana" };
const S = { id: "S-cs" } as unknown as SessionRow;
const SAVED = { job: process.env.SLAUDE_JOB_SECRET, node: process.env.SLAUDE_NODE_TOKEN };

beforeEach(() => {
  process.env.SLAUDE_JOB_SECRET = "test-secret";
  process.env.SLAUDE_NODE_TOKEN = "cs-node-token";
});
afterEach(() => {
  for (const [k, v] of [["SLAUDE_JOB_SECRET", SAVED.job], ["SLAUDE_NODE_TOKEN", SAVED.node]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("dispatch signs the post target", () => {
  test("meta.postTarget mints post: channel", async () => {
    const h = harness();
    await h.dispatch.dispatch(S, "hi", { ...META, postTarget: "channel" });
    expect(h.claims().post).toBe("channel");
  });

  test("without it the claim is absent, and the thread claim stays the real ts", async () => {
    const h = harness();
    await h.dispatch.dispatch(S, "hi", META);
    expect("post" in h.claims()).toBe(false);
    expect(h.claims().thread).toBe("1.1");
  });
});

describe("dispatch and the channel session capability", () => {
  test("every node advertises it", () => {
    expect(NODE_CAPS).toContain(CHANNEL_SESSION_CAPABILITY);
    expect(CHANNEL_SESSION_CAPABILITY).toBe("channel-session/1");
  });

  test("a channel session job requires the capability, with no owner rules at all", async () => {
    const h = harness({ nodes: () => [{ node: "a", has: true }, { node: "b", has: true }] });
    await h.dispatch.dispatch(S, "hi", { ...META, channelSession: true });
    expect(h.enqueued[0]!.job.requiresCaps).toEqual(["channel-session/1"]);
    expect(h.enqueued[0]!.target).toEqual({ label: "default" });
  });

  test("the channel session capability wins over the guardrails one", async () => {
    const h = harness({ needs: true });
    await h.dispatch.dispatch(S, "hi", { ...META, channelSession: true });
    expect(h.enqueued[0]!.job.requiresCaps).toEqual(["channel-session/1"]);
  });

  test("a job off a channel session needs nothing new", async () => {
    const h = harness();
    await h.dispatch.dispatch(S, "hi", META);
    expect(h.enqueued[0]!.job.requiresCaps).toBeUndefined();
  });

  test("a warm node without the capability is not reused, even with the guardrails one", async () => {
    const old = harness({ warm: { node: "old-node", caps: [GUARDRAILS_CAPABILITY] }, nodes: () => [{ node: "old-node", has: false }, { node: "new-node", has: true }] });
    await old.dispatch.dispatch(S, "hi", { ...META, channelSession: true });
    expect(old.enqueued[0]!.target).toEqual({ node: "new-node" });
  });

  test("a warm node with the capability keeps the session", async () => {
    const h = harness({ warm: { node: "new-node", caps: [CHANNEL_SESSION_CAPABILITY] } });
    await h.dispatch.dispatch(S, "hi", { ...META, channelSession: true });
    expect(h.enqueued[0]!.target).toEqual({ node: "new-node" });
  });

  test("no capable node: not dispatched, a notice that names channel sessions, audited", async () => {
    await db.run("DELETE FROM audit_events WHERE action = 'guardrail.node.unsupported'");
    const h = harness({ nodes: () => [{ node: "old", has: false }] });
    await h.dispatch.dispatch(S, "hi", { ...META, channelSession: true });
    expect(h.enqueued).toHaveLength(0);
    expect(h.events).toEqual([{ type: "error", sessionId: "S-cs", error: "no channel-session-capable node", code: "CHANNEL_SESSION_UNSUPPORTED" }]);
    await flushAudits();
    const rows = await db.query<{ summary: string; details: string }>(`SELECT summary, details FROM audit_events WHERE action = 'guardrail.node.unsupported'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe("no node on label default runs channel sessions; the turn was not dispatched");
    expect(rows[0]!.details).toContain("channel-session/1");
  });
});

describe("a re-minted token keeps the post target", () => {
  const CLAIMS = { tenant: "default", persona: "default", session: "S-cs", team: "T1", channel: "C1", thread: "1.1", initiator: "U1", scope: "turn", job: "J1", post: "channel" as const };
  const bodyClaims = async (res: Response) => {
    const v = verifyJobToken(((await res.json()) as { jobToken: string }).jobToken, { graceSec: Number.MAX_SAFE_INTEGER });
    if (!v.ok) throw new Error(v.reason);
    return v.claims;
  };

  test("token refresh", async () => {
    const res = await handleTokenRefresh(new Request("http://gw/", { method: "POST", headers: { [JOB_HEADER]: mintJobToken(CLAIMS) } }), "J1");
    expect(res.status).toBe(200);
    expect((await bodyClaims(res)).post).toBe("channel");
  });

  test("token reissue", async () => {
    const now = Date.now();
    const token = mintJobToken(CLAIMS, { now: now - 3 * 3600_000, ttlSec: 60 });
    const claims = verifyJobToken(token, { graceSec: Number.MAX_SAFE_INTEGER });
    if (!claims.ok) throw new Error(claims.reason);
    const res = await handleTokenReissue(
      new Request("http://gw/", { method: "POST", headers: { [JOB_HEADER]: token }, body: "{}" }),
      "J1",
      claims.claims,
      async () => ({ data: { jobToken: token, enqueuedAt: now - 3600_000 }, timestamp: now - 3600_000, state: "waiting" }),
      now,
    );
    expect(res.status).toBe(200);
    expect((await bodyClaims(res)).post).toBe("channel");
  });
});

describe("the merge rule", () => {
  const job = (over: Partial<JobClaims>): TurnJob =>
    ({
      sessionId: "S-cs", tenantId: "default", personaId: "default", label: "default", messages: [], enqueuedAt: 1,
      jobToken: mintJobToken({ tenant: "default", persona: "default", session: "S-cs", team: "T1", channel: "C1", thread: "1.1", initiator: "U1", scope: "turn", origin: "slack", ...over }),
    }) as unknown as TurnJob;

  test("a root turn never merges with a turn that replies in a thread", () => {
    expect(sameTurnKind(job({ post: "channel" }), job({}))).toBe(false);
    expect(sameTurnKind(job({}), job({ post: "channel" }))).toBe(false);
  });

  test("two root turns still merge, as do two ordinary turns", () => {
    expect(sameTurnKind(job({ post: "channel", thread: "1.1" }), job({ post: "channel", thread: "2.2" }))).toBe(true);
    expect(sameTurnKind(job({}), job({}))).toBe(true);
  });
});

describe("the /v1 tool plane", () => {
  let h: GatewayHandle | undefined;
  const posts: any[] = [];

  function gateway(): GatewayHandle {
    posts.length = 0;
    const client: any = {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async (a: any) => (posts.push(a), { ok: true, ts: "9.9" }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    };
    const t: Transport = { client, action: () => {}, use: () => {}, start: async () => {}, stop: async () => {}, event: () => {} };
    h = createGateway(new AgentManager(), t);
    return h;
  }

  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  const claims = (over: Record<string, unknown>) =>
    ({ tenant: "default", persona: "default", session: "S-v1", team: "T", channel: "C_V1", thread: "1.0", initiator: WORLD.manager, scope: "turn", ...over }) as Omit<JobClaims, "exp" | "iat">;

  const reply = async (g: GatewayHandle, server: string, over: Record<string, unknown>) => {
    const res = await g.fetchV1(
      new Request(`http://gw/v1/tools/${server}/reply`, {
        method: "POST",
        headers: { authorization: "Bearer cs-node-token", [JOB_HEADER]: mintJobToken(claims(over)) },
        body: JSON.stringify({ text: "hello" }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.isError).toBeFalsy();
  };

  beforeEach(() => writeSoulFixture(WORLD));

  /** A node's bundle fetch over /v1. */
  const runtime = (g: GatewayHandle, path: string, over: Record<string, unknown>, caps?: string) =>
    g.fetchV1(
      new Request(`http://gw/v1/tenants/default/${path}`, {
        headers: {
          authorization: "Bearer cs-node-token",
          [JOB_HEADER]: mintJobToken(claims(over)),
          ...(caps === undefined ? {} : { [CAPABILITIES_HEADER]: caps }),
        },
      }),
    );

  for (const path of ["personas/default/runtime", "runtime"]) {
    describe(`the runtime bundle at ${path}`, () => {
      test("a node without the capability is refused a channel session job, and cannot retry it", async () => {
        const res = (await runtime(gateway(), path, { post: "channel" }, "guardrails/1,agent-definition/1"))!;
        expect(res.status).toBe(409);
        const text = await res.text();
        expect(JSON.parse(text)).toMatchObject({ code: "GUARDRAILS_UNSUPPORTED", transient: false });
        // Read by an older node's own parser, which knows no newer code.
        const f = bundleFetchFailure(new NodeApiError(res.status, text));
        expect(f).toBeInstanceOf(BootFailure);
        expect(f.code).toBe("GUARDRAILS_UNSUPPORTED");
        expect(f.transient).toBe(false);
      });

      test("no capabilities header at all is refused too", async () => {
        expect((await runtime(gateway(), path, { post: "channel" }))!.status).toBe(409);
      });

      test("a node with the capability gets the bundle", async () => {
        expect((await runtime(gateway(), path, { post: "channel" }, `guardrails/1,${CHANNEL_SESSION_CAPABILITY}`))!.status).toBe(200);
      });

      test("a job off a channel session is not gated on it", async () => {
        expect((await runtime(gateway(), path, {}, "guardrails/1"))!.status).toBe(200);
      });
    });
  }

  test("the refusal is audited under the existing action, naming the capability", async () => {
    await db.run("DELETE FROM audit_events WHERE action = 'guardrail.node.unsupported'");
    await runtime(gateway(), "personas/default/runtime", { post: "channel" }, "guardrails/1");
    await flushAudits();
    const rows = await db.query<{ session_id: string; summary: string; details: string }>(`SELECT session_id, summary, details FROM audit_events WHERE action = 'guardrail.node.unsupported'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe("S-v1");
    expect(rows[0]!.summary).toBe("a node without the channel-session/1 capability asked for a channel session job; refused");
    expect(rows[0]!.details).toContain("channel-session/1");
  });

  test("post: channel yields a channel-targeted context", () => {
    expect(gateway().__v1SlackCtx!(claims({ post: "channel", exp: 9e9 }) as JobClaims).postTarget).toBe("channel");
  });

  test("no claim, or any other value, leaves the context on its thread", () => {
    const g = gateway();
    expect(g.__v1SlackCtx!(claims({ exp: 9e9 }) as JobClaims).postTarget).toBeUndefined();
    expect(g.__v1SlackCtx!(claims({ post: "thread", exp: 9e9 }) as JobClaims).postTarget).toBeUndefined();
    expect(g.__v1SlackCtx!(claims({ post: "CHANNEL", exp: 9e9 }) as JobClaims).postTarget).toBeUndefined();
  });

  for (const server of ["slack", "surface"]) {
    test(`a ${server} reply through /v1 reaches channel root`, async () => {
      const g = gateway();
      await reply(g, server, { post: "channel" });
      expect(posts).toHaveLength(1);
      expect(posts[0].channel).toBe("C_V1");
      expect(posts[0].thread_ts).toBeUndefined();
    });

    test(`a ${server} reply through /v1 with no claim stays in its thread`, async () => {
      const g = gateway();
      await reply(g, server, {});
      expect(posts[0].thread_ts).toBe("1.0");
    });

    test(`a ${server} reply through /v1 with another claim value stays in its thread`, async () => {
      const g = gateway();
      await reply(g, server, { post: "thread" });
      expect(posts[0].thread_ts).toBe("1.0");
    });
  }
});
