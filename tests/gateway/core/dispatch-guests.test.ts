import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { verifyJobToken } from "../../../src/gateway/api/auth";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";
import { sessionConfigFp } from "../../../src/remote/fingerprint";
import { lockFromClaims } from "../../../src/node/session-lock";
import type { SessionRow } from "../../../src/db/schema";
import * as OneOnOne from "../../../src/db/one-on-one";

/**
 * /1on1 named guests on the queue path: the gateway decides per message
 * whether it is a guest's (the flag rides on the message, because a message
 * that coalesces into a waiting job keeps that job's token), and signs the
 * guests into the lock claim so a warm node session reboots with them listed.
 */
function harness() {
  const enqueued: any[] = [];
  const agent = {
    emit: () => false,
    resolveEffectiveIdentity: async (_s: string, c?: string | null, t?: string | null) =>
      c && t ? (await OneOnOne.find(c, t))?.locked_user : undefined,
  };
  const dispatch = makeQueueDispatch(agent as any, {
    infra: {
      turns: {
        enqueueTurn: async (job: any) => {
          enqueued.push(job);
          return { queue: "turns", jobId: `J${enqueued.length}`, coalesced: false };
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
  const claims = (i: number) => {
    const v = verifyJobToken(enqueued[i].jobToken);
    if (!v.ok) throw new Error(`token did not verify: ${v.reason}`);
    return v.claims;
  };
  return { enqueued, dispatch, claims };
}

const META = { teamId: "TTESTTEAM1", channelId: "CG1", threadTs: "7.1", eventTs: "7.2" };
const SESSION = { id: "SG1" } as unknown as SessionRow;

describe("dispatch with named guests", () => {
  beforeEach(async () => {
    process.env.SLAUDE_JOB_SECRET = "test-secret";
    await OneOnOne._wipeForTests();
    await OneOnOne.lock({ channelId: "CG1", threadTs: "7.1", lockedUser: "U0OWNER", createdBy: "U0OWNER" });
  });
  afterEach(() => OneOnOne._wipeForTests());

  test("a guest's message carries guest:true; runAs stays the owner; guests ride the lock claim", async () => {
    await OneOnOne.setGuests("CG1", "7.1", ["U0QA"]);
    const h = harness();
    await h.dispatch.dispatch(SESSION, "run tests", { ...META, userId: "U0QA", guest: true });
    expect(h.enqueued[0].messages[0]).toMatchObject({ user: "U0QA", guest: true });
    const c = h.claims(0);
    expect(c.runAs).toBe("user:U0OWNER");
    expect(c.initiator).toBe("U0QA");
    expect(c.lock).toEqual({ user: "U0OWNER", openScope: null, guests: ["U0QA"] });
    // The node reads the guests back for its session-mode block.
    const store = { tokenFor: () => h.enqueued[0].jobToken };
    expect(lockFromClaims(store, "SG1")?.guests).toEqual(["U0QA"]);
    await h.dispatch.close();
  });

  test("the owner's message carries no flag; a lock without guests signs no guests field", async () => {
    const h = harness();
    await h.dispatch.dispatch(SESSION, "hi", { ...META, userId: "U0OWNER" });
    expect(h.enqueued[0].messages[0]).not.toHaveProperty("guest");
    expect(h.claims(0).lock).toEqual({ user: "U0OWNER", openScope: null });
    expect(lockFromClaims({ tokenFor: () => h.enqueued[0].jobToken }, "SG1")).not.toHaveProperty("guests");
    await h.dispatch.close();
  });

  test("inviting a guest changes the session-config fingerprint; no guests keeps the old one", async () => {
    const h = harness();
    await h.dispatch.dispatch(SESSION, "a", { ...META, userId: "U0OWNER" });
    await OneOnOne.setGuests("CG1", "7.1", ["U0QA"]);
    await h.dispatch.dispatch(SESSION, "b", { ...META, userId: "U0OWNER", eventTs: "7.3" });
    expect(h.claims(0).sessionConfigFp).not.toBe(h.claims(1).sessionConfigFp);
    // Unchanged for every lock without guests (existing warm sessions do not reboot).
    const lock = { user: "U0OWNER", openScope: null };
    expect(sessionConfigFp({ runAs: "U0OWNER", lock, remote: null })).toBe(
      sessionConfigFp({ runAs: "U0OWNER", lock: { ...lock, guests: [] }, remote: null }),
    );
    await h.dispatch.close();
  });
});
