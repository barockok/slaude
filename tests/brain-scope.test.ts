import { describe, expect, test } from "bun:test";
import {
  AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE,
  userSourceId, agentSourceId, kbSourceId, channelTrustFor, resolveBrainScope,
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
    const s = resolveBrainScope({ userId: null, lockedUser: null, channelTrust: "trusted", isManager: false, kbSources: kb, agentId: AGENT });
    expect(s.sourceId).toBe(A);
    expect(s.allowedSources).toEqual([A, AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE, "kb-runbook"]);
    expect(s.clientId).toBe(AGENT);
  });
  test("locked 1on1: writes own user slice, also reads the agent's own mind", () => {
    const s = resolveBrainScope({ userId: "U1", lockedUser: "U1", channelTrust: "trusted", isManager: false, kbSources: kb, agentId: AGENT });
    expect(s.sourceId).toBe("user-u1");
    expect(s.allowedSources).toEqual(["user-u1", A, AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE, "kb-runbook"]);
  });
  test("trusted channel (unlocked): default write is the agent's OWN private slice, not shared", () => {
    const s = resolveBrainScope({ userId: "U2", lockedUser: null, channelTrust: "trusted", isManager: false, kbSources: kb, agentId: AGENT });
    expect(s.sourceId).toBe(A);
    // shared is READABLE but not the default write target — escalation is explicit.
    expect(s.allowedSources).toEqual([A, AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE, "kb-runbook"]);
  });
  test("manager in unknown channel: default write is the agent slice, shared readable", () => {
    const s = resolveBrainScope({ userId: "UMGR", lockedUser: null, channelTrust: "unknown", isManager: true, kbSources: [], agentId: AGENT });
    expect(s.sourceId).toBe(A);
    expect(s.allowedSources).toContain(SHARED_SOURCE);
  });
  test("public/unknown channel: public reads only", () => {
    for (const trust of ["public", "unknown"] as const) {
      const s = resolveBrainScope({ userId: "U3", lockedUser: null, channelTrust: trust, isManager: false, kbSources: kb, agentId: AGENT });
      expect(s.sourceId).toBe(PUBLIC_SOURCE);
      expect(s.allowedSources).toEqual([PUBLIC_SOURCE]);
    }
  });
  test("other user in someone else's locked thread gets public scope", () => {
    const s = resolveBrainScope({ userId: "U9", lockedUser: "U1", channelTrust: "trusted", isManager: false, kbSources: [], agentId: AGENT });
    expect(s.sourceId).toBe(PUBLIC_SOURCE);
    expect(s.allowedSources).toEqual([PUBLIC_SOURCE]);
  });
  test("cross-agent isolation: an agent never reads or writes another agent's slice", () => {
    const a = resolveBrainScope({ userId: "U2", lockedUser: null, channelTrust: "trusted", isManager: false, kbSources: [], agentId: "AGENT_A" });
    const bSlice = agentSourceId("AGENT_B");
    expect(a.sourceId).toBe(agentSourceId("AGENT_A"));
    expect(a.allowedSources).not.toContain(bSlice);
  });
});
