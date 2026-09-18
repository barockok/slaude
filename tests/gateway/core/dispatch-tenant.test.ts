import { beforeEach, describe, expect, test } from "bun:test";
import { verifyJobToken } from "../../../src/gateway/api/auth";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";
import type { SessionRow } from "../../../src/db/schema";

/**
 * The tenant was hardcoded to "default" in both the enqueued job and the job
 * token, so `slack_apps.tenant_id` was stored and never reached the execution
 * path — the tenancy schema was inert. These pin the resolution order:
 * explicit meta, then the session row's column (Postgres only), then "default".
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
        // dispatch() captures the follower's cursor before enqueueing (#118).
        lastEventId: async () => null,
        appendEvent: async () => {},
        readEvents: async () => [],
        close: async () => {},
      } as any,
    },
  });
  return { enqueued, dispatch };
}

const META = {
  teamId: "T1",
  channelId: "C1",
  threadTs: "1.1",
  eventTs: "1.1",
  userId: "UTESTUSER1",
};

describe("dispatch tenant propagation", () => {
  beforeEach(() => {
    process.env.SLAUDE_JOB_SECRET = "test-secret";
  });

  test("an explicit meta tenant reaches the job and the job token", async () => {
    const { enqueued, dispatch } = harness();

    await dispatch.dispatch({ id: "S1" } as unknown as SessionRow, "hello", { ...META, tenantId: "tenant-one" });

    expect(enqueued[0].tenantId).toBe("tenant-one");
    const verified = verifyJobToken(enqueued[0].jobToken);
    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.claims.tenant).toBe("tenant-one");
    await dispatch.close();
  });

  test("the session row's tenant is used when meta omits one", async () => {
    const { enqueued, dispatch } = harness();

    await dispatch.dispatch({ id: "S1", tenant_id: "tenant-two" } as unknown as SessionRow, "hello", META);

    expect(enqueued[0].tenantId).toBe("tenant-two");
    await dispatch.close();
  });

  test("meta wins over the session row", async () => {
    const { enqueued, dispatch } = harness();

    await dispatch.dispatch({ id: "S1", tenant_id: "tenant-two" } as unknown as SessionRow, "hello", {
      ...META,
      tenantId: "tenant-one",
    });

    expect(enqueued[0].tenantId).toBe("tenant-one");
    await dispatch.close();
  });

  test("falls back to the default tenant when neither carries one", async () => {
    const { enqueued, dispatch } = harness();

    await dispatch.dispatch({ id: "S1" } as unknown as SessionRow, "hello", META);

    expect(enqueued[0].tenantId).toBe("default");
    const verified = verifyJobToken(enqueued[0].jobToken);
    expect(verified.ok && verified.claims.tenant).toBe("default");
    await dispatch.close();
  });

  // A cron job created inside a /1on1 carries the lock owner. The turn runs on a
  // node, so the identity has to travel with the job: the node has no other way
  // to know it (the cron session's thread is synthetic and carries no lock).
  test("an explicit oauth user rides with the job", async () => {
    const { enqueued, dispatch } = harness();

    await dispatch.dispatch({ id: "S1" } as unknown as SessionRow, "[scheduled] work", {
      ...META,
      oauthUser: "UTESTOWNER1",
    });

    expect(enqueued[0].oauthUser).toBe("UTESTOWNER1");
    await dispatch.close();
  });

  test("no oauth user means the field is absent, not empty", async () => {
    const { enqueued, dispatch } = harness();

    await dispatch.dispatch({ id: "S1" } as unknown as SessionRow, "hello", META);

    expect(enqueued[0].oauthUser).toBeUndefined();
    await dispatch.close();
  });

  test("the persona still rides alongside the tenant", async () => {
    const { enqueued, dispatch } = harness();

    await dispatch.dispatch({ id: "S1", tenant_id: "tenant-two" } as unknown as SessionRow, "hello", {
      ...META,
      personaId: "aria",
    });

    expect(enqueued[0].personaId).toBe("aria");
    const verified = verifyJobToken(enqueued[0].jobToken);
    expect(verified.ok && verified.claims.persona).toBe("aria");
    expect(verified.ok && verified.claims.tenant).toBe("tenant-two");
    await dispatch.close();
  });
});
