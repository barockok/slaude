import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { verifyJobToken, mintJobToken } from "../../../src/gateway/api/auth";
import { handleTokenRefresh } from "../../../src/gateway/api/jobs";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";
import type { SessionRow } from "../../../src/db/schema";
import * as OneOnOne from "../../../src/db/one-on-one";
import * as Remote from "../../../src/db/remote";
import { sessionConfigFp } from "../../../src/remote/fingerprint";

function harness(lockOwner: string | undefined | Error) {
  const enqueued: any[] = [];
  const lookups: Array<[string, string | null | undefined, string | null | undefined]> = [];
  const agent = {
    emit: () => false,
    resolveEffectiveIdentity: async (sessionId: string, channel?: string | null, thread?: string | null) => {
      lookups.push([sessionId, channel, thread]);
      if (lockOwner instanceof Error) throw lockOwner;
      return lockOwner;
    },
  };
  const dispatch = makeQueueDispatch(agent as any, {
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
  const claims = () => {
    const v = verifyJobToken(enqueued[0].jobToken);
    if (!v.ok) throw new Error(`token did not verify: ${v.reason}`);
    return v.claims;
  };
  return { enqueued, dispatch, claims, lookups };
}

const META = { teamId: "TTESTTEAM1", channelId: "C1", threadTs: "1.1", eventTs: "1.1" };
const SESSION = { id: "S1" } as unknown as SessionRow;

describe("dispatch remote claims", () => {
  beforeEach(async () => {
    process.env.SLAUDE_JOB_SECRET = "test-secret";
    process.env.SLAUDE_REMOTE = "1";
    await OneOnOne._wipeForTests();
    await Remote._wipeForTests();
  });
  afterEach(() => { delete process.env.SLAUDE_REMOTE; });

  it("adds remote + fp when the target belongs to the lock owner", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.1", lockedUser: "UTESTA", createdBy: "UTESTA" });
    await Remote.setTarget({ channelId: "C1", threadTs: "1.1", teamId: "TTESTTEAM1", userId: "UTESTA", addr: "tcA", dir: "/r", lockByRemote: true });
    const h = harness("UTESTA");
    await h.dispatch.dispatch(SESSION, "hi", { ...META, userId: "UTESTA" });
    expect(h.claims().runAs).toBe("user:UTESTA");
    expect(h.claims().remote).toEqual({ addr: "tcA", dir: "/r" });
    expect(h.claims().sessionConfigFp).toBe(sessionConfigFp("UTESTA", { addr: "tcA", dir: "/r" }));
    await h.dispatch.close();
  });

  it("no remote claim when the lock moved to someone else; fp still minted", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.1", lockedUser: "UTESTMGR", createdBy: "UTESTMGR" });
    await Remote.setTarget({ channelId: "C1", threadTs: "1.1", teamId: "TTESTTEAM1", userId: "UTESTA", addr: "tcA", dir: "/r", lockByRemote: true });
    const h = harness("UTESTMGR");
    await h.dispatch.dispatch(SESSION, "hi", { ...META, userId: "UTESTMGR" });
    expect(h.claims().remote).toBeUndefined();
    expect(h.claims().sessionConfigFp).toBe(sessionConfigFp("UTESTMGR", null));
    await h.dispatch.close();
  });

  it("an ordinary (agent) thread gets no remote claim", async () => {
    const h = harness(undefined);
    await h.dispatch.dispatch(SESSION, "hi", { ...META, userId: "UTESTA" });
    expect(h.claims().remote).toBeUndefined();
    expect(h.claims().sessionConfigFp).toBe(sessionConfigFp(null, null));
    await h.dispatch.close();
  });

  it("flag off: neither claim", async () => {
    delete process.env.SLAUDE_REMOTE;
    const h = harness("UTESTA");
    await h.dispatch.dispatch(SESSION, "hi", { ...META, userId: "UTESTA" });
    expect(h.claims().remote).toBeUndefined();
    expect(h.claims().sessionConfigFp).toBeUndefined();
    await h.dispatch.close();
  });

  test("a refreshed job token keeps remote and sessionConfigFp", async () => {
    process.env.SLAUDE_NODE_TOKEN = "node-bearer";
    const original = mintJobToken({
      tenant: "t1", persona: "default", session: "S1", team: "T", channel: "C", thread: "1",
      initiator: "UTESTA", scope: "turn", job: "J9", runAs: "user:UTESTA",
      remote: { addr: "tcA", dir: "/r" }, sessionConfigFp: "fp1",
    });
    const res = await handleTokenRefresh(
      new Request("https://gw/v1/jobs/J9/token-refresh", { method: "POST", headers: { "x-slaude-job": original } }),
      "J9",
    );
    const { jobToken } = (await res.json()) as { jobToken: string };
    const v = verifyJobToken(jobToken);
    expect(v.ok && v.claims.remote).toEqual({ addr: "tcA", dir: "/r" });
    expect(v.ok && v.claims.sessionConfigFp).toBe("fp1");
  });
});
