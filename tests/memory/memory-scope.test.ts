/**
 * Where a turn's episodic memory is read and written (src/memory/scope.ts):
 * the KB scoping rules, plus "never into public" and "never through someone
 * else's /1on1".
 */
import { describe, expect, test } from "bun:test";
import { memoryScopeFor, withClaimLock } from "../../src/memory/scope";
import { AGENT_SOURCE, agentSourceId, userSourceId } from "../../src/knowledge/scope";
import type { GateInput } from "../../src/knowledge/gated-dispatch";

const PERSONA = "U0PERSONA"; // a named persona's own Slack user id
const A = agentSourceId(PERSONA);
const g = (o: Partial<GateInput>): GateInput => ({
  userId: "U1", teamId: null, interactive: true, lockedUser: null, channelTrust: "trusted", isManager: false, agentId: PERSONA, ...o,
});

describe("memoryScopeFor", () => {
  test("a trusted channel reads and writes the persona's own slice (never agent-default)", async () => {
    const s = (await memoryScopeFor(g({})));
    expect(s.write).toEqual({ clientId: PERSONA, sourceId: A, allowedSources: [A] });
    expect(s.read).toEqual({ clientId: PERSONA, sourceId: A, allowedSources: [A, AGENT_SOURCE] });
    expect(A).not.toBe(agentSourceId("default"));
  });

  test("an agent turn (cron) is the persona's own slice", async () => {
    expect((await memoryScopeFor(g({ userId: null, channelTrust: "unknown" }))).write?.sourceId).toBe(A);
  });

  test("the owner's /1on1 reads and writes the user's slice only", async () => {
    const s = (await memoryScopeFor(g({ userId: "U1", lockedUser: "U1", channelTrust: "public" })));
    expect(s.write?.sourceId).toBe(userSourceId("U1"));
    expect(s.read?.allowedSources).toEqual([userSourceId("U1")]);
  });

  test("a public channel reads and writes only the persona's own slice (never the legacy source, never public)", async () => {
    for (const trust of ["public", "unknown"] as const) {
      const s = (await memoryScopeFor(g({ channelTrust: trust }), { channel: "C0PUBLIC" }));
      expect(s.read).toEqual({ clientId: PERSONA, sourceId: A, allowedSources: [A] });
      expect(s.write).toEqual({ clientId: PERSONA, sourceId: A, allowedSources: [A] });
    }
  });

  test("a DM from a non-manager is the user's own slice, read and written, like a /1on1", async () => {
    const s = (await memoryScopeFor(g({ channelTrust: "unknown" }), { channel: "D0DM" }));
    expect(s.write?.sourceId).toBe(userSourceId("U1"));
    expect(s.read?.allowedSources).toEqual([userSourceId("U1")]);
  });

  test("a manager's DM keeps the manager's KB rule", async () => {
    expect((await memoryScopeFor(g({ channelTrust: "unknown", isManager: true }), { channel: "D0DM" })).write?.sourceId).toBe(A);
  });

  test("someone else's locked thread is neither read nor written", async () => {
    expect((await memoryScopeFor(g({ userId: "U2", lockedUser: "U1", channelTrust: "trusted" })))).toEqual({ read: null, write: null });
  });

  test("a manager in someone else's locked thread reads and writes nothing (never the persona's shared slice)", async () => {
    expect((await memoryScopeFor(g({ userId: "U2", lockedUser: "U1", isManager: true })))).toEqual({ read: null, write: null });
    expect((await memoryScopeFor(g({ userId: "U2", lockedUser: "U1", isManager: true }), { channel: "D0DM" }))).toEqual({ read: null, write: null });
  });
});

describe("memoryScopeFor honours runAs (whose identity the turn runs as)", () => {
  test("a cron created inside a 1:1 runs as the user: the user's slice, even with the thread unlocked", async () => {
    for (const userId of [null, "U1"]) {
      const s = (await memoryScopeFor(g({ userId, lockedUser: null, channelTrust: "trusted" }), { runAsUser: "U1" }));
      expect(s.write).toEqual({ clientId: "U1", sourceId: userSourceId("U1"), allowedSources: [userSourceId("U1")] });
      expect(s.read?.allowedSources).toEqual([userSourceId("U1")]);
    }
  });
  test("a speaker who is not the runAs user reads and writes nothing, manager included", async () => {
    for (const isManager of [false, true]) {
      expect((await memoryScopeFor(g({ userId: "U2", lockedUser: null, isManager }), { runAsUser: "U1" }))).toEqual({ read: null, write: null });
    }
  });
  test("runAs never widens: a runAs user in a thread locked by someone else reads and writes nothing", async () => {
    expect((await memoryScopeFor(g({ userId: null, lockedUser: "U9" }), { runAsUser: "U1" }))).toEqual({ read: null, write: null });
  });
  test("runAs = agent (absent) keeps the KB rules", async () => {
    expect((await memoryScopeFor(g({}), { runAsUser: null })).write?.sourceId).toBe(A);
  });
});

describe("withClaimLock: the more private of the live lock and the token's claim", () => {
  test("no claim (older gateway) or the same lock: the live lock", async () => {
    expect((await withClaimLock(g({ lockedUser: "U1" }), undefined)).lockedUser).toBe("U1");
    expect((await withClaimLock(g({ lockedUser: null }), null)).lockedUser).toBeNull();
    expect((await withClaimLock(g({ lockedUser: "U1" }), "U1")).lockedUser).toBe("U1");
  });
  test("unlocked live, locked at dispatch (a sync after /1on1 off): the claim", async () => {
    const merged = (await withClaimLock(g({ userId: "U1", lockedUser: null }), "U1"));
    expect(merged.lockedUser).toBe("U1");
    expect((await memoryScopeFor(merged)).write?.sourceId).toBe(userSourceId("U1"));
  });
  test("two different owners: the one that is not the speaker", async () => {
    expect((await withClaimLock(g({ userId: "U1", lockedUser: "U1" }), "U9")).lockedUser).toBe("U9");
    expect((await withClaimLock(g({ userId: "U1", lockedUser: "U9" }), "U1")).lockedUser).toBe("U9");
  });
});

describe("the profile source never reaches episodic memory", () => {
  test("a known team changes no row: memory reads and writes are the same as with no team", async () => {
    const rows: Partial<GateInput>[] = [
      {}, { lockedUser: "U1" }, { userId: "U2", lockedUser: "U1" }, { userId: "UMGR", isManager: true },
      { channelTrust: "public" }, { userId: null }, { interactive: false },
    ];
    for (const o of rows) {
      for (const channel of [undefined, "D0DM", "C0TEAM"]) {
        const withTeam = (await memoryScopeFor(g({ ...o, teamId: "T0TEAM" }), { channel }));
        expect(withTeam).toEqual((await memoryScopeFor(g({ ...o, teamId: null }), { channel })));
        expect(JSON.stringify(withTeam)).not.toContain("profile-");
      }
    }
  });
});
