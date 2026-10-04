/**
 * Where a turn's episodic memory is read and written (src/memory/scope.ts):
 * the KB scoping rules, plus "never into public" and "never through someone
 * else's /1on1".
 */
import { describe, expect, test } from "bun:test";
import { memoryScopeFor } from "../../src/memory/scope";
import { AGENT_SOURCE, agentSourceId, userSourceId } from "../../src/knowledge/scope";
import type { GateInput } from "../../src/knowledge/gated-dispatch";

const PERSONA = "U0PERSONA"; // a named persona's own Slack user id
const A = agentSourceId(PERSONA);
const g = (o: Partial<GateInput>): GateInput => ({
  userId: "U1", lockedUser: null, channelTrust: "trusted", isManager: false, agentId: PERSONA, ...o,
});

describe("memoryScopeFor", () => {
  test("a trusted channel reads and writes the persona's own slice (never agent-default)", () => {
    const s = memoryScopeFor(g({}));
    expect(s.write).toEqual({ clientId: PERSONA, sourceId: A, allowedSources: [A] });
    expect(s.read).toEqual({ clientId: PERSONA, sourceId: A, allowedSources: [A, AGENT_SOURCE] });
    expect(A).not.toBe(agentSourceId("default"));
  });

  test("an agent turn (cron) is the persona's own slice", () => {
    expect(memoryScopeFor(g({ userId: null, channelTrust: "unknown" })).write?.sourceId).toBe(A);
  });

  test("the owner's /1on1 reads and writes the user's slice only", () => {
    const s = memoryScopeFor(g({ userId: "U1", lockedUser: "U1", channelTrust: "public" }));
    expect(s.write?.sourceId).toBe(userSourceId("U1"));
    expect(s.read?.allowedSources).toEqual([userSourceId("U1")]);
  });

  test("a public channel reads nothing private, and is written to the agent's own slice, not public", () => {
    for (const trust of ["public", "unknown"] as const) {
      const s = memoryScopeFor(g({ channelTrust: trust }));
      expect(s.read).toBeNull();
      expect(s.write).toEqual({ clientId: PERSONA, sourceId: A, allowedSources: [A] });
    }
  });

  test("someone else's locked thread is neither read nor written", () => {
    expect(memoryScopeFor(g({ userId: "U2", lockedUser: "U1", channelTrust: "trusted" }))).toEqual({ read: null, write: null });
  });

  test("a manager in someone else's locked thread keeps the manager's KB rule (agent slice)", () => {
    expect(memoryScopeFor(g({ userId: "U2", lockedUser: "U1", isManager: true })).write?.sourceId).toBe(A);
  });
});
