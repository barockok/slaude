import { describe, expect, test } from "bun:test";
import {
  AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE,
  userSourceId, agentSourceId, kbSourceId, channelTrustFor, resolveBrainScope,
  profileSourceId, PROFILE_PREFIX, isProfileSourceId, type ScopeInput,
} from "../src/knowledge/scope";
import type { SoulData } from "../src/soul/data";

const soul = { trustedChannels: ["C_TRUST"], allowedChannels: ["C_PUB"] } as unknown as SoulData;
const AGENT = "AGENT1";
const A = agentSourceId(AGENT); // "agent-agent1"

describe("userSourceId / agentSourceId / kbSourceId", () => {
  test("lowercases and strips to [a-z0-9-], max 32", () => {
    expect(userSourceId("U04ABC_DEF")).toBe("user-u04abcdef");
    expect(userSourceId("U".repeat(40)).length).toBeLessThanOrEqual(32);
    expect(agentSourceId("U04ABC")).toBe("agent-u04abc");
    expect(agentSourceId("A".repeat(40)).length).toBeLessThanOrEqual(32);
    expect(kbSourceId("My Wiki!")).toBe("kb-my-wiki-");
  });
});

describe("channelTrustFor", () => {
  test("trusted > public > unknown", () => {
    expect(channelTrustFor("C_TRUST", soul)).toBe("trusted");
    expect(channelTrustFor("C_PUB", soul)).toBe("public");
    expect(channelTrustFor("C_X", soul)).toBe("unknown");
  });
});

describe("resolveBrainScope", () => {
  const kb = ["kb-runbook"];
  test("agent turn (no user): writes own agent slice, reads own+legacy+shared+public+kb", () => {
    const s = resolveBrainScope({ userId: null, lockedUser: null, channelTrust: "trusted", isManager: false, kbSources: kb, agentId: AGENT, teamId: null });
    expect(s.sourceId).toBe(A);
    expect(s.allowedSources).toEqual([A, AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE, "kb-runbook"]);
    expect(s.clientId).toBe(AGENT);
  });
  test("locked 1on1: writes own user slice, also reads the agent's own mind", () => {
    const s = resolveBrainScope({ userId: "U1", lockedUser: "U1", channelTrust: "trusted", isManager: false, kbSources: kb, agentId: AGENT, teamId: null });
    expect(s.sourceId).toBe("user-u1");
    expect(s.allowedSources).toEqual(["user-u1", A, AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE, "kb-runbook"]);
  });
  test("trusted channel (unlocked): default write is the agent's OWN private slice, not shared", () => {
    const s = resolveBrainScope({ userId: "U2", lockedUser: null, channelTrust: "trusted", isManager: false, kbSources: kb, agentId: AGENT, teamId: null });
    expect(s.sourceId).toBe(A);
    // shared is READABLE but not the default write target — escalation is explicit.
    expect(s.allowedSources).toEqual([A, AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE, "kb-runbook"]);
  });
  test("manager in unknown channel: default write is the agent slice, shared readable", () => {
    const s = resolveBrainScope({ userId: "UMGR", lockedUser: null, channelTrust: "unknown", isManager: true, kbSources: [], agentId: AGENT, teamId: null });
    expect(s.sourceId).toBe(A);
    expect(s.allowedSources).toContain(SHARED_SOURCE);
  });
  test("public/unknown channel: public reads only", () => {
    for (const trust of ["public", "unknown"] as const) {
      const s = resolveBrainScope({ userId: "U3", lockedUser: null, channelTrust: trust, isManager: false, kbSources: kb, agentId: AGENT, teamId: null });
      expect(s.sourceId).toBe(PUBLIC_SOURCE);
      expect(s.allowedSources).toEqual([PUBLIC_SOURCE]);
    }
  });
  test("other user in someone else's locked thread gets public scope", () => {
    const s = resolveBrainScope({ userId: "U9", lockedUser: "U1", channelTrust: "trusted", isManager: false, kbSources: [], agentId: AGENT, teamId: null });
    expect(s.sourceId).toBe(PUBLIC_SOURCE);
    expect(s.allowedSources).toEqual([PUBLIC_SOURCE]);
  });
  test("cross-agent isolation: an agent never reads or writes another agent's slice", () => {
    const a = resolveBrainScope({ userId: "U2", lockedUser: null, channelTrust: "trusted", isManager: false, kbSources: [], agentId: "AGENT_A", teamId: null });
    const bSlice = agentSourceId("AGENT_B");
    expect(a.sourceId).toBe(agentSourceId("AGENT_A"));
    expect(a.allowedSources).not.toContain(bSlice);
  });
});

describe("profileSourceId", () => {
  test("short ids: profile-<team>-<user>, lowercased", () => {
    expect(PROFILE_PREFIX).toBe("profile-");
    expect(profileSourceId("T0TEAM", "U0ALICE")).toBe("profile-t0team-u0alice");
  });
  test("long ids: profile- + 24 hex of sha256(team:user), within gbrain's 32 chars", () => {
    const t = "T".repeat(20), u = "U".repeat(20);
    const id = profileSourceId(t, u);
    expect(id.length).toBeLessThanOrEqual(32);
    expect(id.startsWith("profile-")).toBe(true);
    expect(id).toMatch(/^profile-[0-9a-f]{24}$/);
    expect(profileSourceId("T".repeat(19) + "X", u)).not.toBe(id);
    expect(profileSourceId(t, "U".repeat(19) + "X")).not.toBe(id);
  });
  test("never a user-, agent-, kb-, shared or public id; always a valid gbrain id", () => {
    for (const [t, u] of [["T0TEAM", "U0ALICE"], ["T".repeat(20), "U".repeat(20)], ["E0GRID", "W0BOB"]] as const) {
      const id = profileSourceId(t, u);
      expect(id).not.toBe(userSourceId(u));
      expect(id).not.toBe(agentSourceId(u));
      expect(id).not.toBe(kbSourceId(u));
      expect([SHARED_SOURCE, PUBLIC_SOURCE, AGENT_SOURCE]).not.toContain(id);
      expect(id).toMatch(/^[a-z0-9-]{1,32}$/);
      expect(isProfileSourceId(id)).toBe(true);
    }
  });
  test("the same person in another workspace has another profile", () => {
    expect(profileSourceId("T0ONE", "U0ALICE")).not.toBe(profileSourceId("T0TWO", "U0ALICE"));
  });
});

describe("resolveBrainScope profile rows", () => {
  const TEAM = "T0TEAM";
  const kb = ["kb-runbook"];
  const MGR = "U0MGR";
  const base = (o: Partial<ScopeInput>): ScopeInput => ({
    userId: "U0ALICE", teamId: TEAM, lockedUser: null, channelTrust: "trusted", isManager: false, kbSources: kb, agentId: AGENT, ...o,
  });
  /** Same input without a team: the row as it was before profiles. */
  const withoutProfile = (o: Partial<ScopeInput>) => resolveBrainScope(base({ ...o, teamId: null }));

  const rows: Array<[string, Partial<ScopeInput>]> = [
    ["trusted channel", {}],
    ["manager", { userId: MGR, channelTrust: "unknown", isManager: true }],
    ["own /1on1", { lockedUser: "U0ALICE" }],
    ["someone else's /1on1, non-manager", { userId: "U0BOB", lockedUser: "U0ALICE" }],
    ["someone else's /1on1, manager", { userId: MGR, lockedUser: "U0ALICE", isManager: true }],
    ["public channel", { channelTrust: "public" }],
  ];
  for (const [name, o] of rows) {
    test(`${name}: reads the speaker's profile after the row's own sources; write target unchanged`, () => {
      const s = resolveBrainScope(base(o));
      const before = withoutProfile(o);
      const speakerProfile = profileSourceId(TEAM, o.userId ?? "U0ALICE");
      expect(s.allowedSources).toEqual([...before.allowedSources, speakerProfile]);
      expect(s.profileSource).toBe(speakerProfile);
      expect(s.sourceId).toBe(before.sourceId);
      expect(s.clientId).toBe(before.clientId);
      expect(before.profileSource).toBeUndefined();
    });
  }
  test("someone else's /1on1, non-manager: public + the speaker's profile, never the lock owner's", () => {
    const s = resolveBrainScope(base({ userId: "U0BOB", lockedUser: "U0ALICE" }));
    expect(s.allowedSources).toEqual([PUBLIC_SOURCE, profileSourceId(TEAM, "U0BOB")]);
    expect(s.allowedSources).not.toContain(profileSourceId(TEAM, "U0ALICE"));
    expect(s.allowedSources).not.toContain(userSourceId("U0ALICE"));
    expect(s.sourceId).toBe(PUBLIC_SOURCE);
  });
  test("someone else's /1on1, manager: never the lock owner's profile", () => {
    const s = resolveBrainScope(base({ userId: MGR, lockedUser: "U0ALICE", isManager: true }));
    expect(s.allowedSources).not.toContain(profileSourceId(TEAM, "U0ALICE"));
    expect(s.allowedSources).toContain(profileSourceId(TEAM, MGR));
  });
  test("userId null (background turn): no profile", () => {
    const s = resolveBrainScope(base({ userId: null }));
    expect(s.allowedSources.some((x) => x.startsWith(PROFILE_PREFIX))).toBe(false);
    expect(s.profileSource).toBeUndefined();
    expect(s.sourceId).toBe(A);
  });
  test("teamId null: no profile", () => {
    for (const [, o] of rows) {
      const s = resolveBrainScope(base({ ...o, teamId: null }));
      expect(s.allowedSources.some((x) => x.startsWith(PROFILE_PREFIX))).toBe(false);
      expect(s.profileSource).toBeUndefined();
    }
  });
  test("an empty team or user id reads as unknown: no profile", () => {
    expect(resolveBrainScope(base({ teamId: "" })).profileSource).toBeUndefined();
    expect(resolveBrainScope(base({ userId: "" })).profileSource).toBeUndefined();
  });
});
