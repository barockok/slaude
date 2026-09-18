import { beforeEach, describe, expect, test } from "bun:test";
import { verifyJobToken, mintJobToken } from "../../../src/gateway/api/auth";
import { handleTokenRefresh } from "../../../src/gateway/api/jobs";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";
import { encodeRunAs, parseRunAs } from "../../../src/agent/credential-owner";
import type { SessionRow } from "../../../src/db/schema";

/**
 * Whose credentials a turn gets is decided once, at dispatch, and signed into
 * the job token as `runAs`. The existing `initiator` claim is NOT that answer:
 * it is whoever sent the message, which in a channel thread is a colleague
 * while the session runs as the agent. These pin that the two are separate and
 * that runAs follows the same rule the node uses (resolveEffectiveIdentity).
 */
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

describe("runAs at dispatch", () => {
  beforeEach(() => {
    process.env.SLAUDE_JOB_SECRET = "test-secret";
  });

  test("an ordinary thread runs as the agent, whoever sent the message", async () => {
    const h = harness(undefined);
    await h.dispatch.dispatch(SESSION, "hi", { ...META, userId: "UTESTUSER2" });
    expect(h.claims().runAs).toBe("agent");
    // initiator is unchanged, and it is not the owner.
    expect(h.claims().initiator).toBe("UTESTUSER2");
    await h.dispatch.close();
  });

  test("a thread locked to a person runs as the lock owner", async () => {
    const h = harness("UTESTUSER1");
    await h.dispatch.dispatch(SESSION, "hi", { ...META, userId: "UTESTUSER1" });
    expect(h.claims().runAs).toBe("user:UTESTUSER1");
    await h.dispatch.close();
  });

  test("the lock is resolved for this session's own channel and thread", async () => {
    const h = harness(undefined);
    await h.dispatch.dispatch(SESSION, "hi", { ...META, userId: "UTESTUSER2" });
    expect(h.lookups).toEqual([["S1", "C1", "1.1"]]);
    await h.dispatch.close();
  });

  // A cron job created in a 1:1 keys on a synthetic thread with no lock of its
  // own, so its carried identity must win over the (empty) lock lookup.
  test("a cron job created in a 1:1 runs as its carried identity", async () => {
    const h = harness(undefined);
    await h.dispatch.dispatch(SESSION, "hi", { ...META, userId: "UTESTUSER3", oauthUser: "UTESTUSER1" });
    expect(h.claims().runAs).toBe("user:UTESTUSER1");
    await h.dispatch.close();
  });

  // Failing open here would run a 1:1 turn as the agent, handing that person
  // the agent's shared credentials. Refuse the dispatch instead.
  test("a failed lock lookup fails the dispatch rather than defaulting to the agent", async () => {
    const h = harness(new Error("db down"));
    await expect(h.dispatch.dispatch(SESSION, "hi", { ...META, userId: "UTESTUSER1" })).rejects.toThrow();
    expect(h.enqueued).toHaveLength(0);
    await h.dispatch.close();
  });

  // Long turns refresh their token. A refreshed token that lost runAs would be
  // refused by the credential endpoint mid-turn.
  test("a refreshed job token keeps its runAs", async () => {
    process.env.SLAUDE_NODE_TOKEN = "node-bearer";
    const original = mintJobToken({
      tenant: "t1", persona: "default", session: "S1", team: "T", channel: "C", thread: "1",
      initiator: "UTESTUSER2", scope: "turn", job: "J9", runAs: "user:UTESTUSER1",
    });
    const res = await handleTokenRefresh(
      new Request("https://gw/v1/jobs/J9/token-refresh", { method: "POST", headers: { "x-slaude-job": original } }),
      "J9",
    );
    const { jobToken } = (await res.json()) as { jobToken: string };
    const v = verifyJobToken(jobToken);
    expect(v.ok && v.claims.runAs).toBe("user:UTESTUSER1");
  });
});

describe("runAs encoding", () => {
  test("round-trips both owners", () => {
    expect(parseRunAs(encodeRunAs(undefined))).toEqual({ kind: "agent" });
    expect(parseRunAs(encodeRunAs("UTESTUSER1"))).toEqual({ kind: "user", slackUserId: "UTESTUSER1" });
  });

  test("refuses anything it did not mint", () => {
    for (const bad of [undefined, null, "", "user:", "admin", "agent ", " agent", "user:a:b", 42, {}, "USER:UTESTUSER1"]) {
      expect(parseRunAs(bad)).toBeNull();
    }
  });
});
