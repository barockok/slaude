import { describe, expect, test } from "bun:test";
import {
  AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE,
  userSourceId, kbSourceId, channelTrustFor, resolveBrainScope,
} from "../src/knowledge/scope";
import type { SoulData } from "../src/soul/data";

const soul = { trustedChannels: ["C_TRUST"], allowedChannels: ["C_PUB"] } as unknown as SoulData;

describe("userSourceId / kbSourceId", () => {
  test("lowercases and strips to [a-z0-9-], max 32", () => {
    expect(userSourceId("U04ABC_DEF")).toBe("user-u04abcdef");
    expect(userSourceId("U".repeat(40)).length).toBeLessThanOrEqual(32);
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
  test("agent turn (no user): writes agent, reads everything", () => {
    const s = resolveBrainScope({ userId: null, lockedUser: null, channelTrust: "trusted", isManager: false, kbSources: kb });
    expect(s.sourceId).toBe(AGENT_SOURCE);
    expect(s.allowedSources).toEqual([AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE, "kb-runbook"]);
    expect(s.clientId).toBe("agent");
  });
  test("locked 1on1: writes own slice, reads own+shared+public+kb", () => {
    const s = resolveBrainScope({ userId: "U1", lockedUser: "U1", channelTrust: "trusted", isManager: false, kbSources: kb });
    expect(s.sourceId).toBe("user-u1");
    expect(s.allowedSources).toEqual(["user-u1", SHARED_SOURCE, PUBLIC_SOURCE, "kb-runbook"]);
  });
  test("trusted channel: writes shared, no agent source in reads", () => {
    const s = resolveBrainScope({ userId: "U2", lockedUser: null, channelTrust: "trusted", isManager: false, kbSources: kb });
    expect(s.sourceId).toBe(SHARED_SOURCE);
    expect(s.allowedSources).toEqual([SHARED_SOURCE, PUBLIC_SOURCE, "kb-runbook"]);
    expect(s.allowedSources).not.toContain(AGENT_SOURCE);
  });
  test("manager in unknown channel gets trusted scope", () => {
    const s = resolveBrainScope({ userId: "UMGR", lockedUser: null, channelTrust: "unknown", isManager: true, kbSources: [] });
    expect(s.sourceId).toBe(SHARED_SOURCE);
  });
  test("public/unknown channel: public reads only", () => {
    for (const trust of ["public", "unknown"] as const) {
      const s = resolveBrainScope({ userId: "U3", lockedUser: null, channelTrust: trust, isManager: false, kbSources: kb });
      expect(s.sourceId).toBe(PUBLIC_SOURCE);
      expect(s.allowedSources).toEqual([PUBLIC_SOURCE]);
    }
  });
  test("other user in someone else's locked thread gets public scope", () => {
    const s = resolveBrainScope({ userId: "U9", lockedUser: "U1", channelTrust: "trusted", isManager: false, kbSources: [] });
    expect(s.sourceId).toBe(PUBLIC_SOURCE);
    expect(s.allowedSources).toEqual([PUBLIC_SOURCE]);
  });
});
