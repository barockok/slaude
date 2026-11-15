/**
 * THE RELEASE GATE for `SLAUDE_PERSON_SLICES=union` (slice F, task 8): a
 * cross-person leak property test. Random sequences of real operations against
 * the real tables (observe, link, unlink, relink to another account, console
 * merge, undo, a second Slack id for one person, the same Slack id string in two
 * workspaces, tombstones, deleted accounts and users, logins). After EVERY step,
 * for EVERY Slack identity, the read set the resolver gives must satisfy:
 *
 *  1. it starts with the identity's own legacy slice (nothing is ever lost);
 *  2. every other name is a plain `user-` name (never agent, shared, public, kb-, profile-);
 *  3. an acting binding that is not verified reads only its own slice;
 *  4. every other name is produced by a VERIFIED Slack binding held by the very
 *     user the (verified) acting binding belongs to, read from the tables, and
 *     that binding belongs, in the model's ground truth, to the same human;
 *  5. no other live user holds any binding that produces the name;
 *  6. no tombstone covers the name, judged with an independent reading of the table
 *     (the user's rows, its merged-away ids' rows, `*` for the user, and source-level
 *     rows with user `*`), not the repo function;
 *  5b. each of the acting binding and the producing binding has a row in
 *      `slack_identities` for an account of that user (the authoritative link: a
 *      swallowed unlink projection cannot keep a union alive);
 *  5c. in hold seeds, a producing binding is older than the hold, and a link to
 *      the WRONG human (ground truth differs) is therefore never readable during
 *      the hold window;
 *  7. a thread locked by another person gives exactly the public-only scope even
 *     when the speaker holds a union, and in the speaker's own lock the extra
 *     names are only the checked ones, with the write target still the own slice.
 *
 * Fixed seeds, so a failure reproduces; the failing prefix of the sequence is
 * printed. Seeds: SLAUDE_LEAK_SEEDS (default 400 on sqlite, 150 on Postgres).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Accounts from "../../src/db/accounts";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import { addTombstone, removeTombstone } from "../../src/db/slice-tombstones";
import { mergeUsers } from "../../src/domain/merge";
import { undoMerge } from "../../src/domain/merge-undo";
import { personSlices } from "../../src/knowledge/person-slices";
import { resolveBrainScope, userSourceId, type ScopeInput } from "../../src/knowledge/scope";
import { memoryScopeFor } from "../../src/memory/scope";
import { invalidateActors } from "../../src/refs/actor";
import { TEAM, TEAM2, resetWorld, cleanWorld } from "../helpers/person-world";

const ISS = "https://idp.example.com";
const NAME_OK = /^user-[a-z0-9]+$/;

/** Ground truth: which human owns each (team, id). A human proves only ids they own. */
interface Human {
  ids: Array<{ team: string; value: string }>;
  accounts: string[]; // subjects
}
const SHARED = "U9SHAREDEXAMPLE"; // one string, two humans, two workspaces: the cross-workspace case
const HUMANS: Human[] = [
  { ids: [{ team: TEAM, value: "U0AEXAMPLE" }, { team: TEAM, value: "U1AEXAMPLE" }, { team: TEAM2, value: "U2AEXAMPLE" }, { team: TEAM, value: SHARED }], accounts: ["sub-a1", "sub-a2"] },
  { ids: [{ team: TEAM, value: "U0BEXAMPLE" }, { team: TEAM2, value: "U1BEXAMPLE" }, { team: TEAM2, value: SHARED }], accounts: ["sub-b1"] },
  { ids: [{ team: TEAM, value: "U0CEXAMPLE" }, { team: TEAM2, value: "U0CEXAMPLE" }, { team: TEAM, value: "U1CEXAMPLE" }], accounts: ["sub-c1", "sub-c2"] },
  { ids: [{ team: TEAM, value: "U0DEXAMPLE" }], accounts: ["sub-d1"] },
];
const humanOf = (team: string, value: string): number => HUMANS.findIndex((h) => h.ids.some((i) => i.team === team && i.value === value));

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

interface SlackRow { id: string; user_id: string; workspace: string; value: string; state: string; verified_at: number | string | null }
const slackRows = () => db.query<SlackRow>("SELECT id, user_id, workspace, value, state, verified_at FROM bindings WHERE service = 'slack' AND kind = 'user' ORDER BY id");

/** All checks, after one step. Returns the number of identities checked. */
/** Independent tombstone semantics, straight from the table (not `tombstonesFor`). */
async function tombstoned(userId: string, name: string): Promise<boolean> {
  const rows = await db.query<{ user_id: string; source_id: string }>("SELECT user_id, source_id FROM slice_tombstones");
  const olds = new Set((await db.query<{ old_id: string }>("SELECT old_id FROM user_aliases WHERE user_id = ?", [userId])).map((r) => r.old_id));
  return rows.some((r) => {
    const forReader = r.user_id === userId || olds.has(r.user_id);
    if (forReader && (r.source_id === "*" || r.source_id === name)) return true;
    return r.user_id === "*" && r.source_id === name; // source-level: every reader
  });
}

/** Independent link table read: the (team, id) pairs linked to an account of this user. */
async function linked(userId: string): Promise<Set<string>> {
  const rows = await db.query<{ t: string; v: string }>(
    `SELECT s.team_id AS t, s.slack_user_id AS v FROM slack_identities s
     JOIN accounts a ON a.id = s.account_id
     JOIN bindings o ON o.service = 'oidc' AND o.workspace = a.issuer AND o.value = a.subject
     WHERE o.user_id = ?`,
    [userId],
  );
  return new Set(rows.map((r) => `${r.t}|${r.v}`));
}

let unionsSeen = 0;
let wrongHumanReadable = 0;
async function assertNoLeak(): Promise<number> {
  const rows = await slackRows();
  const liveUsers = new Set((await db.query<{ id: string }>("SELECT id FROM users")).map((u) => u.id));
  for (const a of rows) {
    const where = `acting=${a.workspace}/${a.value} state=${a.state}`;
    const person = await personSlices(a.workspace, a.value);
    const own = userSourceId(a.value);
    // 1
    expect({ where, first: person.reads[0] }).toEqual({ where, first: own });
    expect(person.own).toBe(own);
    const extras = person.reads.slice(1);
    if (extras.length > 0) unionsSeen++;
    expect({ where, dup: new Set(person.reads).size }).toEqual({ where, dup: person.reads.length });
    // 3
    if (a.state !== "verified") expect({ where, extras }).toEqual({ where, extras: [] });
    const holdMs = Number(process.env.SLAUDE_PERSON_SLICES_HOLD_HOURS ?? "0") * 3_600_000;
    const links = await linked(a.user_id);
    const now = Date.now();
    const aged = (b: SlackRow) => holdMs === 0 || (b.verified_at !== null && now - Number(b.verified_at) >= holdMs);
    for (const name of extras) {
      // 2
      expect({ where, name, ok: NAME_OK.test(name) }).toEqual({ where, name, ok: true });
      // 4: verified acting binding, verified producing binding on the SAME user, same human in the ground truth
      expect({ where, acting: a.state }).toEqual({ where, acting: "verified" });
      const producers = rows.filter((b) => userSourceId(b.value) === name);
      const mine = producers.filter((b) => b.user_id === a.user_id && b.state === "verified" && links.has(`${b.workspace}|${b.value}`));
      expect({ where, name, mine: mine.length > 0 }).toEqual({ where, name, mine: true });
      // 5b, 5c
      expect({ where, actingLinked: links.has(`${a.workspace}|${a.value}`) }).toEqual({ where, actingLinked: true });
      expect({ where, name, aged: mine.some(aged) }).toEqual({ where, name, aged: true });
      for (const b of mine.filter(aged)) {
        const same = humanOf(b.workspace, b.value) === humanOf(a.workspace, a.value);
        if (!same) {
          // A wrong-human link may be read only after the hold, and never with the hold off by accident.
          wrongHumanReadable++;
          expect({ where, name, heldLongEnough: holdMs > 0 && aged(b) }).toEqual({ where, name, heldLongEnough: true });
        }
      }
      // 5
      expect({ where, name, others: producers.filter((b) => b.user_id !== a.user_id).length }).toEqual({ where, name, others: 0 });
      // 6
      expect({ where, name, tomb: await tombstoned(a.user_id, name) }).toEqual({ where, name, tomb: false });
    }
    expect(liveUsers.has(a.user_id)).toBe(true);
    // 7: the scopes built from this person
    const withPerson = extras.length > 0 ? { ...person } : undefined;
    const base: ScopeInput = { userId: a.value, teamId: a.workspace, lockedUser: "U0NOTSAMEEXAMPLE", channelTrust: "trusted", isManager: false, kbSources: [], agentId: "agent-one", person: withPerson };
    const locked = await resolveBrainScope(base);
    expect({ where, src: locked.sourceId, user: locked.allowedSources.filter((s) => s.startsWith("user-")) }).toEqual({ where, src: "public", user: [] });
    const mine = await resolveBrainScope({ ...base, lockedUser: a.value });
    expect(mine.sourceId).toBe(own);
    expect(mine.allowedSources.filter((s) => s.startsWith("user-"))).toEqual(person.reads);
    const mem = await memoryScopeFor({ ...base, lockedUser: null, interactive: true }, { channel: "D0EXAMPLE", runAsUser: null });
    if (mem.write) expect(mem.write.allowedSources).toEqual([mem.write.sourceId]);
  }
  return rows.length;
}

describe.each(["union"])("cross-person leak property (%s)", () => {
  const accountIds = new Map<string, string>(); // subject -> account id
  let log: string[];
  let holdSeed = false;
  beforeAll(() => {
    process.env.SLAUDE_PERSON_SLICES = "union";
    process.env.SLAUDE_MERGE_NOTICE = "off";
  });
  afterAll(() => {
    delete process.env.SLAUDE_PERSON_SLICES;
    delete process.env.SLAUDE_PERSON_SLICES_HOLD_HOURS;
    delete process.env.SLAUDE_MERGE_NOTICE;
  });
  beforeEach(async () => {
    await resetWorld();
    await db.run("DELETE FROM audit_events");
    await db.run("DELETE FROM link_token_uses");
    accountIds.clear();
    log = [];
    spyOn(console, "warn").mockImplementation(() => {});
    spyOn(console, "log").mockImplementation(() => {});
  });

  async function account(subject: string): Promise<string> {
    let id = accountIds.get(subject);
    const alive = id ? await Accounts.findAccountById(id) : null;
    if (!id || !alive) {
      id = (await Accounts.upsertAccount({ issuer: ISS, subject, email: `${subject}@example.com`, emailProven: false })).id;
      accountIds.set(subject, id);
    }
    return id;
  }

  async function step(r: () => number): Promise<void> {
    const hi = Math.floor(r() * HUMANS.length);
    const h = HUMANS[hi]!;
    const idn = pick(r, h.ids);
    const op = Math.floor(r() * 18);
    const tag = `${op}:h${hi}:${idn.team}/${idn.value}`;
    switch (op) {
      case 0:
      case 1: { // observe: first sight of an id
        log.push(`observe ${tag}`);
        if (!(await Domain.findBinding({ service: "slack", kind: "user", workspace: idn.team, value: idn.value }))) {
          const u = await Domain.ensureUser({});
          await Domain.ensureBinding({ service: "slack", kind: "user", workspace: idn.team, value: idn.value, userId: u.id, state: "observed", source: "test" });
        }
        break;
      }
      case 2:
      case 3:
      case 4: { // link: the owner proves an id into one of their own accounts
        const acct = await account(pick(r, h.accounts));
        log.push(`link ${tag} -> ${acct.slice(0, 4)}`);
        await Accounts.linkSlackIdentity({ teamId: idn.team, slackUserId: idn.value, accountId: acct, via: "test" });
        break;
      }
      case 5: { // unlink
        const rows = await db.query<{ team_id: string; slack_user_id: string; account_id: string }>("SELECT team_id, slack_user_id, account_id FROM slack_identities");
        if (rows.length) {
          const l = pick(r, rows);
          log.push(`unlink ${l.team_id}/${l.slack_user_id}`);
          await Accounts.unlinkSlackIdentity(l.team_id, l.slack_user_id, l.account_id);
        }
        break;
      }
      case 6: { // relink to another account of the same human
        const rows = await db.query<{ team_id: string; slack_user_id: string; account_id: string }>("SELECT team_id, slack_user_id, account_id FROM slack_identities");
        if (rows.length) {
          const l = pick(r, rows);
          const owner = humanOf(l.team_id, l.slack_user_id);
          const hum = HUMANS[owner >= 0 ? owner : 0]!;
          log.push(`relink ${l.team_id}/${l.slack_user_id}`);
          await Accounts.unlinkSlackIdentity(l.team_id, l.slack_user_id, l.account_id);
          const to = await account(pick(r, hum.accounts));
          await Accounts.linkSlackIdentity({ teamId: l.team_id, slackUserId: l.slack_user_id, accountId: to, via: "test" });
        }
        break;
      }
      case 7:
      case 8: { // console merge of two live users (an operator may merge anything the engine allows)
        const users = (await db.query<{ id: string }>("SELECT id FROM users WHERE kind = 'person' ORDER BY id")).map((u) => u.id);
        if (users.length >= 2) {
          const a = pick(r, users);
          const b = pick(r, users.filter((x) => x !== a));
          log.push(`merge ${a.slice(0, 4)}+${b.slice(0, 4)}`);
          await mergeUsers({ survivorId: a, loserId: b, kind: "console", actor: "UOPERATOR", pickSurvivor: true });
        }
        break;
      }
      case 9: { // undo
        const ms = await db.query<{ id: string }>("SELECT id FROM user_merges WHERE state = 'applied' ORDER BY id");
        if (ms.length) {
          const m = pick(r, ms);
          log.push(`undo ${m.id.slice(0, 4)}`);
          await undoMerge({ mergeId: m.id, actor: "op@example.com", reason: "test" });
        }
        break;
      }
      case 10: { // tombstone add
        const users = await db.query<{ id: string }>("SELECT id FROM users ORDER BY id");
        if (users.length) {
          const u = pick(r, users);
          const names = [...new Set((await slackRows()).map((b) => userSourceId(b.value))), "*"];
          const n = pick(r, names);
          log.push(`tombstone+ ${u.id.slice(0, 4)} ${n === "*" ? "*" : "name"}`);
          await addTombstone({ userId: u.id, sourceId: n, createdBy: "op", reason: "test" });
        }
        break;
      }
      case 11: { // tombstone remove
        const t = await db.query<{ user_id: string; source_id: string }>("SELECT user_id, source_id FROM slice_tombstones");
        if (t.length) {
          const x = pick(r, t);
          log.push(`tombstone- ${x.user_id.slice(0, 4)}`);
          await removeTombstone(x.user_id, x.source_id);
        }
        break;
      }
      case 12: { // delete an account (its links and credentials go; bindings demote)
        const ids = [...accountIds.values()];
        if (ids.length) {
          const a = pick(r, ids);
          log.push(`deleteAccount ${a.slice(0, 4)}`);
          await Accounts.deleteAccount(a);
        }
        break;
      }
      case 14: { // time passes: a verified binding gets older than the hold
        const rows = await slackRows();
        if (rows.length) {
          const b = pick(r, rows);
          log.push(`age ${b.workspace}/${b.value}`);
          await db.run("UPDATE bindings SET verified_at = verified_at - ? WHERE id = ? AND verified_at IS NOT NULL", [2 * 3_600_000, b.id]);
        }
        break;
      }
      case 15: { if (!holdSeed) break; // a mistaken link: a bearer token redeemed by the WRONG human, into their account
        const other = HUMANS[(hi + 1 + Math.floor(r() * (HUMANS.length - 1))) % HUMANS.length]!;
        const victimId = pick(r, other.ids);
        const acct = await account(pick(r, h.accounts));
        log.push(`WRONG link ${victimId.team}/${victimId.value} (human ${humanOf(victimId.team, victimId.value)}) -> h${hi}`);
        await Accounts.linkSlackIdentity({ teamId: victimId.team, slackUserId: victimId.value, accountId: acct, via: "test" });
        break;
      }
      case 16: { // an unlink whose projection fails (swallowed): the binding outlives the link row
        const rows = await db.query<{ team_id: string; slack_user_id: string; account_id: string }>("SELECT team_id, slack_user_id, account_id FROM slack_identities");
        if (rows.length) {
          const l = pick(r, rows);
          log.push(`unlink with failing projection ${l.team_id}/${l.slack_user_id}`);
          const bad = spyOn(Domain, "findBinding").mockRejectedValue(new Error("projection down"));
          try {
            await Accounts.unlinkSlackIdentity(l.team_id, l.slack_user_id, l.account_id);
          } finally {
            bad.mockRestore();
          }
        }
        break;
      }
      case 17: { // a source-level tombstone, for every reader
        const names = [...new Set((await slackRows()).map((b) => userSourceId(b.value)))];
        if (names.length) {
          const n = pick(r, names);
          log.push("tombstone all-readers");
          await addTombstone({ userId: "*", sourceId: n, createdBy: "op", reason: "test" });
        }
        break;
      }
      default: { // purge a user record outright (operator), when nothing references it
        const users = await db.query<{ id: string }>("SELECT id FROM users ORDER BY id");
        if (users.length) {
          const u = pick(r, users);
          log.push(`purgeUser ${u.id.slice(0, 4)}`);
          try {
            await db.transaction(async (tx) => {
              await tx.run("DELETE FROM bindings WHERE user_id = ?", [u.id]);
              await tx.run("DELETE FROM users WHERE id = ?", [u.id]);
            });
          } catch {
            /* referenced by an alias or a grant: nothing purged */
          }
        }
      }
    }
    invalidateActors();
  }

  const seeds = Number(process.env.SLAUDE_LEAK_SEEDS ?? (process.env.SLAUDE_DB === "pg" ? 150 : 400));
  test(`${seeds} seeded sequences, every identity checked after every step`, async () => {
    let checked = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      await resetWorld();
      // Even seeds run with the hold off (unions form at once); odd seeds with a one hour hold, ageing and wrong links.
      holdSeed = seed % 2 === 1;
      process.env.SLAUDE_PERSON_SLICES_HOLD_HOURS = holdSeed ? "1" : "0";
      await db.run("DELETE FROM link_token_uses");
      accountIds.clear();
      log = [];
      const r = rng(seed * 7919);
      for (let i = 0; i < 28; i++) {
        await step(r);
        try {
          checked += await assertNoLeak();
        } catch (e) {
          throw new Error(`seed ${seed} step ${i}: leak check failed after:\n  ${log.join("\n  ")}\n${(e as Error).message}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(seeds * 10);
    // Not vacuous: unions really formed (a person with two verified ids), and some were cut by a rule.
    expect(unionsSeen).toBeGreaterThan(seeds);
    // The hold seeds do see a wrong-human slice become readable, and only after the hold (asserted above).
    if (seeds >= 200) expect(wrongHumanReadable).toBeGreaterThan(0);
  }, 1_800_000);
});

describe("the leak checker catches a leak (it is not vacuous)", () => {
  beforeEach(async () => {
    await resetWorld();
    process.env.SLAUDE_PERSON_SLICES = "union";
    spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(() => {
    delete process.env.SLAUDE_PERSON_SLICES;
  });

  async function seedPair(state2: Domain.State) {
    const u = await Domain.ensureUser({});
    await Domain.ensureBinding({ service: "slack", kind: "user", workspace: TEAM, value: "U0AEXAMPLE", userId: u.id, state: "verified", source: "t" });
    await Domain.ensureBinding({ service: "slack", kind: "user", workspace: TEAM, value: "U1AEXAMPLE", userId: u.id, state: state2, source: "t" });
    return u.id;
  }

  test("a union that includes an observed id is reported", async () => {
    await seedPair("observed");
    const real = await import("../../src/knowledge/person-slices");
    const spy = spyOn(real, "personSlices").mockImplementation(async (_t, id) => ({ own: userSourceId(id), reads: [userSourceId(id), "user-u1aexample"], via: "union", dropped: { conflict: 0, tombstoned: 0 } }));
    try {
      await expect(assertNoLeak()).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  test("a non-person name in the union is reported", async () => {
    await seedPair("verified");
    const real = await import("../../src/knowledge/person-slices");
    const spy = spyOn(real, "personSlices").mockImplementation(async (_t, id) => ({ own: userSourceId(id), reads: [userSourceId(id), "shared"], via: "union", dropped: { conflict: 0, tombstoned: 0 } }));
    try {
      await expect(assertNoLeak()).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  test("a tombstoned name still in the union is reported", async () => {
    const u = await seedPair("verified");
    await addTombstone({ userId: u, sourceId: "user-u1aexample", createdBy: "op", reason: "x" });
    const real = await import("../../src/knowledge/person-slices");
    const spy = spyOn(real, "personSlices").mockImplementation(async (_t, id) => ({ own: userSourceId(id), reads: [userSourceId(id), id === "U0AEXAMPLE" ? "user-u1aexample" : "user-u0aexample"], via: "union", dropped: { conflict: 0, tombstoned: 0 } }));
    try {
      await expect(assertNoLeak()).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  test("a fresh binding inside the hold, or one with no link, in a union is reported", async () => {
    await seedPair("verified");
    process.env.SLAUDE_PERSON_SLICES_HOLD_HOURS = "1";
    const real = await import("../../src/knowledge/person-slices");
    const spy = spyOn(real, "personSlices").mockImplementation(async (_t, id) => ({ own: userSourceId(id), reads: [userSourceId(id), id === "U0AEXAMPLE" ? "user-u1aexample" : "user-u0aexample"], via: "union", dropped: { conflict: 0, tombstoned: 0 } }));
    try {
      await expect(assertNoLeak()).rejects.toThrow(); // no link rows, and both verified just now
    } finally {
      spy.mockRestore();
      process.env.SLAUDE_PERSON_SLICES_HOLD_HOURS = "0";
    }
  });

  test("a source-level tombstone still in a union is reported", async () => {
    await seedPair("verified");
    await addTombstone({ userId: "*", sourceId: "user-u1aexample", createdBy: "op", reason: "x" });
    const real = await import("../../src/knowledge/person-slices");
    const spy = spyOn(real, "personSlices").mockImplementation(async (_t, id) => ({ own: userSourceId(id), reads: [userSourceId(id), id === "U0AEXAMPLE" ? "user-u1aexample" : "user-u0aexample"], via: "union", dropped: { conflict: 0, tombstoned: 0 } }));
    try {
      await expect(assertNoLeak()).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  test("the honest resolver passes on the same worlds", async () => {
    await seedPair("verified");
    await assertNoLeak();
    await resetWorld();
    await seedPair("observed");
    await assertNoLeak();
  });
});

afterAll(async () => {
  await cleanWorld();
});
