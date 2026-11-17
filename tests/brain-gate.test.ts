import { describe, expect, test, beforeEach } from "bun:test";
import { classifyBrainOp, gatedBrainCall, resetStandingGrants, turnBrainScope, type GateInput } from "../src/knowledge/gated-dispatch";
import { agentSourceId, profileSourceId, resolveBrainScope, SHARED_SOURCE, userSourceId, type BrainScope } from "../src/knowledge/scope";

const gate = (over: Partial<GateInput> = {}): GateInput => ({
  userId: "U1", teamId: null, interactive: true, lockedUser: null, channelTrust: "trusted", isManager: false, agentId: "AGENT1", ...over,
});
const scopeFor = async (g: GateInput, kb: string[] = []) => (await resolveBrainScope({ ...g, kbSources: kb }));
// Explicit "shared" escalation — kb_memoize target:"shared" overrides sourceId.
const sharedScope = async (g: GateInput): Promise<BrainScope> => ({ ...(await scopeFor(g)), sourceId: SHARED_SOURCE });

describe("classifyBrainOp", () => {
  test("reads are auto everywhere", async () => {
    for (const op of ["search", "think", "get_page", "list_pages", "get_links", "get_backlinks", "query"]) {
      const g = gate({ channelTrust: "unknown" });
      expect((await classifyBrainOp(op, (await scopeFor(g)), g))).toBe("auto");
    }
  });
  test("agent turn writes are auto", async () => {
    const g = gate({ userId: null });
    expect((await classifyBrainOp("put_page", (await scopeFor(g)), g))).toBe("auto");
  });
  test("default write to the agent's own slice is auto (trusted channel)", async () => {
    const g = gate();
    expect((await classifyBrainOp("put_page", (await scopeFor(g)), g))).toBe("auto");
  });
  test("own-slice write in locked 1on1 is auto", async () => {
    const g = gate({ lockedUser: "U1" });
    expect((await classifyBrainOp("put_page", (await scopeFor(g)), g))).toBe("auto");
  });
  test("explicit shared write from a non-manager trusted channel needs approval", async () => {
    const g = gate();
    expect((await classifyBrainOp("put_page", (await sharedScope(g)), g))).toBe("approval");
  });
  test("explicit shared write from the manager still cards (common KB is approval-worthy)", async () => {
    const g = gate({ isManager: true });
    expect((await classifyBrainOp("put_page", (await sharedScope(g)), g))).toBe("approval");
  });
  test("write from public channel is denied", async () => {
    const g = gate({ channelTrust: "public" });
    expect((await classifyBrainOp("put_page", (await scopeFor(g)), g))).toBe("deny");
  });
  test("explicit shared write from a public channel non-manager is denied", async () => {
    const g = gate({ channelTrust: "public" });
    expect((await classifyBrainOp("put_page", (await sharedScope(g)), g))).toBe("deny");
  });
  test("deletes always need approval, even own slice", async () => {
    const g = gate({ lockedUser: "U1" });
    expect((await classifyBrainOp("delete_page", (await scopeFor(g)), g))).toBe("approval");
  });
  test("delete from public channel by non-manager is denied", async () => {
    const g = gate({ channelTrust: "public" });
    expect((await classifyBrainOp("delete_page", (await scopeFor(g)), g))).toBe("deny");
  });
  test("admin ops are manager tier", async () => {
    for (const op of ["purge_deleted_pages", "sources_add", "sources_remove", "sync_brain"]) {
      expect((await classifyBrainOp(op, (await scopeFor(gate())), gate()))).toBe("manager");
    }
  });
  test("unknown ops fail closed to manager", async () => {
    expect((await classifyBrainOp("run_skillopt", (await scopeFor(gate())), gate()))).toBe("manager");
  });
});

describe("classifyBrainOp — profile and /1on1 writes (phase C)", () => {
  const TEAM = "T0TEAM";
  const own = profileSourceId(TEAM, "U1");
  const profileScope = async (g: GateInput, source = own): Promise<BrainScope> => ({ ...(await scopeFor(g)), sourceId: source });
  const slackTurn = (over: Partial<GateInput> = {}) =>
    gate({ teamId: TEAM, interactive: true, origin: "slack", turnSenders: [{ userId: "U1", teamId: TEAM, origin: "slack" }], ...over });

  test("put_page into the speaker's own profile on their Slack turn is auto", async () => {
    const g = slackTurn();
    expect((await classifyBrainOp("put_page", (await profileScope(g)), g))).toBe("auto");
  });
  test("... even in a public channel and in someone else's /1on1", async () => {
    for (const g of [slackTurn({ channelTrust: "public" }), slackTurn({ lockedUser: "U2" })]) {
      expect((await classifyBrainOp("put_page", (await profileScope(g)), g))).toBe("auto");
    }
  });
  test("the same write is denied when the turn is not interactive", async () => {
    const g = slackTurn({ interactive: false, origin: "cron" });
    expect((await classifyBrainOp("put_page", (await profileScope(g)), g))).toBe("deny");
  });
  test("denied for a panel turn (an operator id is not a Slack id) and for an unknown origin", async () => {
    for (const g of [slackTurn({ origin: "panel" }), slackTurn({ origin: undefined })]) {
      expect((await classifyBrainOp("put_page", (await profileScope(g)), g))).toBe("deny");
    }
  });
  test("denied unless the turn holds exactly the speaker's own Slack messages", async () => {
    const u1 = { userId: "U1", teamId: TEAM, origin: "slack" };
    for (const turnSenders of [undefined, [], [u1, { userId: "U2", teamId: TEAM, origin: "slack" }], [{ ...u1, origin: "cron" }, u1], [{ ...u1, userId: "U2" }]]) {
      const g = slackTurn({ turnSenders });
      expect((await classifyBrainOp("put_page", (await profileScope(g)), g))).toBe("deny");
    }
  });
  test("the profile is the sole sender's, not the live ctx speaker's (mono: the ctx is whoever spoke last)", async () => {
    const g = slackTurn({ userId: "U1", turnSenders: [{ userId: "U2", teamId: TEAM, origin: "slack" }] });
    expect((await classifyBrainOp("put_page", (await profileScope(g, profileSourceId(TEAM, "U2"))), g))).toBe("auto");
    expect((await classifyBrainOp("put_page", (await profileScope(g)), g))).toBe("deny");
  });
  test("a background turn in a locked thread is denied, even to the agent's own slice", async () => {
    const g = gate({ userId: null, lockedUser: "U1" });
    expect((await classifyBrainOp("put_page", { ...(await scopeFor(g)), sourceId: agentSourceId("AGENT1") }, g))).toBe("deny");
  });
  test("denied on a background turn (no speaker)", async () => {
    const g = slackTurn({ userId: null });
    expect((await classifyBrainOp("put_page", (await profileScope(g)), g))).toBe("deny");
  });
  test("writing into another person's profile is denied, manager or not", async () => {
    for (const g of [slackTurn(), slackTurn({ isManager: true })]) {
      expect((await classifyBrainOp("put_page", (await profileScope(g, profileSourceId(TEAM, "U2"))), g))).toBe("deny");
      expect((await classifyBrainOp("put_page", (await profileScope(g, profileSourceId("T0OTHER", "U1"))), g))).toBe("deny");
    }
  });
  test("every write op is covered, not just put_page", async () => {
    const g = slackTurn({ interactive: false, origin: "cron" });
    for (const op of ["add_tag", "add_link", "add_timeline_entry"]) expect((await classifyBrainOp(op, (await profileScope(g)), g))).toBe("deny");
  });
  test("in an own /1on1, a write to shared or the agent's slice is denied", async () => {
    const g = slackTurn({ lockedUser: "U1" });
    expect((await classifyBrainOp("put_page", (await sharedScope(g)), g))).toBe("deny");
    expect((await classifyBrainOp("put_page", { ...(await scopeFor(g)), sourceId: agentSourceId("AGENT1") }, g))).toBe("deny");
    expect((await classifyBrainOp("put_page", { ...(await scopeFor(g)), sourceId: userSourceId("U1") }, g))).toBe("auto");
  });
  test("in someone else's /1on1, a manager's default write (the agent's slice) is denied", async () => {
    const g = slackTurn({ lockedUser: "U2", isManager: true });
    expect((await scopeFor(g)).sourceId).toBe(agentSourceId("AGENT1"));
    expect((await classifyBrainOp("put_page", (await scopeFor(g)), g))).toBe("deny");
    expect((await classifyBrainOp("put_page", (await sharedScope(g)), g))).toBe("deny");
  });
});

describe("turnBrainScope: the speaker's profile only on their own one-sender Slack turn", () => {
  const T = "T0TEAM";
  const alice = { userId: "U1", teamId: T, origin: "slack" };
  const profile = profileSourceId(T, "U1");
  const g = (over: Partial<GateInput>) => gate({ teamId: T, origin: "slack", ...over });
  test("exactly the speaker, from Slack: the profile is read", async () => {
    const s = (await turnBrainScope(g({ turnSenders: [alice] }), ["kb-docs"]));
    expect(s.allowedSources).toContain(profile);
    expect(s.profileSource).toBe(profile);
    expect(s.allowedSources).toContain("kb-docs");
  });
  test("anyone else, two senders, a cron sender, another team or unknown senders: no profile; the rest of the scope is unchanged", async () => {
    for (const turnSenders of [
      [{ ...alice, userId: "U2" }],
      [alice, { ...alice, userId: "U2" }],
      [{ ...alice, origin: "cron" }],
      [{ ...alice, teamId: "T0OTHER" }],
      undefined,
    ]) {
      const gi = g(turnSenders ? { turnSenders } : {});
      const s = (await turnBrainScope(gi, []));
      expect(s.allowedSources.some((x) => x.startsWith("profile-"))).toBe(false);
      expect(s.profileSource).toBeUndefined();
      const { profileSource: _p, ...rest } = (await resolveBrainScope({ ...gi, kbSources: [] }));
      expect(s).toEqual({ ...rest, allowedSources: rest.allowedSources.filter((x) => x !== profile) });
    }
  });
});

describe("gatedBrainCall", () => {
  test("auto tier calls through without approval", async () => {
    let approvals = 0;
    const r = await gatedBrainCall("search", {
      scope: (await scopeFor(gate())), gate: gate(), managers: ["UMGR"],
      requestApproval: async () => { approvals++; return { approved: true, by: "x" }; },
      call: async () => ["hit"], describe: "search",
    });
    expect(r).toEqual({ ok: true, result: ["hit"] });
    expect(approvals).toBe(0);
  });
  test("approval tier asks and respects denial", async () => {
    const r = await gatedBrainCall("put_page", {
      scope: (await sharedScope(gate())), gate: gate(), managers: ["UMGR"],
      requestApproval: async () => ({ approved: false, by: "UMGR", note: "nope" }),
      call: async () => { throw new Error("must not run"); }, describe: "write page",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("UMGR");
  });
  test("approval tier runs call after approval", async () => {
    const r = await gatedBrainCall("put_page", {
      scope: (await sharedScope(gate())), gate: gate(), managers: ["UMGR"],
      requestApproval: async () => ({ approved: true, by: "UMGR" }),
      call: async () => "written", describe: "write page",
    });
    expect(r).toEqual({ ok: true, result: "written" });
  });
  test("manager tier routes approval with kb-admin category, manager click passes", async () => {
    let category: string | undefined;
    const r = await gatedBrainCall("sources_add", {
      scope: (await scopeFor(gate())), gate: gate(), managers: ["UMGR", "UBACKUP"],
      requestApproval: async (req) => { category = req.category; return { approved: true, by: "UMGR" }; },
      call: async () => "added", describe: "add source",
    });
    expect(r.ok).toBe(true);
    expect(category).toBe("kb-admin");
  });

  test("manager tier rejects approval clicked by non-manager", async () => {
    let called = 0;
    const r = await gatedBrainCall("sources_remove", {
      scope: (await scopeFor(gate())), gate: gate(), managers: ["UMGR"],
      requestApproval: async () => ({ approved: true, by: "U0RANDO" }),
      call: async () => { called++; return null; }, describe: "remove source",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("manager");
    expect(called).toBe(0);
  });

  test("manager tier fails closed when no manager configured", async () => {
    const r = await gatedBrainCall("purge_deleted_pages", {
      scope: (await scopeFor(gate())), gate: gate(), managers: [],
      requestApproval: async () => ({ approved: true, by: "UMGR" }),
      call: async () => null, describe: "purge",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("manager");
  });

  test("plain approval tier does NOT require manager click", async () => {
    const r = await gatedBrainCall("put_page", {
      scope: (await sharedScope(gate())), gate: gate(), managers: ["UMGR"],
      requestApproval: async () => ({ approved: true, by: "U0APP" }),
      call: async () => "written", describe: "write",
    });
    expect(r).toEqual({ ok: true, result: "written" });
  });
  test("deny tier never calls approval or op", async () => {
    const g = gate({ channelTrust: "public" });
    let touched = 0;
    const r = await gatedBrainCall("put_page", {
      scope: (await scopeFor(g)), gate: g, managers: ["UMGR"],
      requestApproval: async () => { touched++; return { approved: true, by: "x" }; },
      call: async () => { touched++; return null; }, describe: "write",
    });
    expect(r.ok).toBe(false);
    expect(touched).toBe(0);
  });
});

describe("gatedBrainCall — standing grant (per-thread, implicit on first approve)", () => {
  beforeEach(() => resetStandingGrants());
  const T = "C1:1781000000.000";
  // Shared-target writes are what card; the grant suppresses the repeat card.
  const callWith = async (gateOver: Partial<GateInput>, approve: () => void) =>
    gatedBrainCall("put_page", {
      scope: (await sharedScope(gate(gateOver))), gate: gate(gateOver), managers: ["UMGR"],
      requestApproval: async () => { approve(); return { approved: true, by: "UMGR" }; },
      call: async () => "written", describe: "write",
    });

  test("first write cards; second write in same thread auto-passes", async () => {
    let cards = 0;
    const r1 = await callWith({ threadKey: T }, () => cards++);
    const r2 = await callWith({ threadKey: T }, () => cards++);
    expect(r1).toEqual({ ok: true, result: "written" });
    expect(r2).toEqual({ ok: true, result: "written" });
    expect(cards).toBe(1); // only the first asked
  });

  test("grant is scoped to the thread — a different thread still cards", async () => {
    let cards = 0;
    await callWith({ threadKey: T }, () => cards++);
    await callWith({ threadKey: "C1:9999999999.999" }, () => cards++);
    expect(cards).toBe(2);
  });

  test("grant is bound to the writer — a different user in the same thread still cards", async () => {
    let cards = 0;
    // User U1 gets approved → opens a grant for (T, U1) only.
    await callWith({ threadKey: T, userId: "U1" }, () => cards++);
    // User U2 writes in the SAME thread → must NOT ride U1's grant.
    await callWith({ threadKey: T, userId: "U2" }, () => cards++);
    expect(cards).toBe(2);
    // U1 again in the same thread → still covered, no extra card.
    await callWith({ threadKey: T, userId: "U1" }, () => cards++);
    expect(cards).toBe(2);
  });

  test("no threadKey → no grant, every write cards", async () => {
    let cards = 0;
    await callWith({ threadKey: null }, () => cards++);
    await callWith({ threadKey: null }, () => cards++);
    expect(cards).toBe(2);
  });

  test("a denied first write opens no grant", async () => {
    let cards = 0;
    const deny = async () =>
      gatedBrainCall("put_page", {
        scope: (await sharedScope(gate({ threadKey: T }))), gate: gate({ threadKey: T }), managers: ["UMGR"],
        requestApproval: async () => { cards++; return { approved: false, by: "UMGR" }; },
        call: async () => "written", describe: "write",
      });
    const r1 = await deny();
    expect(r1.ok).toBe(false);
    const r2 = await callWith({ threadKey: T }, () => cards++);
    expect(r2.ok).toBe(true);
    expect(cards).toBe(2); // denial didn't grant; second still asked
  });

  test("destructive ops are never covered by the grant", async () => {
    // open a grant via put_page
    await callWith({ threadKey: T }, () => {});
    let deleteCards = 0;
    const r = await gatedBrainCall("delete_page", {
      scope: (await sharedScope(gate({ threadKey: T }))), gate: gate({ threadKey: T }), managers: ["UMGR"],
      requestApproval: async () => { deleteCards++; return { approved: true, by: "UMGR" }; },
      call: async () => "deleted", describe: "delete",
    });
    expect(r.ok).toBe(true);
    expect(deleteCards).toBe(1); // delete still carded despite the put_page grant
  });

  test("expired grant re-cards", async () => {
    const prev = process.env.SLAUDE_KB_GRANT_TTL_MS;
    process.env.SLAUDE_KB_GRANT_TTL_MS = "0"; // every grant immediately stale
    try {
      let cards = 0;
      // module read GRANT_TTL_MS at import; force via a fresh import is overkill —
      // instead rely on expiresAt = now + 0 <= now next tick. Use a tiny sleep.
      await callWith({ threadKey: T }, () => cards++);
      await new Promise((res) => setTimeout(res, 2));
      await callWith({ threadKey: T }, () => cards++);
      expect(cards).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.SLAUDE_KB_GRANT_TTL_MS;
      else process.env.SLAUDE_KB_GRANT_TTL_MS = prev;
    }
  });
});
