import { beforeEach, describe, expect, test } from "bun:test";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import { metrics } from "../../src/metrics";
import { ActorResolveError, actingUser, invalidateActors, sameUser, slackIdsFor } from "../../src/refs/actor";

const T1 = "T0EXAMPLE";
const T2 = "T0OTHER";

async function slack(team: string, id: string, state: Domain.State, userId?: string) {
  return Domain.ensureBinding({ service: "slack", kind: "user", workspace: team, value: id, state, source: "test", userId });
}
const mail = (address: string, state: Domain.State, userId: string) =>
  Domain.ensureBinding({ service: "email", kind: "address", workspace: "", value: address, state, source: "test", userId });

function counter(name: string, labels?: string): number {
  const line = metrics.render().split("\n").find((l) => l.startsWith(name) && (labels ? l.includes(labels) : true));
  return line ? Number(line.split(" ").pop()) : 0;
}

beforeEach(async () => {
  await Domain._wipeForTests();
  invalidateActors();
});

describe("actingUser", () => {
  test("an unseen id gives null", async () => {
    expect(await actingUser(T1, "U0EXAMPLE")).toBeNull();
  });

  test("an observed binding", async () => {
    const r = await slack(T1, "U0EXAMPLE", "observed");
    const a = await actingUser(T1, "U0EXAMPLE");
    expect(a?.userId).toBe(r.userId);
    expect(a?.slackBinding).toEqual({ id: r.binding.id, state: "observed" });
    expect(a?.verified).toBe(false);
    expect(a?.emails).toEqual([]);
  });

  test("a verified binding with a verified and an observed email, never a declared one", async () => {
    const r = await slack(T1, "U0EXAMPLE", "verified");
    await mail("a@example.com", "verified", r.userId);
    await mail("b@example.com", "observed", r.userId);
    await mail("c@example.com", "declared", r.userId);
    const a = await actingUser(T1, "U0EXAMPLE");
    expect(a?.verified).toBe(true);
    expect([...a!.emails].sort((x, y) => x.address.localeCompare(y.address))).toEqual([
      { address: "a@example.com", verified: true },
      { address: "b@example.com", verified: false },
    ]);
  });

  test("the same U id in two workspaces is two users", async () => {
    const a = await slack(T1, "U0EXAMPLE", "observed");
    const b = await slack(T2, "U0EXAMPLE", "observed");
    expect((await actingUser(T1, "U0EXAMPLE"))?.userId).toBe(a.userId);
    expect((await actingUser(T2, "U0EXAMPLE"))?.userId).toBe(b.userId);
    expect(a.userId).not.toBe(b.userId);
  });

  test("an alias to an old id resolves to the live user", async () => {
    const live = await slack(T1, "U0EXAMPLE", "verified");
    await db.run("INSERT INTO user_aliases (old_id, user_id, merged_at) VALUES (?, ?, ?)", ["old-user-id", live.userId, 1]);
    expect(await slackIdsFor("old-user-id", T1)).toEqual(["U0EXAMPLE"]);
  });

  test("a database error throws ActorResolveError and counts a failure", async () => {
    const before = counter("slaude_actor_resolve_failures_total");
    const broken = { dialect: "sqlite", one: async () => { throw new Error("boom"); }, query: async () => { throw new Error("boom"); } } as never;
    await expect(actingUser(T1, "U0EXAMPLE", { tx: broken })).rejects.toBeInstanceOf(ActorResolveError);
    expect(counter("slaude_actor_resolve_failures_total")).toBe(before + 1);
  });
});

describe("actingUser cache", () => {
  test("a hit is served from the cache for ordinary checks, fresh reads the database", async () => {
    await slack(T1, "U0EXAMPLE", "observed");
    expect((await actingUser(T1, "U0EXAMPLE"))?.verified).toBe(false);
    await Domain.ensureBinding({ service: "slack", kind: "user", workspace: T1, value: "U0EXAMPLE", state: "verified", source: "test" });
    expect((await actingUser(T1, "U0EXAMPLE"))?.verified).toBe(false); // stale, within 5 s
    expect((await actingUser(T1, "U0EXAMPLE", { fresh: true }))?.verified).toBe(true);
  });

  test("invalidation drops the cache", async () => {
    await slack(T1, "U0EXAMPLE", "observed");
    await actingUser(T1, "U0EXAMPLE");
    await Domain.ensureBinding({ service: "slack", kind: "user", workspace: T1, value: "U0EXAMPLE", state: "verified", source: "test" });
    invalidateActors();
    expect((await actingUser(T1, "U0EXAMPLE"))?.verified).toBe(true);
  });

  test("the cache expires after 5 s", async () => {
    await slack(T1, "U0EXAMPLE", "observed");
    const realNow = Date.now;
    try {
      let t = 1_000_000;
      Date.now = () => t;
      await actingUser(T1, "U0EXAMPLE");
      await Domain.ensureBinding({ service: "slack", kind: "user", workspace: T1, value: "U0EXAMPLE", state: "verified", source: "test" });
      t += 4_900;
      expect((await actingUser(T1, "U0EXAMPLE"))?.verified).toBe(false);
      t += 200;
      expect((await actingUser(T1, "U0EXAMPLE"))?.verified).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  test("null is not cached", async () => {
    expect(await actingUser(T1, "U0EXAMPLE")).toBeNull();
    await slack(T1, "U0EXAMPLE", "observed");
    expect(await actingUser(T1, "U0EXAMPLE")).not.toBeNull();
  });

  test("a fresh read refreshes the cache", async () => {
    await slack(T1, "U0EXAMPLE", "observed");
    await actingUser(T1, "U0EXAMPLE");
    await Domain.ensureBinding({ service: "slack", kind: "user", workspace: T1, value: "U0EXAMPLE", state: "verified", source: "test" });
    await actingUser(T1, "U0EXAMPLE", { fresh: true });
    expect((await actingUser(T1, "U0EXAMPLE"))?.verified).toBe(true);
  });
});

describe("slackIdsFor", () => {
  test("lists the user's non-declared Slack ids in that workspace, verified first", async () => {
    const a = await slack(T1, "U0EXAMPLE", "observed");
    await slack(T1, "U0SECOND", "verified", a.userId);
    await slack(T1, "U0DECLARED", "declared", a.userId);
    await slack(T2, "U0ELSEWHERE", "verified", a.userId);
    expect(await slackIdsFor(a.userId, T1)).toEqual(["U0SECOND", "U0EXAMPLE"]);
    expect(await slackIdsFor(a.userId, T2)).toEqual(["U0ELSEWHERE"]);
  });

  test("an unknown user has none", async () => {
    expect(await slackIdsFor("missing", T1)).toEqual([]);
  });
});

describe("sameUser (Rule G)", () => {
  const k = (id: string, team = T1) => ({ teamId: team, slackUserId: id });

  test("the same binding is the same person, seen or not", async () => {
    expect(await sameUser(k("U0EXAMPLE"), k("U0EXAMPLE"))).toBe(true);
    await slack(T1, "U0EXAMPLE", "observed");
    expect(await sameUser(k("U0EXAMPLE"), k("U0EXAMPLE"))).toBe(true);
  });

  test("the same id in two workspaces is not the same person", async () => {
    await slack(T1, "U0EXAMPLE", "verified");
    await slack(T2, "U0EXAMPLE", "verified");
    expect(await sameUser(k("U0EXAMPLE", T1), k("U0EXAMPLE", T2))).toBe(false);
  });

  test("two verified bindings of one user are the same person", async () => {
    const a = await slack(T1, "U0EXAMPLE", "verified");
    await slack(T1, "U0SECOND", "verified", a.userId);
    expect(await sameUser(k("U0EXAMPLE"), k("U0SECOND"))).toBe(true);
  });

  test("an observed binding never joins a verified one", async () => {
    const a = await slack(T1, "U0EXAMPLE", "verified");
    await slack(T1, "U0SECOND", "observed", a.userId);
    expect(await sameUser(k("U0EXAMPLE"), k("U0SECOND"))).toBe(false);
    expect(await sameUser(k("U0SECOND"), k("U0EXAMPLE"))).toBe(false);
  });

  test("two observed bindings on one user are not the same person", async () => {
    const a = await slack(T1, "U0EXAMPLE", "observed");
    await slack(T1, "U0SECOND", "observed", a.userId);
    expect(await sameUser(k("U0EXAMPLE"), k("U0SECOND"))).toBe(false);
  });

  test("an unseen id is not the same person as another", async () => {
    await slack(T1, "U0EXAMPLE", "verified");
    expect(await sameUser(k("U0EXAMPLE"), k("U0UNSEEN"))).toBe(false);
  });

  test("it reads fresh: an unlink-like change shows at once", async () => {
    const a = await slack(T1, "U0EXAMPLE", "verified");
    await slack(T1, "U0SECOND", "verified", a.userId);
    expect(await sameUser(k("U0EXAMPLE"), k("U0SECOND"))).toBe(true);
    await db.run("DELETE FROM bindings WHERE value = ?", ["U0SECOND"]);
    expect(await sameUser(k("U0EXAMPLE"), k("U0SECOND"))).toBe(false);
  });
});

describe("metrics", () => {
  test("results are counted by label", async () => {
    await actingUser(T1, "U0EXAMPLE");
    await slack(T1, "U0EXAMPLE", "observed");
    await actingUser(T1, "U0EXAMPLE");
    await actingUser(T1, "U0EXAMPLE");
    const out = metrics.render();
    expect(out).toContain('slaude_actor_resolve_total{result="unseen"}');
    expect(out).toContain('slaude_actor_resolve_total{result="found"}');
    expect(out).toContain('slaude_actor_resolve_total{result="cached"}');
  });
});

describe("invalidation on identity changes", () => {
  test("link and unlink drop the cache", async () => {
    const Accounts = await import("../../src/db/accounts");
    const acct = await Accounts.upsertAccount({ issuer: "https://idp.example.com", subject: "sub-1", email: "a@example.com", emailProven: true });
    expect(await actingUser(T1, "U0EXAMPLE")).toBeNull();
    await Accounts.linkSlackIdentity({ teamId: T1, slackUserId: "U0EXAMPLE", accountId: acct.id, via: "test" });
    expect((await actingUser(T1, "U0EXAMPLE"))?.verified).toBe(true);
    await Accounts.unlinkSlackIdentity(T1, "U0EXAMPLE", acct.id);
    expect(await actingUser(T1, "U0EXAMPLE")).toBeNull();
    await Accounts._wipeForTests();
  });
});
