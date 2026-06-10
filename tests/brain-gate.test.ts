import { describe, expect, test } from "bun:test";
import { classifyBrainOp, gatedBrainCall, type GateInput } from "../src/knowledge/gated-dispatch";
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
