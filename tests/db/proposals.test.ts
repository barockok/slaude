import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Proposals from "../../src/db/proposals";

const T0 = Date.parse("2026-10-26T00:00:00Z");
const add = (over: Partial<Parameters<typeof Proposals.insert>[0]> = {}) =>
  Proposals.insert({ agentId: "a1", kind: "team-fact", toKind: "manager", toUser: null, scope: "agent", payload: { slug: "shared/x" }, createdAt: T0, ...over });

beforeEach(async () => {
  await db.run("DELETE FROM proposals");
});

describe("proposals repo", () => {
  test("insert round-trips, open with a 14-day expiry", async () => {
    const id = await add({ payload: { slug: "shared/x", n: 2, nested: { a: [1] } } });
    expect(await Proposals.get(id)).toEqual({
      id, agentId: "a1", kind: "team-fact", toKind: "manager", toUser: null, scope: "agent",
      payload: { slug: "shared/x", n: 2, nested: { a: [1] } },
      createdAt: T0, expiresAt: T0 + Proposals.PROPOSAL_TTL_MS, status: "open", decidedBy: null, decidedAt: null,
    });
    expect(Proposals.PROPOSAL_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  test("listOpen filters by agent, audience and person", async () => {
    const m = await add();
    const p = await add({ toKind: "person", toUser: "U0ALICE", scope: "user:U0ALICE", kind: "promote" });
    await add({ toKind: "person", toUser: "U0BOB", scope: "user:U0BOB" });
    await add({ agentId: "a2" });
    expect((await Proposals.listOpen("a1", "manager")).map((x) => x.id)).toEqual([m]);
    expect((await Proposals.listOpen("a1", "person", "U0ALICE")).map((x) => x.id)).toEqual([p]);
  });

  test("decide settles an open proposal once", async () => {
    const id = await add();
    expect(await Proposals.decide(id, "approved", "U0MGR", T0 + 5)).toBe(true);
    expect(await Proposals.decide(id, "rejected", "U0MGR", T0 + 6)).toBe(false);
    expect(await Proposals.get(id)).toMatchObject({ status: "approved", decidedBy: "U0MGR", decidedAt: T0 + 5 });
    expect(await Proposals.listOpen("a1", "manager")).toEqual([]);
  });

  test("expireDue expires only open rows past expires_at", async () => {
    const old = await add();
    const fresh = await add({ createdAt: T0 + 1000 });
    const decided = await add();
    await Proposals.decide(decided, "rejected", "U0MGR", T0);
    expect(await Proposals.expireDue(T0 + Proposals.PROPOSAL_TTL_MS)).toBe(1);
    expect((await Proposals.get(old))!.status).toBe("expired");
    expect((await Proposals.get(fresh))!.status).toBe("open");
    expect((await Proposals.get(decided))!.status).toBe("rejected");
    expect(await Proposals.decide(old, "approved", "U0MGR", T0)).toBe(false);
  });
});
