/**
 * Slice C task 16: knowledge and memory scope compares go through the shadow
 * seam and keep returning the legacy decision under every source mode and when
 * the resolver or engine is broken or disagrees.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { settleShadows } from "../../src/access/wired";
import { decideProposal, mayDecide } from "../../src/background/proposal-cards";
import { classifyBrainOp, gatedBrainCall, resetStandingGrants, turnBrainScope, type GateInput } from "../../src/knowledge/gated-dispatch";
import { brainHandlers, type BrainToolDeps } from "../../src/knowledge/mcp-tools";
import { agentSourceId, resolveBrainScope, userSourceId } from "../../src/knowledge/scope";
import { memoryScopeFor, withClaimLock } from "../../src/memory/scope";
import { fakeBrain } from "../memory/fake-brain";
import { compared, decisions, legacyUnderEveryMode, useShadowEnv } from "../helpers/shadow-modes";

const TEAM = "T0EXAMPLE";
const AGENT = "U0AGENT";
useShadowEnv();
beforeEach(() => resetStandingGrants());

const gate = (o: Partial<GateInput> = {}): GateInput => ({
  userId: "U0ONE", teamId: TEAM, interactive: true, origin: "slack", lockedUser: null, lockedTeamId: TEAM,
  channelTrust: "trusted", isManager: false, agentId: AGENT, threadKey: "C0EXAMPLE:1.1", ...o,
});

describe("brain write gate and scope", () => {
  const scenario = async () => {
    const own = userSourceId("U0ONE");
    const tier = async (g: GateInput, src: string) => (await classifyBrainOp("put_page", { clientId: g.userId ?? "x", sourceId: src, allowedSources: [src] }, g));
    return {
      ownerOwnSlice: await tier(gate({ lockedUser: "U0ONE" }), own),
      ownerShared: await tier(gate({ lockedUser: "U0ONE" }), "shared"),
      otherLock: await tier(gate({ lockedUser: "U0TWO" }), own),
      scopeOwner: (await resolveBrainScope({ ...gate({ lockedUser: "U0ONE" }), kbSources: [] })).sourceId,
      scopeOther: (await resolveBrainScope({ ...gate({ lockedUser: "U0TWO" }), kbSources: [] })).sourceId,
      turn: (await turnBrainScope(gate({ turnSenders: [{ userId: "U0ONE", teamId: TEAM, origin: "slack" }] }), [])).profileSource ?? null,
      turnOther: (await turnBrainScope(gate({ turnSenders: [{ userId: "U0TWO", teamId: TEAM, origin: "slack" }] }), [])).profileSource ?? null,
    };
  };
  const expected = async () => {
    process.env.SLAUDE_ACCESS_SOURCE = "legacy";
    const v = await scenario();
    delete process.env.SLAUDE_ACCESS_SOURCE;
    return v;
  };
  test("sanity: the baseline discriminates", async () => {
    const v = await expected();
    expect(v.ownerOwnSlice).toBe("auto");
    expect(v.ownerShared).toBe("deny");
    expect(v.otherLock).toBe("deny");
    expect(v.scopeOwner).toBe(userSourceId("U0ONE"));
    expect(v.scopeOther).toBe("public");
    expect(v.turn).not.toBeNull();
    expect(v.turnOther).toBeNull();
  });
  legacyUnderEveryMode("lock owner and sender compares", scenario, {
    ownerOwnSlice: "auto",
    ownerShared: "deny",
    otherLock: "deny",
    scopeOwner: userSourceId("U0ONE"),
    scopeOther: "public",
    turn: expect.any(String) as unknown as string,
    turnOther: null as unknown as string,
  } as never);
  test("each counts decisions and compares", async () => {
    await scenario();
    await settleShadows();
    for (const site of ["brain_gate.lock_owner", "kb_scope.lock_owner", "brain_gate.turn_sender_same"]) {
      expect(decisions(site)).toBeGreaterThan(0);
      expect(compared(site)).toBeGreaterThan(0);
    }
  });
});

describe("kb-admin approval", () => {
  const run = async (by: string) => {
    const g = gate();
    const r = await gatedBrainCall("sync_brain", {
      scope: (await resolveBrainScope({ ...g, kbSources: [] })), gate: g, managers: ["U0MGR"], describe: "x",
      requestApproval: async () => ({ approved: true, by }), call: async () => "done",
    });
    return r.ok;
  };
  const scenario = async () => ({ manager: await run("U0MGR"), other: await run("U0NOBODY") });
  legacyUnderEveryMode("only a listed manager passes", scenario, { manager: true, other: false });
  test("counts the manager compare", async () => {
    await scenario();
    await settleShadows();
    expect(decisions("brain_gate.manager_approver")).toBe(2);
  });
});

describe("kb tools", () => {
  const depsFor = async (g: GateInput): Promise<BrainToolDeps> => {
    const scope = (await resolveBrainScope({ ...g, kbSources: [] }));
    const b = fakeBrain();
    return { scope: () => scope, gate: () => g, managers: () => [], requestApproval: async () => ({ approved: true, by: "U0MGR" }), call: (n, p, s) => b.call(n, p, s) };
  };
  const scenario = async () => {
    const memo = async (g: GateInput) => {
      const r = await brainHandlers.kb_memoize({ pages: [{ slug: "note", content: "hello", type: "person-note" } as never], target: "mine" }, (await depsFor(g)));
      return !r.isError;
    };
    const about = async (asked: string) => {
      const g = gate({ turnSenders: [{ userId: "U0ONE", teamId: TEAM, origin: "slack" }] });
      const r = await brainHandlers.memory_about({ userId: asked }, (await depsFor(g)));
      return !r.isError;
    };
    return { ownerLocked: await memo(gate({ lockedUser: "U0ONE" })), otherLocked: await memo(gate({ lockedUser: "U0TWO" })), aboutSelf: await about("U0ONE"), aboutOther: await about("U0TWO") };
  };
  legacyUnderEveryMode("lock owner and memory_about", scenario, { ownerLocked: true, otherLocked: false, aboutSelf: true, aboutOther: false });
  test("counts both compares", async () => {
    await scenario();
    await settleShadows();
    expect(decisions("kb_tools.lock_owner")).toBeGreaterThan(0);
    expect(decisions("kb_tools.memory_about")).toBe(2);
  });
});

describe("memory scope", () => {
  const scenario = async () => ({
    own: (await memoryScopeFor(gate({ lockedUser: "U0ONE" })))?.write?.sourceId ?? null,
    other: (await memoryScopeFor(gate({ lockedUser: "U0TWO" }))).write,
    runAsSpeaker: (await memoryScopeFor(gate(), { runAsUser: "U0ONE" })).write?.sourceId ?? null,
    runAsOther: (await memoryScopeFor(gate(), { runAsUser: "U0TWO" })).write,
    runAsLock: (await memoryScopeFor(gate({ userId: null, lockedUser: "U0TWO" }), { runAsUser: "U0ONE" })).write,
    claimSame: (await withClaimLock(gate({ lockedUser: "U0ONE" }), "U0ONE")).lockedUser,
    claimOther: (await withClaimLock(gate({ lockedUser: "U0TWO" }), "U0ONE")).lockedUser,
    claimOwn: (await withClaimLock(gate({ lockedUser: "U0ONE" }), "U0TWO")).lockedUser,
    claimNone: (await withClaimLock(gate(), "U0TWO")).lockedUser,
  });
  legacyUnderEveryMode("lock, run-as and claim compares", scenario, {
    own: userSourceId("U0ONE"),
    other: null,
    runAsSpeaker: userSourceId("U0ONE"),
    runAsOther: null,
    runAsLock: null,
    claimSame: "U0ONE",
    claimOther: "U0TWO",
    claimOwn: "U0TWO",
    claimNone: "U0TWO",
  } as never);
  test("each site counts decisions", async () => {
    await scenario();
    await settleShadows();
    for (const site of ["memory_scope.lock_owner", "memory_scope.run_as_speaker", "memory_scope.run_as_lock", "memory_scope.claim_live_same", "memory_scope.live_speaker_same"]) expect(decisions(site)).toBeGreaterThan(0);
  });
  test("agent slice still the default for an unlocked turn", async () => {
    expect((await memoryScopeFor(gate())).write?.sourceId).toBe(agentSourceId(AGENT));
  });
});

describe("proposal cards", () => {
  const scenario = async () => ({
    person: (await mayDecide({ toKind: "person", toUser: "U0ONE" }, "U0ONE", [], { teamId: TEAM })),
    notPerson: (await mayDecide({ toKind: "person", toUser: "U0ONE" }, "U0TWO", ["U0TWO"], { teamId: TEAM })),
    manager: (await mayDecide({ toKind: "manager", toUser: null }, "U0MGR", ["U0MGR"], { teamId: TEAM })),
    notManager: (await mayDecide({ toKind: "manager", toUser: null }, "U0ONE", ["U0MGR"], { teamId: TEAM })),
    noTeam: (await mayDecide({ toKind: "manager", toUser: null }, "U0MGR", ["U0MGR"])),
  });
  legacyUnderEveryMode("who may decide", scenario, { person: true, notPerson: false, manager: true, notManager: false, noTeam: true });
  test("counts decisions; no workspace is not compared", async () => {
    await scenario();
    await settleShadows();
    expect(decisions("proposal.person_decider")).toBe(2);
    expect(decisions("proposal.manager_decider")).toBe(3);
    expect(compared("proposal.manager_decider")).toBe(2);
  });
  test("decideProposal is importable with the seam", () => {
    expect(typeof decideProposal).toBe("function");
  });
});
