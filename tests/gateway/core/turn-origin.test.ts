/**
 * What started a turn (phase C §8.3b): only a person's Slack message or the
 * panel is interactive. Nodes learn it from the signed `origin` claim, set at
 * dispatch from the path that queued the turn; mono reads it from the route.
 * An absent claim (a token from an older gateway) reads as not interactive.
 * The brain gate also carries the turn's Slack team, which keys the speaker's
 * profile source.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createGateway, cronDispatchMeta, panelDispatchMeta, type GatewayHandle } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import type { DispatchMeta, QueueDispatch } from "../../../src/gateway/core/dispatch";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";
import type { SessionRow } from "../../../src/db/schema";
import { db } from "../../../src/db/schema";
import * as CronJobs from "../../../src/db/cron-jobs";
import { mintJobToken, verifyJobToken, type JobClaims } from "../../../src/gateway/api/auth";
import { isInteractiveOrigin } from "../../../src/knowledge/gated-dispatch";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";

const SECRET_ENV = process.env.SLAUDE_JOB_SECRET;
beforeEach(async () => {
  process.env.SLAUDE_JOB_SECRET = "turn-origin-secret";
  await db.run("DELETE FROM sessions");
  await db.run("DELETE FROM seen_events");
  await db.run("DELETE FROM cron_jobs");
  writeSoulFixture(WORLD);
});
afterEach(async () => {
  await db.run("DELETE FROM cron_jobs");
  if (SECRET_ENV === undefined) delete process.env.SLAUDE_JOB_SECRET;
  else process.env.SLAUDE_JOB_SECRET = SECRET_ENV;
});

function transport() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const client: any = {
    auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
    chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  };
  const t: Transport = {
    client,
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => void handlers.set(name, fn),
  };
  const dm = (ts: string) =>
    handlers.get("message")!({
      event: { type: "message", channel: "D_MGR", channel_type: "im", user: WORLD.manager, team: "T", ts, text: "hello" },
      client,
      context: { teamId: "T" },
    });
  return { t, dm };
}

/** A queue dispatch that records each DispatchMeta instead of enqueueing. */
function recordingDispatch(): { qd: QueueDispatch; metas: DispatchMeta[] } {
  const metas: DispatchMeta[] = [];
  const qd = {
    dispatch: async (_s: SessionRow, _text: string, meta: DispatchMeta) => void metas.push(meta),
    abort: async () => {},
    pubsub: { close: async () => {} },
    turns: { close: async () => {} },
    registry: { close: async () => {}, liveLabels: async () => [] },
    close: async () => {},
  } as unknown as QueueDispatch;
  return { qd, metas };
}

const waitFor = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

describe("isInteractiveOrigin", () => {
  test("slack and panel are interactive; cron, absent and unknown are not", () => {
    expect(isInteractiveOrigin("slack")).toBe(true);
    expect(isInteractiveOrigin("panel")).toBe(true);
    for (const o of ["cron", undefined, null, "", "SLACK", "agent"]) expect(isInteractiveOrigin(o)).toBe(false);
  });
});

describe("dispatch signs the turn's origin into the job token", () => {
  function harness() {
    const enqueued: any[] = [];
    const agent = { emit: () => false, resolveEffectiveIdentity: async () => undefined };
    const dispatch = makeQueueDispatch(agent as any, {
      infra: {
        turns: { enqueueTurn: async (job: any) => (enqueued.push(job), { queue: "turns", jobId: "J1", coalesced: false }), close: async () => {} } as any,
        registry: { lookup: async () => null, close: async () => {} } as any,
        pubsub: {
          consumeAbortFlag: async () => null, lastEventId: async () => null, appendEvent: async () => {},
          readEvents: async () => [], close: async () => {},
        } as any,
      },
    });
    const claims = () => {
      const v = verifyJobToken(enqueued.at(-1).jobToken);
      if (!v.ok) throw new Error(v.reason);
      return v.claims;
    };
    return { dispatch, claims };
  }
  const META = { teamId: "T0TEAM", channelId: "C1", threadTs: "1.1", eventTs: "1.1", userId: "U0ALICE" };
  const SESSION = { id: "S1" } as unknown as SessionRow;

  for (const origin of ["slack", "panel", "cron"] as const) {
    test(`origin ${origin} rides the token`, async () => {
      const h = harness();
      await h.dispatch.dispatch(SESSION, "hi", { ...META, origin });
      expect(h.claims().origin).toBe(origin);
      await h.dispatch.close();
    });
  }
  test("no origin in the meta: no claim (read as not interactive)", async () => {
    const h = harness();
    await h.dispatch.dispatch(SESSION, "hi", META);
    expect("origin" in h.claims()).toBe(false);
    await h.dispatch.close();
  });
});

describe("gateway role: every dispatch path names its origin", () => {
  let h: GatewayHandle | null = null;
  afterEach(async () => {
    await h?.stop();
    h = null;
  });

  test("a Slack message dispatches as slack", async () => {
    const { qd, metas } = recordingDispatch();
    const { t, dm } = transport();
    h = createGateway(new AgentManager(), t, { queueDispatch: qd });
    await dm("930.1");
    await waitFor(() => metas.length > 0);
    expect(metas.map((m) => m.origin)).toEqual(["slack"]);
  });

  test("a cron run dispatches as cron, as the job's creator", async () => {
    const job = await CronJobs.create({
      slackTeamId: "T", slackChannelId: "C0TEAM", slackThreadTs: "T-CRON-Q", channelId: "C0TEAM",
      createdBy: "U0MEMBER", cronExpr: "* * * * *", prompt: "tick", nextRunAt: Date.now() + 60_000, target: "thread",
    });
    const meta = cronDispatchMeta(job, "T-CRON-Q", "5.0");
    expect(meta).toMatchObject({ origin: "cron", userId: "U0MEMBER", teamId: "T", threadTs: "T-CRON-Q" });
  });

  test("a panel turn dispatches as panel", () => {
    const row = { id: "S1", slack_team_id: "T", slack_channel_id: "C1", slack_thread_ts: "1.0", persona_id: "default" } as SessionRow;
    expect(panelDispatchMeta(row, "op", "2.0").origin).toBe("panel");
  });
});

describe("node turns: the brain gate reads team and origin from the signed claims", () => {
  let h: GatewayHandle | null = null;
  afterEach(async () => {
    await h?.stop();
    h = null;
  });
  const claimsWith = (over: Partial<JobClaims>): JobClaims => {
    const v = verifyJobToken(mintJobToken({
      tenant: "default", persona: "default", session: "S-node", team: "T0TEAM", channel: "C0TEAM", thread: "1.0",
      initiator: "U0ALICE", scope: "turn", ...over,
    }));
    if (!v.ok) throw new Error(v.reason);
    return v.claims;
  };

  test("slack and panel claims are interactive; cron and an absent claim are not", async () => {
    const { t } = transport();
    h = createGateway(new AgentManager(), t);
    const gate = (o: Partial<JobClaims>) => h!.__brainGateForClaims!(claimsWith(o));
    expect(await gate({ origin: "slack" })).toMatchObject({ interactive: true, teamId: "T0TEAM", userId: "U0ALICE" });
    expect((await gate({ origin: "panel" })).interactive).toBe(true);
    expect((await gate({ origin: "cron" })).interactive).toBe(false);
    expect((await gate({})).interactive).toBe(false);
  });
});
