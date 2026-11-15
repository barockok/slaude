/**
 * Slice F, task 8: `SLAUDE_PERSON_SLICES=union` honoured at the scope sites (reads
 * only), with a scripted scenario for each leak the adversarial review found, the
 * Rules S and T, the failure modes, and an end-to-end run through the fake brain.
 * Placeholders only.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Accounts from "../../src/db/accounts";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import { addTombstone } from "../../src/db/slice-tombstones";
import { mergeUsers } from "../../src/domain/merge";
import { undoMerge } from "../../src/domain/merge-undo";
import type { GateInput } from "../../src/knowledge/gated-dispatch";
import * as PersonSlices from "../../src/knowledge/person-slices";
import { resolveBrainScope, userSourceId } from "../../src/knowledge/scope";
import { memoryScopeFor } from "../../src/memory/scope";
import { decidePersonSlices } from "../../src/slices/decide";
import { fakeBrain } from "../memory/fake-brain";
import { TEAM, TEAM2, newUser, resetWorld, slack, cleanWorld } from "../helpers/person-world";

const ISS = "https://idp.example.com";
const U = (id: string) => userSourceId(id);

async function gateFor(speaker: string, over: Partial<GateInput> = {}, team: string = TEAM): Promise<GateInput> {
  const person = await decidePersonSlices({ site: "brain.gate_speaker", teamId: team, slackUserId: speaker });
  return { userId: speaker, teamId: team, interactive: true, lockedUser: null, channelTrust: "trusted", isManager: false, agentId: "agent-one", ...over, ...(person ? { person } : {}) };
}
const kbScope = async (g: GateInput) => resolveBrainScope({ ...g, kbSources: [] });
const userNames = (s: { allowedSources: string[] }) => s.allowedSources.filter((x) => x.startsWith("user-"));

beforeEach(async () => {
  await resetWorld();
  await db.run("DELETE FROM audit_events");
  await db.run("DELETE FROM link_token_uses");
  process.env.SLAUDE_PERSON_SLICES = "union";
  process.env.SLAUDE_MERGE_NOTICE = "off";
  spyOn(console, "warn").mockImplementation(() => {});
  spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SLAUDE_PERSON_SLICES;
  delete process.env.SLAUDE_MERGE_NOTICE;
  spyOn(console, "warn").mockRestore();
  spyOn(console, "log").mockRestore();
});

async function accountWithLinks(sub: string, ids: Array<{ team?: string; id: string }>) {
  const a = await Accounts.upsertAccount({ issuer: ISS, subject: sub, email: `${sub}@example.com` });
  for (const i of ids) expect((await Accounts.linkSlackIdentity({ teamId: i.team ?? TEAM, slackUserId: i.id, accountId: a.id, via: "test" })).ok).toBe(true);
  return a;
}

describe("the leaks the review found", () => {
  test("an observed U2 console-merged into a verified U1: U1 does NOT read user-u2", async () => {
    const a = await accountWithLinks("sub-1", [{ id: "U0AEXAMPLE" }]);
    const observed = await newUser();
    await slack(observed, "U2AEXAMPLE", "observed");
    const survivor = (await Domain.findBinding({ service: "slack", kind: "user", workspace: TEAM, value: "U0AEXAMPLE" }))!.user_id;
    const out = await mergeUsers({ survivorId: survivor, loserId: observed, kind: "console", actor: "UOPERATOR" });
    expect(out.status).toBe("merged");
    // The record now holds both, one verified and one observed.
    expect((await Domain.findBinding({ service: "slack", kind: "user", workspace: TEAM, value: "U2AEXAMPLE" }))!.user_id).toBe(survivor);
    expect(userNames(await kbScope(await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" })))).toEqual([U("U0AEXAMPLE")]);
    // And the observed id itself reads only its own slice.
    expect(userNames(await kbScope(await gateFor("U2AEXAMPLE", { lockedUser: "U2AEXAMPLE" })))).toEqual([U("U2AEXAMPLE")]);
    void a;
  });

  test("U2 proves itself by its own link: the union appears, for both ids, and only then", async () => {
    const a = await accountWithLinks("sub-1", [{ id: "U0AEXAMPLE" }]);
    const observed = await newUser();
    await slack(observed, "U2AEXAMPLE", "observed");
    expect(userNames(await kbScope(await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" })))).toEqual([U("U0AEXAMPLE")]);
    expect((await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U2AEXAMPLE", accountId: a.id, via: "test" })).ok).toBe(true);
    expect(userNames(await kbScope(await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" })))).toEqual([U("U0AEXAMPLE"), U("U2AEXAMPLE")]);
    expect(userNames(await kbScope(await gateFor("U2AEXAMPLE", { lockedUser: "U2AEXAMPLE" })))).toEqual([U("U2AEXAMPLE"), U("U0AEXAMPLE")]);
  });

  test("unlink then read: the access is gone on the next read", async () => {
    const a = await accountWithLinks("sub-1", [{ id: "U0AEXAMPLE" }, { id: "U1AEXAMPLE" }]);
    expect(userNames(await kbScope(await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" })))).toHaveLength(2);
    await Accounts.unlinkSlackIdentity(TEAM, "U1AEXAMPLE", a.id);
    expect(userNames(await kbScope(await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" })))).toEqual([U("U0AEXAMPLE")]);
  });

  test("unlink then relink to ANOTHER account: the first person loses it, the second does not gain the first's other ids", async () => {
    const a1 = await accountWithLinks("sub-1", [{ id: "U0AEXAMPLE" }, { id: "U1AEXAMPLE" }]);
    const a2 = await accountWithLinks("sub-2", [{ id: "U0BEXAMPLE" }]);
    await Accounts.unlinkSlackIdentity(TEAM, "U1AEXAMPLE", a1.id);
    expect((await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U1AEXAMPLE", accountId: a2.id, via: "test" })).ok).toBe(true);
    const first = userNames(await kbScope(await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" })));
    expect(first).toEqual([U("U0AEXAMPLE")]);
    const second = userNames(await kbScope(await gateFor("U0BEXAMPLE", { lockedUser: "U0BEXAMPLE" })));
    expect(second).toEqual([U("U0BEXAMPLE"), U("U1AEXAMPLE")]);
    expect(second).not.toContain(U("U0AEXAMPLE"));
  });

  test("a merge of verified A into verified B is refused, so no union appears", async () => {
    await accountWithLinks("sub-1", [{ id: "U0AEXAMPLE" }]);
    await accountWithLinks("sub-2", [{ id: "U0BEXAMPLE" }]);
    const a = (await Domain.findBinding({ service: "slack", kind: "user", workspace: TEAM, value: "U0AEXAMPLE" }))!.user_id;
    const b = (await Domain.findBinding({ service: "slack", kind: "user", workspace: TEAM, value: "U0BEXAMPLE" }))!.user_id;
    expect((await mergeUsers({ survivorId: a, loserId: b, kind: "console", actor: "UOPERATOR" })).status).toBe("refused");
    expect(userNames(await kbScope(await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" })))).toEqual([U("U0AEXAMPLE")]);
  });

  test("undo of a proof merge: the survivor loses the other id's slice, the loser keeps its own, the replay is vetoed", async () => {
    // A person is seen from Slack (observed U1), then proves U1 by a link: the proof merge joins the records.
    const seen = await newUser();
    await slack(seen, "U1AEXAMPLE", "observed");
    const a = await accountWithLinks("sub-1", [{ id: "U0AEXAMPLE" }]);
    expect(await db.one("SELECT id FROM user_merges")).toBeNull(); // linking U0 made no merge
    expect(userNames(await kbScope(await gateFor("U1AEXAMPLE", { lockedUser: "U1AEXAMPLE" })))).toEqual([U("U1AEXAMPLE")]);
    expect((await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U1AEXAMPLE", accountId: a.id, via: "test" })).ok).toBe(true);
    const m = await db.one<{ id: string }>("SELECT id FROM user_merges WHERE state = 'applied'");
    expect(m).not.toBeNull();
    expect(userNames(await kbScope(await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" })))).toEqual([U("U0AEXAMPLE"), U("U1AEXAMPLE")]);
    const u = await undoMerge({ mergeId: m!.id, actor: "op@example.com", reason: "test" });
    expect(u.status).toBe("undone");
    expect(userNames(await kbScope(await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" })))).toEqual([U("U0AEXAMPLE")]);
    expect(userNames(await kbScope(await gateFor("U1AEXAMPLE", { lockedUser: "U1AEXAMPLE" })))).toEqual([U("U1AEXAMPLE")]);
    // The replay of the same link is vetoed, so no union comes back.
    const again = await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U1AEXAMPLE", accountId: a.id, via: "test" });
    expect(again).toEqual({ ok: false, reason: "vetoed" });
    expect(userNames(await kbScope(await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" })))).toEqual([U("U0AEXAMPLE")]);
  });

  test("the same Slack id string in two workspaces held by two users is excluded", async () => {
    const a = await accountWithLinks("sub-1", [{ id: "U0AEXAMPLE" }, { id: "U9SHAREDEXAMPLE" }]);
    const other = await newUser();
    await slack(other, "U9SHAREDEXAMPLE", "observed", TEAM2);
    expect(userNames(await kbScope(await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" })))).toEqual([U("U0AEXAMPLE")]);
    void a;
  });
});

describe("rules S and T, reads only", () => {
  test("a lock held by someone else gives the public-only scope even for a speaker with a union (Rule S)", async () => {
    await accountWithLinks("sub-1", [{ id: "U0AEXAMPLE" }, { id: "U1AEXAMPLE" }]);
    const g = await gateFor("U0AEXAMPLE", { lockedUser: "U0ZEXAMPLE" });
    expect(g.person?.reads).toHaveLength(2);
    const s = await kbScope(g);
    expect(s.sourceId).toBe("public");
    expect(userNames(s)).toEqual([]);
    expect((await memoryScopeFor(g, {})).read).toBeNull();
  });

  test("the union is never resolved for the lock owner's id", async () => {
    await accountWithLinks("sub-1", [{ id: "U0AEXAMPLE" }, { id: "U1AEXAMPLE" }]);
    const spy = spyOn(PersonSlices, "personSlicesDetailed");
    try {
      await gateFor("U0ZEXAMPLE", { lockedUser: "U0AEXAMPLE" });
      expect(spy.mock.calls.map((c) => c[1])).toEqual(["U0ZEXAMPLE"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("the write target is the own slice and never a union member, on the KB and the memory scope", async () => {
    await accountWithLinks("sub-1", [{ id: "U0AEXAMPLE" }, { id: "U1AEXAMPLE" }]);
    const g = await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" });
    const s = await kbScope(g);
    expect(s.sourceId).toBe(U("U0AEXAMPLE"));
    expect(userNames(s)).toEqual([U("U0AEXAMPLE"), U("U1AEXAMPLE")]);
    const dm = await memoryScopeFor({ ...g, lockedUser: null, channelTrust: "unknown" }, { channel: "D0EXAMPLE" });
    expect(dm.write).toEqual({ clientId: "U0AEXAMPLE", sourceId: U("U0AEXAMPLE"), allowedSources: [U("U0AEXAMPLE")] });
    expect(dm.read!.allowedSources).toEqual([U("U0AEXAMPLE"), U("U1AEXAMPLE")]);
    const runAs = await memoryScopeFor(g, { runAsUser: "U0AEXAMPLE", runAsPerson: g.person });
    expect(runAs.write!.allowedSources).toEqual([U("U0AEXAMPLE")]);
    expect(runAs.read!.allowedSources).toEqual([U("U0AEXAMPLE"), U("U1AEXAMPLE")]);
  });

  test("a person attached for someone else, or a non-person name in it, is ignored (defence in depth)", async () => {
    const g = await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" });
    const evil = (own: string, reads: string[]) => ({ own, reads, via: "union" as const, dropped: { conflict: 0, tombstoned: 0 } });
    expect(userNames(await kbScope({ ...g, person: evil(U("U9OTHEREXAMPLE"), [U("U9OTHEREXAMPLE"), U("U1AEXAMPLE")]) }))).toEqual([U("U0AEXAMPLE")]);
    const s = await kbScope({ ...g, person: evil(U("U0AEXAMPLE"), [U("U0AEXAMPLE"), "shared", "agent-x", "public", "kb-x", "profile-t0-u0", "user-u1aexample"]) });
    const legacy = await kbScope({ ...g, person: undefined });
    // Only the one valid extra name is added to what rc.21 reads.
    expect(s.allowedSources.filter((x) => !legacy.allowedSources.includes(x))).toEqual(["user-u1aexample"]);
    expect(userNames(s)).toEqual([U("U0AEXAMPLE"), "user-u1aexample"]);
  });

  test("the scope sites re-check the flag: a person attached while the flag is not union adds nothing", async () => {
    await accountWithLinks("sub-1", [{ id: "U0AEXAMPLE" }, { id: "U1AEXAMPLE" }]);
    const g = await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" });
    expect(g.person?.reads).toHaveLength(2);
    for (const mode of ["off", "shadow", "garbage"]) {
      process.env.SLAUDE_PERSON_SLICES = mode;
      expect(userNames(await kbScope(g))).toEqual([U("U0AEXAMPLE")]);
      const dm = await memoryScopeFor({ ...g, lockedUser: null, channelTrust: "unknown" }, { channel: "D0EXAMPLE" });
      expect(dm.read!.allowedSources).toEqual([U("U0AEXAMPLE")]);
      expect((await memoryScopeFor(g, { runAsUser: "U0AEXAMPLE", runAsPerson: g.person })).read!.allowedSources).toEqual([U("U0AEXAMPLE")]);
    }
  });

  test("tombstones are honoured: a name, and the '*' row", async () => {
    const a = await accountWithLinks("sub-1", [{ id: "U0AEXAMPLE" }, { id: "U1AEXAMPLE" }, { id: "U2AEXAMPLE" }]);
    void a;
    const user = (await Domain.findBinding({ service: "slack", kind: "user", workspace: TEAM, value: "U0AEXAMPLE" }))!.user_id;
    await addTombstone({ userId: user, sourceId: U("U1AEXAMPLE"), createdBy: "op", reason: "x" });
    expect(userNames(await kbScope(await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" })))).toEqual([U("U0AEXAMPLE"), U("U2AEXAMPLE")]);
    await addTombstone({ userId: user, sourceId: "*", createdBy: "op", reason: "x" });
    expect(userNames(await kbScope(await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" })))).toEqual([U("U0AEXAMPLE")]);
  });
});

describe("failure modes fall back to the own slice, never wider; writes still land", () => {
  async function twoIds() {
    await accountWithLinks("sub-1", [{ id: "U0AEXAMPLE" }, { id: "U1AEXAMPLE" }]);
  }
  const ownOnly = async () => {
    const g = await gateFor("U0AEXAMPLE", { lockedUser: "U0AEXAMPLE" });
    expect(g.person).toBeUndefined();
    const s = await kbScope(g);
    expect(userNames(s)).toEqual([U("U0AEXAMPLE")]);
    expect(s.sourceId).toBe(U("U0AEXAMPLE"));
    return g;
  };

  test("the resolver throws", async () => {
    await twoIds();
    const bad = spyOn(Domain, "bindingsOf").mockRejectedValue(new Error("boom"));
    try {
      await ownOnly();
    } finally {
      bad.mockRestore();
    }
  });

  test("the resolver is slow past the bound", async () => {
    await twoIds();
    const orig = PersonSlices.personSlicesDetailed;
    const slow = spyOn(Domain, "bindingsOf").mockImplementation(() => new Promise(() => {}));
    const wrap = spyOn(PersonSlices, "personSlicesDetailed").mockImplementation((t, id) => orig(t, id, { timeoutMs: 40 }));
    try {
      const t0 = Date.now();
      await ownOnly();
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      slow.mockRestore();
      wrap.mockRestore();
    }
  });

  test("the tombstone table is unreadable", async () => {
    await twoIds();
    await db.run("ALTER TABLE slice_tombstones RENAME TO slice_tombstones_x");
    try {
      await ownOnly();
    } finally {
      await db.run("ALTER TABLE slice_tombstones_x RENAME TO slice_tombstones");
    }
  });

  test("the seam itself throws synchronously: no throw into the caller, legacy scope", async () => {
    await twoIds();
    const spy = spyOn(PersonSlices, "personSlicesDetailed").mockImplementation(() => {
      throw new Error("sync");
    });
    try {
      await ownOnly();
    } finally {
      spy.mockRestore();
    }
  });

  test("a write in a failed-resolver turn still lands in the writer's own slice", async () => {
    await twoIds();
    const brain = fakeBrain();
    const bad = spyOn(Domain, "bindingsOf").mockRejectedValue(new Error("boom"));
    try {
      const g = await gateFor("U0AEXAMPLE", { lockedUser: null, channelTrust: "unknown" });
      const dm = await memoryScopeFor(g, { channel: "D0EXAMPLE" });
      await brain.call("put_page", { slug: "conversations/s1", content: "x" }, dm.write!);
      expect(brain.contentOf(U("U0AEXAMPLE"), "conversations/s1")).toBe("x");
    } finally {
      bad.mockRestore();
    }
  });
});

describe("end to end with the fake brain", () => {
  async function dm(speaker: string) {
    const g = await gateFor(speaker, { lockedUser: null, channelTrust: "unknown" });
    return memoryScopeFor(g, { channel: "D0EXAMPLE" });
  }

  test("write as L, link both ids to one account, recall as S finds it; unlink S and it does not; a write as S is only ever in S's own slice", async () => {
    const brain = fakeBrain();
    const a = await accountWithLinks("sub-1", [{ id: "U0LEXAMPLE" }]);
    await brain.call("put_page", { slug: "conversations/s1", content: "fact from L" }, (await dm("U0LEXAMPLE")).write!);
    expect(brain.contentOf(U("U0LEXAMPLE"), "conversations/s1")).toBe("fact from L");
    // S is a second id, not yet proven: S cannot recall L's page.
    const seen = await newUser();
    await slack(seen, "U0SEXAMPLE", "observed");
    expect(await brain.call("get_page", { slug: "conversations/s1" }, (await dm("U0SEXAMPLE")).read!)).toBeNull();
    // S is proven on the same account (a proof merge makes one record): now recall works.
    expect((await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0SEXAMPLE", accountId: a.id, via: "test" })).ok).toBe(true);
    const found = (await brain.call("get_page", { slug: "conversations/s1" }, (await dm("U0SEXAMPLE")).read!)) as { content: string } | null;
    expect(found?.content).toBe("fact from L");
    // A write as S lands only in S's own slice.
    await brain.call("put_page", { slug: "conversations/s2", content: "fact from S" }, (await dm("U0SEXAMPLE")).write!);
    expect(brain.contentOf(U("U0SEXAMPLE"), "conversations/s2")).toBe("fact from S");
    expect(brain.contentOf(U("U0LEXAMPLE"), "conversations/s2")).toBeUndefined();
    // Unlink S: recall as S no longer finds L's page.
    await Accounts.unlinkSlackIdentity(TEAM, "U0SEXAMPLE", a.id);
    expect(await brain.call("get_page", { slug: "conversations/s1" }, (await dm("U0SEXAMPLE")).read!)).toBeNull();
    // L still reads its own.
    expect(await brain.call("get_page", { slug: "conversations/s1" }, (await dm("U0LEXAMPLE")).read!)).not.toBeNull();
  });

  test("with the flag off the same sequence never lets S recall L's page", async () => {
    process.env.SLAUDE_PERSON_SLICES = "off";
    const brain = fakeBrain();
    const a = await accountWithLinks("sub-1", [{ id: "U0LEXAMPLE" }, { id: "U0SEXAMPLE" }]);
    void a;
    await brain.call("put_page", { slug: "conversations/s1", content: "fact from L" }, (await dm("U0LEXAMPLE")).write!);
    expect(await brain.call("get_page", { slug: "conversations/s1" }, (await dm("U0SEXAMPLE")).read!)).toBeNull();
  });
});

afterAll(async () => {
  await cleanWorld();
});
