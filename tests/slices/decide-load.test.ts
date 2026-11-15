/**
 * Review fixes: the union resolver runs once per call window (a KB tool call builds
 * its scope and its gate separately), the shadow's in-flight slot lasts until the
 * queries finish, and the runAs person is resolved in the lock's workspace.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as PersonSlices from "../../src/knowledge/person-slices";
import { invalidateActors } from "../../src/refs/actor";
import { MAX_INFLIGHT, __resetSliceDecide, decidePersonSlices, runAsPersonFor, settlePersonSliceShadows } from "../../src/slices/decide";
import { TEAM, TEAM2, newUser, resetWorld, slack, cleanWorld } from "../helpers/person-world";

beforeEach(async () => {
  await resetWorld();
  __resetSliceDecide();
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SLAUDE_PERSON_SLICES;
  spyOn(console, "warn").mockRestore();
});

async function pair() {
  const u = await newUser();
  await slack(u, "U0AEXAMPLE");
  await slack(u, "U1AEXAMPLE");
}

describe("one resolver run per call window (union)", () => {
  test("two gate constructions for one speaker run the resolver once, and an invalidation starts a new run", async () => {
    process.env.SLAUDE_PERSON_SLICES = "union";
    await pair();
    const spy = spyOn(PersonSlices, "personSlicesDetailed");
    try {
      const [a, b] = await Promise.all([
        decidePersonSlices({ site: "brain.gate_speaker", teamId: TEAM, slackUserId: "U0AEXAMPLE" }),
        decidePersonSlices({ site: "brain.gate_speaker", teamId: TEAM, slackUserId: "U0AEXAMPLE" }),
      ]);
      expect(a?.reads).toHaveLength(2);
      expect(b).toEqual(a);
      await decidePersonSlices({ site: "brain.gate_speaker", teamId: TEAM, slackUserId: "U0AEXAMPLE" });
      expect(spy).toHaveBeenCalledTimes(1);
      invalidateActors(); // a link, unlink, merge or undo
      await decidePersonSlices({ site: "brain.gate_speaker", teamId: TEAM, slackUserId: "U0AEXAMPLE" });
      expect(spy).toHaveBeenCalledTimes(2);
      // Different identities never share an answer.
      await decidePersonSlices({ site: "brain.gate_speaker", teamId: TEAM, slackUserId: "U1AEXAMPLE" });
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });

  test("an unlink is seen on the next read even inside the window", async () => {
    process.env.SLAUDE_PERSON_SLICES = "union";
    await pair();
    expect((await decidePersonSlices({ site: "brain.gate_speaker", teamId: TEAM, slackUserId: "U0AEXAMPLE" }))?.reads).toHaveLength(2);
    const { db } = await import("../../src/db/schema");
    await db.run("DELETE FROM slack_identities WHERE slack_user_id = 'U1AEXAMPLE'");
    invalidateActors();
    expect(await decidePersonSlices({ site: "brain.gate_speaker", teamId: TEAM, slackUserId: "U0AEXAMPLE" })).toBeUndefined();
  });
});

describe("the shadow's in-flight slot", () => {
  test("stays taken until the queries finish, even after the bound cut the wait", async () => {
    process.env.SLAUDE_PERSON_SLICES = "shadow";
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = spyOn(PersonSlices, "personSlicesDetailed").mockImplementation(async () => ({
      slices: PersonSlices.legacyPersonSlices("U0AEXAMPLE"),
      status: "error",
      ms: 250,
      done: gate, // the wait was cut at the bound but the queries are still running
    }));
    try {
      for (let i = 0; i < MAX_INFLIGHT; i++) await decidePersonSlices({ site: "brain.gate_speaker", teamId: TEAM, slackUserId: "U0AEXAMPLE" });
      await new Promise((r) => setTimeout(r, 30));
      // Every slot is still held by running queries: the next one is dropped, not started.
      const before = spy.mock.calls.length;
      await decidePersonSlices({ site: "brain.gate_speaker", teamId: TEAM, slackUserId: "U0AEXAMPLE" });
      expect(spy.mock.calls.length).toBe(before);
      release();
      await settlePersonSliceShadows();
      await decidePersonSlices({ site: "brain.gate_speaker", teamId: TEAM, slackUserId: "U0AEXAMPLE" });
      await settlePersonSliceShadows();
      expect(spy.mock.calls.length).toBe(before + 1);
    } finally {
      release();
      spy.mockRestore();
    }
  });
});

describe("the runAs person is resolved in the lock's workspace", () => {
  test("a lock taken in another workspace is used, else the turn's; no runAs gives nothing", async () => {
    process.env.SLAUDE_PERSON_SLICES = "union";
    const u = await newUser();
    await slack(u, "U0AEXAMPLE", "verified", TEAM2);
    await slack(u, "U1AEXAMPLE", "verified", TEAM2);
    // The turn's team is TEAM (where nobody is bound); the lock was taken in TEAM2.
    expect(await runAsPersonFor({ teamId: TEAM, lockedUser: null, lockedTeamId: null }, "U0AEXAMPLE")).toBeUndefined();
    expect((await runAsPersonFor({ teamId: TEAM, lockedUser: "U0AEXAMPLE", lockedTeamId: TEAM2 }, "U0AEXAMPLE"))?.reads).toHaveLength(2);
    expect((await runAsPersonFor({ teamId: TEAM2, lockedUser: "U0AEXAMPLE", lockedTeamId: null }, "U0AEXAMPLE"))?.reads).toHaveLength(2);
    expect(await runAsPersonFor({ teamId: TEAM2, lockedUser: null }, null)).toBeUndefined();
  });
});

afterAll(async () => {
  await cleanWorld();
});
