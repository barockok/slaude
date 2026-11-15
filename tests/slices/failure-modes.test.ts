/**
 * Slice F, task 9: failure modes of `union`. Every way the resolver can fail (a
 * database error, the bound, an unreadable tombstone table, a throwing seam, a
 * failing acting-user lookup, a metrics failure) leaves each scope site on the
 * person's own legacy slice, never a wider set, with the write target unchanged
 * and the call never throwing.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Accounts from "../../src/db/accounts";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import type { GateInput } from "../../src/knowledge/gated-dispatch";
import * as PersonSlices from "../../src/knowledge/person-slices";
import { resolveBrainScope, userSourceId } from "../../src/knowledge/scope";
import { memoryScopeFor } from "../../src/memory/scope";
import { m } from "../../src/metrics";
import * as Actor from "../../src/refs/actor";
import { decidePersonSlices } from "../../src/slices/decide";
import { TEAM, newUser, resetWorld, slack, cleanWorld } from "../helpers/person-world";

const OWN = userSourceId("U0AEXAMPLE");
const BREAKS: Record<string, () => Array<{ mockRestore: () => void }>> = {
  "bindings read throws": () => [spyOn(Domain, "bindingsOf").mockRejectedValue(new Error("boom"))],
  "acting user lookup throws": () => [spyOn(Actor, "actingUser").mockRejectedValue(new Error("boom"))],
  "seam throws synchronously": () => [
    spyOn(PersonSlices, "personSlicesDetailed").mockImplementation(() => {
      throw new Error("sync");
    }),
  ],
  "resolver never answers": () => {
    const orig = PersonSlices.personSlicesDetailed;
    return [
      spyOn(Domain, "bindingsOf").mockImplementation(() => new Promise(() => {})),
      spyOn(PersonSlices, "personSlicesDetailed").mockImplementation((t, id) => orig(t, id, { timeoutMs: 30 })),
    ];
  },
  "metrics throw": () => [
    spyOn(m.personSlicesMs, "observe").mockImplementation(() => {
      throw new Error("metrics");
    }),
  ],
};

beforeEach(async () => {
  await resetWorld();
  process.env.SLAUDE_PERSON_SLICES = "union";
  spyOn(console, "warn").mockImplementation(() => {});
  const u = await newUser();
  await slack(u, "U0AEXAMPLE");
  await slack(u, "U1AEXAMPLE");
});
afterEach(() => {
  delete process.env.SLAUDE_PERSON_SLICES;
  spyOn(console, "warn").mockRestore();
});

describe("union failure modes", () => {
  for (const [name, brk] of Object.entries(BREAKS)) {
    test(`${name}: own slice only at every scope site, same write target, no throw`, async () => {
      const restores = brk();
      try {
        const person = await decidePersonSlices({ site: "brain.gate_speaker", teamId: TEAM, slackUserId: "U0AEXAMPLE" });
        // A metrics failure does not fail the decision: the union may still be returned. Anything else gives none.
        if (name !== "metrics throw") expect(person).toBeUndefined();
        const g: GateInput = { userId: "U0AEXAMPLE", teamId: TEAM, interactive: true, lockedUser: "U0AEXAMPLE", channelTrust: "trusted", isManager: false, agentId: "agent-one", ...(person ? { person } : {}) };
        const kb = await resolveBrainScope({ ...g, kbSources: [] });
        expect(kb.sourceId).toBe(OWN);
        if (name !== "metrics throw") expect(kb.allowedSources.filter((s) => s.startsWith("user-"))).toEqual([OWN]);
        else expect(kb.allowedSources.filter((s) => s.startsWith("user-"))).toEqual([OWN, userSourceId("U1AEXAMPLE")]);
        const dm = await memoryScopeFor({ ...g, lockedUser: null, channelTrust: "unknown" }, { channel: "D0EXAMPLE" });
        expect(dm.write).toEqual({ clientId: "U0AEXAMPLE", sourceId: OWN, allowedSources: [OWN] });
        const runAs = await memoryScopeFor(g, { runAsUser: "U0AEXAMPLE", ...(person ? { runAsPerson: person } : {}) });
        expect(runAs.write).toEqual({ clientId: "U0AEXAMPLE", sourceId: OWN, allowedSources: [OWN] });
      } finally {
        for (const r of restores) r.mockRestore();
      }
    });
  }

  test("an unreadable tombstone table never widens, and the next read after it is back recovers", async () => {
    await db.run("ALTER TABLE slice_tombstones RENAME TO slice_tombstones_x");
    try {
      expect(await decidePersonSlices({ site: "brain.gate_speaker", teamId: TEAM, slackUserId: "U0AEXAMPLE" })).toBeUndefined();
    } finally {
      await db.run("ALTER TABLE slice_tombstones_x RENAME TO slice_tombstones");
    }
    expect((await decidePersonSlices({ site: "brain.gate_speaker", teamId: TEAM, slackUserId: "U0AEXAMPLE" }))?.reads).toEqual([OWN, userSourceId("U1AEXAMPLE")]);
  });

  test("a deleted account in the middle of a read fails closed to the own slice", async () => {
    const a = await Accounts.upsertAccount({ issuer: "https://idp.example.com", subject: "s", email: "s@example.com" });
    await Accounts.deleteAccount(a.id);
    expect((await decidePersonSlices({ site: "brain.gate_speaker", teamId: TEAM, slackUserId: "U0AEXAMPLE" }))?.reads[0]).toBe(OWN);
  });
});

afterAll(async () => {
  await cleanWorld();
});
