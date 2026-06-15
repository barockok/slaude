import { describe, expect, test, beforeEach } from "bun:test";
import { classifyBrainOp, gatedBrainCall, resetStandingGrants, type GateInput } from "../src/knowledge/gated-dispatch";
import { resolveBrainScope } from "../src/knowledge/scope";

const gate = (over: Partial<GateInput> = {}): GateInput => ({
  userId: "U1", lockedUser: null, channelTrust: "trusted", isManager: false, ...over,
});
const scopeFor = (g: GateInput, kb: string[] = []) => resolveBrainScope({ ...g, kbSources: kb });

describe("classifyBrainOp", () => {
  test("reads are auto everywhere", () => {
    for (const op of ["search", "think", "get_page", "list_pages", "get_links", "get_backlinks", "query"]) {
      const g = gate({ channelTrust: "unknown" });
      expect(classifyBrainOp(op, scopeFor(g), g)).toBe("auto");
    }
  });
  test("agent turn writes are auto", () => {
    const g = gate({ userId: null });
    expect(classifyBrainOp("put_page", scopeFor(g), g)).toBe("auto");
  });
  test("own-slice write in locked 1on1 is auto", () => {
    const g = gate({ lockedUser: "U1" });
    expect(classifyBrainOp("put_page", scopeFor(g), g)).toBe("auto");
  });
  test("shared write from trusted channel needs approval", () => {
    const g = gate();
    expect(classifyBrainOp("put_page", scopeFor(g), g)).toBe("approval");
  });
  test("write from public channel is denied", () => {
    const g = gate({ channelTrust: "public" });
    expect(classifyBrainOp("put_page", scopeFor(g), g)).toBe("deny");
  });
  test("deletes always need approval, even own slice", () => {
    const g = gate({ lockedUser: "U1" });
    expect(classifyBrainOp("delete_page", scopeFor(g), g)).toBe("approval");
  });
  test("delete from public channel by non-manager is denied", () => {
    const g = gate({ channelTrust: "public" });
    expect(classifyBrainOp("delete_page", scopeFor(g), g)).toBe("deny");
  });
  test("admin ops are manager tier", () => {
    for (const op of ["purge_deleted_pages", "sources_add", "sources_remove", "sync_brain"]) {
      expect(classifyBrainOp(op, scopeFor(gate()), gate())).toBe("manager");
    }
  });
  test("unknown ops fail closed to manager", () => {
    expect(classifyBrainOp("run_skillopt", scopeFor(gate()), gate())).toBe("manager");
  });
});

describe("gatedBrainCall", () => {
  test("auto tier calls through without approval", async () => {
    let approvals = 0;
    const r = await gatedBrainCall("search", {
      scope: scopeFor(gate()), gate: gate(), managers: ["UMGR"],
      requestApproval: async () => { approvals++; return { approved: true, by: "x" }; },
      call: async () => ["hit"], describe: "search",
    });
    expect(r).toEqual({ ok: true, result: ["hit"] });
    expect(approvals).toBe(0);
  });
  test("approval tier asks and respects denial", async () => {
    const r = await gatedBrainCall("put_page", {
      scope: scopeFor(gate()), gate: gate(), managers: ["UMGR"],
      requestApproval: async () => ({ approved: false, by: "UMGR", note: "nope" }),
      call: async () => { throw new Error("must not run"); }, describe: "write page",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("UMGR");
  });
  test("approval tier runs call after approval", async () => {
    const r = await gatedBrainCall("put_page", {
      scope: scopeFor(gate()), gate: gate(), managers: ["UMGR"],
      requestApproval: async () => ({ approved: true, by: "UMGR" }),
      call: async () => "written", describe: "write page",
    });
    expect(r).toEqual({ ok: true, result: "written" });
  });
  test("manager tier routes approval with kb-admin category, manager click passes", async () => {
    let category: string | undefined;
    const r = await gatedBrainCall("sources_add", {
      scope: scopeFor(gate()), gate: gate(), managers: ["UMGR", "UBACKUP"],
      requestApproval: async (req) => { category = req.category; return { approved: true, by: "UMGR" }; },
      call: async () => "added", describe: "add source",
    });
    expect(r.ok).toBe(true);
    expect(category).toBe("kb-admin");
  });

  test("manager tier rejects approval clicked by non-manager", async () => {
    let called = 0;
    const r = await gatedBrainCall("sources_remove", {
      scope: scopeFor(gate()), gate: gate(), managers: ["UMGR"],
      requestApproval: async () => ({ approved: true, by: "U0RANDO" }),
      call: async () => { called++; return null; }, describe: "remove source",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("manager");
    expect(called).toBe(0);
  });

  test("manager tier fails closed when no manager configured", async () => {
    const r = await gatedBrainCall("purge_deleted_pages", {
      scope: scopeFor(gate()), gate: gate(), managers: [],
      requestApproval: async () => ({ approved: true, by: "UMGR" }),
      call: async () => null, describe: "purge",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("manager");
  });

  test("plain approval tier does NOT require manager click", async () => {
    const r = await gatedBrainCall("put_page", {
      scope: scopeFor(gate()), gate: gate(), managers: ["UMGR"],
      requestApproval: async () => ({ approved: true, by: "U0APP" }),
      call: async () => "written", describe: "write",
    });
    expect(r).toEqual({ ok: true, result: "written" });
  });
  test("deny tier never calls approval or op", async () => {
    const g = gate({ channelTrust: "public" });
    let touched = 0;
    const r = await gatedBrainCall("put_page", {
      scope: scopeFor(g), gate: g, managers: ["UMGR"],
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
  const callWith = (gateOver: Partial<GateInput>, approve: () => void) =>
    gatedBrainCall("put_page", {
      scope: scopeFor(gate(gateOver)), gate: gate(gateOver), managers: ["UMGR"],
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
    const deny = () =>
      gatedBrainCall("put_page", {
        scope: scopeFor(gate({ threadKey: T })), gate: gate({ threadKey: T }), managers: ["UMGR"],
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
      scope: scopeFor(gate({ threadKey: T })), gate: gate({ threadKey: T }), managers: ["UMGR"],
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
