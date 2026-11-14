import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as AgentGrants from "../../src/db/agent-grants";
import * as Domain from "../../src/db/domain";
import { db, type DbClient } from "../../src/db/schema";
import { mergeUsers, UNDO_WINDOW_MS, type MergeInput } from "../../src/domain/merge";
import { actingUser, actorCacheSize } from "../../src/refs/actor";
import { oidcKey as oidcVetoKey, orderedPair, slackKey as slackVetoKey } from "../../src/domain/merge-keys";

const TEAM = "T0EXAMPLE";
const slackKey = (value: string) => ({ service: "slack", kind: "user", workspace: TEAM, value });
const mailKey = (value: string) => ({ service: "email", kind: "address", workspace: "", value });
const oidcKey = (subject: string) => ({ service: "oidc", kind: "subject", workspace: "https://idp.example.com", value: subject });
const count = async (t: string, where = "1 = 1") => Number((await db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`))!.n);

async function person(opts: { slack?: string; slackState?: Domain.State; email?: string; emailState?: Domain.State; oidc?: string; kind?: Domain.UserKind } = {}) {
  const u = await Domain.ensureUser({ kind: opts.kind ?? "person" });
  if (opts.slack) await Domain.ensureBinding({ ...slackKey(opts.slack), userId: u.id, state: opts.slackState ?? "observed", source: "test" });
  if (opts.email) await Domain.ensureBinding({ ...mailKey(opts.email), userId: u.id, state: opts.emailState ?? "observed", source: "test" });
  if (opts.oidc) await Domain.ensureBinding({ ...oidcKey(opts.oidc), userId: u.id, state: "verified", source: "test" });
  return u.id;
}
const input = (survivorId: string, loserId: string, over: Partial<MergeInput> = {}): MergeInput => ({ survivorId, loserId, kind: "console", actor: "UOPERATOR", ...over });
const merge = (i: MergeInput) => db.transaction((tx) => mergeUsers(i, tx));

beforeEach(async () => {
  await db.run("DELETE FROM agent_grants");
  await db.run("DELETE FROM audit_events");
  await Domain._wipeForTests();
  delete process.env.SLAUDE_AUTO_MERGE;
  process.env.SLAUDE_ACCESS_SOURCE = "internal";
});
afterEach(() => {
  delete process.env.SLAUDE_ACCESS_SOURCE;
  delete process.env.SLAUDE_AUTO_MERGE;
  spyOn(console, "log").mockRestore();
});

describe("mergeUsers", () => {
  test("moves bindings and aliases, deletes the loser, writes the ledger", async () => {
    const s = await person({ slack: "U0SURV", slackState: "observed" });
    const l = await person({ slack: "U0LOSE", email: "lose@example.com" });
    const older = await person();
    await db.run("INSERT INTO user_aliases (old_id, user_id, merged_at) VALUES (?, ?, 1)", [older + "-old", l]);
    const r = await merge(input(s, l));
    expect(r.status).toBe("merged");
    if (r.status !== "merged") return;
    expect(await Domain.getUser(l)).toBeNull();
    expect((await Domain.findBinding(slackKey("U0LOSE")))?.user_id).toBe(s);
    expect((await Domain.findBinding(mailKey("lose@example.com")))?.user_id).toBe(s);
    expect(await Domain.resolveUserId(l)).toBe(s);
    expect(await Domain.resolveUserId(older + "-old")).toBe(s);
    expect(r.merge).toMatchObject({ kind: "console", survivor_id: s, loser_id: l, state: "applied", actor: "UOPERATOR", notice_state: "pending" });
    expect(r.merge.undo_until - r.merge.created_at).toBe(UNDO_WINDOW_MS);
    expect(r.merge.moved.bindings.map((b) => b.to)).toEqual([s, s]);
    expect(r.merge.moved.aliases_added).toEqual([l]);
    expect(r.merge.moved.aliases_repointed).toEqual([{ old_id: older + "-old", from: l, to: s }]);
    expect(r.merge.moved.loser.id).toBe(l);
    // The ledger holds ids and states, never a binding value.
    expect(JSON.stringify(r.merge)).not.toContain("lose@example.com");
    expect(JSON.stringify(r.merge)).not.toContain("U0LOSE");
  });

  test("merging twice is a no-op that returns the ledger row", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE" });
    const first = await merge(input(s, l));
    const second = await merge(input(s, l));
    expect(second.status).toBe("noop");
    expect(second.status === "noop" && second.merge?.id).toBe(first.status === "merged" ? first.merge.id : "");
    expect(await count("user_merges")).toBe(1);
    expect(await count("users")).toBe(1);
  });

  test("a into b and b into a give one applied row", async () => {
    const a = await person({ slack: "U0AAA" });
    const b = await person({ slack: "U0BBB" });
    const [x, y] = await Promise.all([merge(input(b, a)), merge(input(a, b))]);
    expect([x.status, y.status].sort()).toEqual(["merged", "noop"]);
    expect(await count("user_merges", "state = 'applied'")).toBe(1);
    expect(await count("users")).toBe(1);
  });

  test("a chain a to b to c resolves every old id", async () => {
    const a = await person({ slack: "U0AAA" });
    const b = await person({ slack: "U0BBB" });
    const c = await person({ slack: "U0CCC" });
    await merge(input(b, a));
    await merge(input(c, b));
    expect(await Domain.resolveUserId(a)).toBe(c);
    expect(await Domain.resolveUserId(b)).toBe(c);
    expect(await count("bindings", `user_id = '${c}'`)).toBe(3);
    // Merging the old id again resolves through aliases and changes nothing.
    expect((await merge(input(c, a))).status).toBe("noop");
  });

  test("survivor rule: the record holding something verified, else the older, ties by id", async () => {
    // Verified wins over age.
    const young = await person({ slack: "U0YOUNG", slackState: "verified" });
    await new Promise((r) => setTimeout(r, 3));
    const old = await person({ slack: "U0OLD" });
    await db.run("UPDATE users SET created_at = 1 WHERE id = ?", [old]);
    const r1 = await merge(input(old, young, { pickSurvivor: true }));
    expect(r1.status === "merged" && r1.survivorId).toBe(young);
    // Neither verified: the older survives, whichever side the caller named survivor.
    const p = await person({ slack: "U0P" });
    const q = await person({ slack: "U0Q" });
    await db.run("UPDATE users SET created_at = 5 WHERE id = ?", [p]);
    await db.run("UPDATE users SET created_at = 9 WHERE id = ?", [q]);
    const r2 = await merge(input(q, p, { pickSurvivor: true }));
    expect(r2.status === "merged" && r2.survivorId).toBe(p);
    // Equal age: the lower id.
    const x = await person({ slack: "U0X" });
    const y = await person({ slack: "U0Y" });
    await db.run("UPDATE users SET created_at = 7 WHERE id IN (?, ?)", [x, y]);
    const r3 = await merge(input(x < y ? y : x, x < y ? x : y, { pickSurvivor: true }));
    expect(r3.status === "merged" && r3.survivorId).toBe(x < y ? x : y);
    // Without the rule the named survivor survives.
    const m = await person({ slack: "U0M" });
    const n = await person({ slack: "U0N" });
    await db.run("UPDATE users SET created_at = 1 WHERE id = ?", [n]);
    const r4 = await merge(input(m, n));
    expect(r4.status === "merged" && r4.survivorId).toBe(m);
  });

  test("a loser holding any verified binding is refused and proposed, nothing moves", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ oidc: "sub-1", slack: "U0LOSE" });
    const r = await merge(input(s, l));
    expect(r).toMatchObject({ status: "refused", reason: "verified-loser" });
    expect(await Domain.getUser(l)).not.toBeNull();
    expect((await Domain.findBinding(slackKey("U0LOSE")))?.user_id).toBe(l);
    const p = await db.one<{ user_a: string; user_b: string; reason: string; state: string }>("SELECT * FROM merge_proposals");
    expect(p).toMatchObject({ reason: "conflict", state: "open" });
    expect([p!.user_a, p!.user_b].sort()).toEqual([s, l].sort());
    expect(await count("user_merges")).toBe(0);
    // Asking again does not duplicate the proposal.
    await merge(input(s, l));
    expect(await count("merge_proposals")).toBe(1);
  });

  test("a bot or an agent record is refused on either side", async () => {
    const person1 = await person({ slack: "U0PERSON" });
    const bot = await person({ slack: "U0BOT", kind: "bot" });
    const agent = await person({ kind: "agent" });
    expect(await merge(input(person1, bot))).toMatchObject({ status: "refused", reason: "bot-or-agent" });
    expect(await merge(input(bot, person1))).toMatchObject({ status: "refused", reason: "bot-or-agent" });
    expect(await merge(input(person1, agent))).toMatchObject({ status: "refused", reason: "bot-or-agent" });
    expect(await count("users")).toBe(3);
  });

  test("two different verified emails on one record are refused as two-emails", async () => {
    const s = await person({ oidc: "sub-1", email: "one@example.com", emailState: "verified" });
    const l = await person({ email: "two@example.com", emailState: "observed" });
    const held = (await Domain.findBinding(mailKey("two@example.com")))!;
    const r = await merge(input(s, l, { kind: "proof", actor: "system", raise: { bindingId: held.id } }));
    expect(r).toMatchObject({ status: "refused", reason: "two-emails" });
    expect((await db.one<{ reason: string }>("SELECT reason FROM merge_proposals"))?.reason).toBe("two-emails");
    expect((await Domain.findBinding(mailKey("two@example.com")))?.state).toBe("observed");
  });

  test("a veto for the (Slack binding, oidc binding) pair is honoured, by any kind", async () => {
    const s = await person({ oidc: "sub-1" });
    const l = await person({ slack: "U0LOSE" });
    const sb = (await Domain.findBinding(slackKey("U0LOSE")))!;
    const ob = (await Domain.findBinding(oidcKey("sub-1")))!;
    void sb;
    void ob;
    await db.run("INSERT INTO merge_vetoes (id, key_a, key_b, created_by, created_at) VALUES ('v1', ?, ?, 'op', 1)", orderedPair(slackVetoKey(TEAM, "U0LOSE"), oidcVetoKey("https://idp.example.com", "sub-1")));
    expect(await merge(input(s, l))).toMatchObject({ status: "refused", reason: "veto" });
    expect(await merge(input(s, l, { kind: "proof", actor: "system" }))).toMatchObject({ status: "refused", reason: "veto" });
    expect(await Domain.getUser(l)).not.toBeNull();
    // An unrelated pair is not affected.
    const other = await person({ slack: "U0OTHER" });
    expect((await merge(input(s, other))).status).toBe("merged");
  });

  test("SLAUDE_AUTO_MERGE=off makes a proof merge a proposal; a console merge still works", async () => {
    process.env.SLAUDE_AUTO_MERGE = "off";
    const s = await person({ oidc: "sub-1" });
    const l = await person({ slack: "U0LOSE" });
    expect(await merge(input(s, l, { kind: "proof", actor: "system" }))).toMatchObject({ status: "refused", reason: "auto-merge-off" });
    expect(await count("merge_proposals")).toBe(1);
    expect((await merge(input(s, l))).status).toBe("merged");
  });

  test("repoints stored grants, records them, and leaves grants of others alone", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE" });
    const other = await person({ slack: "U0OTHER" });
    const g1 = await AgentGrants.create({ persona: "scout", subjectKind: "user", subjectId: "U0LOSE", role: "member", createdBy: "UOPERATOR" });
    const g2 = await AgentGrants.create({ persona: "scout", subjectKind: "user", subjectId: "U0OTHER", role: "member", createdBy: "UOPERATOR" });
    await db.run("UPDATE agent_grants SET subject_user_id = ? WHERE id = ?", [l, g1.id]);
    await db.run("UPDATE agent_grants SET subject_user_id = ? WHERE id = ?", [other, g2.id]);
    const r = await merge(input(s, l));
    expect(r.status === "merged" && r.merge.moved.grants).toEqual([{ id: g1.id, persona: "scout", from: l, to: s }]);
    expect((await db.one<{ subject_user_id: string }>("SELECT subject_user_id FROM agent_grants WHERE id = ?", [g1.id]))!.subject_user_id).toBe(s);
    expect((await db.one<{ subject_user_id: string }>("SELECT subject_user_id FROM agent_grants WHERE id = ?", [g2.id]))!.subject_user_id).toBe(other);
  });

  test("activated and inactive_privileged come from diffing the grants that reach the survivor", async () => {
    // The survivor is an account user with a verified Slack binding; the loser is an observed record holding an email.
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "verified" });
    const l = await person({ email: "boss@example.com", slack: "U0LOSE" });
    const put = (id: string, subjectId: string, role: string) =>
      db.run(
        `INSERT INTO agent_grants (id, persona, subject_kind, subject_id, role, deny, dm_only, created_by, created_at${db.dialect === "pg" ? ", tenant_id" : ""})
         VALUES (?, 'scout', 'user', ?, ?, ${db.dialect === "pg" ? "FALSE, FALSE" : "0, 0"}, 'UOP', 1${db.dialect === "pg" ? ", 'default'" : ""})`,
        [id, subjectId, role],
      );
    await put("g-email-member", "email:boss@example.com", "member");
    await put("g-email-manager", "email:boss@example.com", "manager");
    await put("g-slack-member", "U0LOSE", "member");
    await put("g-user-approver", `user:${l}`, "approver");
    const held = (await Domain.findBinding(mailKey("boss@example.com")))!;
    const r = await merge(input(s, l, { kind: "proof", actor: "system", raise: { bindingId: held.id } }));
    expect(r.status).toBe("merged");
    if (r.status !== "merged") return;
    const act = r.merge.moved.activated.map((a) => a.entry).sort();
    // g-slack-member named the loser's own Slack id: it reached that record before the merge, so it is not new reach.
    expect(act).toEqual(["grant:g-email-manager", "grant:g-email-member", "grant:g-user-approver"]);
    expect(r.merge.moved.activated.find((a) => a.entry === "grant:g-email-manager")).toMatchObject({ persona: "scout", role: "manager", source: "console", privileged: true });
    expect(r.merge.moved.inactive_privileged).toEqual([]);
    expect(r.merge.moved.raised).toEqual([{ binding_id: held.id, from_state: "observed", to_state: "verified", verified_at: expect.any(Number) }]);
    expect((await Domain.findBinding(mailKey("boss@example.com")))?.state).toBe("verified");
    expect(JSON.stringify(r.merge)).not.toContain("boss@example.com");
  });

  test("a privileged grant waits when the survivor has no verified Slack binding", async () => {
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "observed" });
    const l = await person({ email: "boss@example.com" });
    await db.run(
      `INSERT INTO agent_grants (id, persona, subject_kind, subject_id, role, deny, dm_only, created_by, created_at${db.dialect === "pg" ? ", tenant_id" : ""})
       VALUES ('g1', 'scout', 'user', 'email:boss@example.com', 'manager', ${db.dialect === "pg" ? "FALSE, FALSE" : "0, 0"}, 'UOP', 1${db.dialect === "pg" ? ", 'default'" : ""})`,
    );
    const held = (await Domain.findBinding(mailKey("boss@example.com")))!;
    const r = await merge(input(s, l, { kind: "proof", actor: "system", raise: { bindingId: held.id } }));
    expect(r.status === "merged" && r.merge.moved.activated).toEqual([]);
    expect(r.status === "merged" && r.merge.moved.inactive_privileged).toEqual([{ persona: "scout", role: "manager", entry: "grant:g1" }]);
  });

  test("an observed email never reaches an email grant; a merge never raises a state by itself", async () => {
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "verified" });
    const l = await person({ email: "boss@example.com", emailState: "observed", slack: "U0LOSE" });
    await db.run(
      `INSERT INTO agent_grants (id, persona, subject_kind, subject_id, role, deny, dm_only, created_by, created_at${db.dialect === "pg" ? ", tenant_id" : ""})
       VALUES ('g1', 'scout', 'user', 'email:boss@example.com', 'member', ${db.dialect === "pg" ? "FALSE, FALSE" : "0, 0"}, 'UOP', 1${db.dialect === "pg" ? ", 'default'" : ""})`,
    );
    const r = await merge(input(s, l));
    expect(r.status === "merged" && r.merge.moved.activated).toEqual([]);
    expect(r.status === "merged" && r.merge.moved.raised).toEqual([]);
    expect((await Domain.findBinding(slackKey("U0LOSE")))?.state).toBe("observed");
  });

  test("a failure while writing the ledger rolls the whole move back to the savepoint", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE", email: "lose@example.com" });
    await db.run("INSERT INTO user_aliases (old_id, user_id, merged_at) VALUES ('old-l', ?, 1)", [l]);
    const failing = (inner: DbClient) =>
      new Proxy(inner, {
        get(t, p, r) {
          if (p !== "run") return Reflect.get(t, p, r);
          return async (sql: string, params?: unknown[]) => {
            if (sql.includes("INSERT INTO user_merges")) throw new Error("ledger down");
            return t.run(sql, params as never);
          };
        },
      }) as DbClient;
    // The caller's transaction survives (it decides), and nothing the engine did is left in it.
    await db.transaction(async (tx) => {
      await expect(mergeUsers(input(s, l), failing(tx))).rejects.toThrow("ledger down");
      expect(await Domain.getUser(l, tx)).not.toBeNull();
      expect((await Domain.findBinding(slackKey("U0LOSE"), tx))?.user_id).toBe(l);
      expect((await tx.one<{ user_id: string }>("SELECT user_id FROM user_aliases WHERE old_id = 'old-l'"))?.user_id).toBe(l);
      expect(await tx.one("SELECT 1 AS x FROM user_aliases WHERE old_id = ?", [l])).toBeNull();
    });
    expect(await count("user_merges")).toBe(0);
  });

  test("a stale read writes nothing and reports stale (compare and set)", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE" });
    let once = false;
    const racing = (inner: DbClient) =>
      new Proxy(inner, {
        get(t, p, r) {
          if (p !== "query") return Reflect.get(t, p, r);
          return async (sql: string, params?: unknown[]) => {
            const rows = await t.query(sql, params as never);
            if (!once && sql.includes("FROM bindings WHERE user_id")) {
              once = true;
              // Another writer slips a new binding onto the loser after our read.
              await Domain.ensureBinding({ ...slackKey("U0LATE"), userId: l, state: "observed", source: "test" }, t);
            }
            return rows;
          };
        },
      }) as DbClient;
    const r = await db.transaction((tx) => mergeUsers(input(s, l), racing(tx)));
    expect(r).toMatchObject({ status: "refused", reason: "stale" });
    expect(await Domain.getUser(l)).not.toBeNull();
    expect(await count("bindings", `user_id = '${l}'`)).toBe(2);
    expect(await count("user_merges")).toBe(0);
  });

  test("a merge racing adoptBinding of the same held binding gives one applied merge", async () => {
    const l = await person({ slack: "U0LOSE" });
    const s1 = await person({ oidc: "sub-1" });
    const s2 = await person({ oidc: "sub-2" });
    const key = slackKey("U0LOSE");
    const [a, b] = await Promise.all([
      db.transaction((tx) => Domain.adoptBinding({ ...key, toUserId: s1, state: "verified" }, tx)),
      db.transaction((tx) => Domain.adoptBinding({ ...key, toUserId: s2, state: "verified" }, tx)),
    ]);
    expect([a.adopted, b.adopted].filter(Boolean).length).toBe(1);
    expect(await count("user_merges", "state = 'applied'")).toBe(1);
    expect(await Domain.getUser(l)).toBeNull();
  });

  test("a missing user is an error, not a merge", async () => {
    const s = await person({ slack: "U0SURV" });
    await expect(merge(input(s, "no-such-user"))).rejects.toThrow("user does not exist");
  });
});

describe("mergeUsers after the commit", () => {
  test("with its own transaction it audits user.merged (ids only), drops cached actors and leaves the notice pending", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const s = await person({ slack: "U0SURV", slackState: "verified" });
    const l = await person({ slack: "U0LOSE", email: "lose@example.com" });
    await actingUser(TEAM, "U0SURV");
    expect(actorCacheSize()).toBeGreaterThan(0);
    const r = await mergeUsers(input(s, l));
    expect(r.status).toBe("merged");
    expect(actorCacheSize()).toBe(0);
    const ev = await db.one<{ action: string; actor_kind: string; actor_id: string; target_id: string; details: unknown }>("SELECT * FROM audit_events WHERE action = 'user.merged'");
    expect(ev).toMatchObject({ action: "user.merged", actor_kind: "operator", actor_id: "UOPERATOR", target_id: s });
    const details = typeof ev!.details === "string" ? JSON.parse(ev!.details) : ev!.details;
    expect(details).toMatchObject({ survivor_id: s, loser_id: l, kind: "console" });
    expect(JSON.stringify(details)).not.toContain("lose@example.com");
    expect((await db.one<{ notice_state: string }>("SELECT notice_state FROM user_merges"))!.notice_state).toBe("pending");
  });

  test("inside a caller's transaction it audits nothing: the event comes back for the caller", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE" });
    const r = await merge(input(s, l));
    expect(r.status === "merged" && r.events.map((e) => e.action)).toEqual(["user.merged"]);
    expect(await count("audit_events", "action = 'user.merged'")).toBe(0);
  });

  test("a rolled-back caller transaction leaves no ledger row and no merge", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE" });
    await expect(
      db.transaction(async (tx) => {
        await mergeUsers(input(s, l), tx);
        throw new Error("caller failed");
      }),
    ).rejects.toThrow("caller failed");
    expect(await count("user_merges")).toBe(0);
    expect(await Domain.getUser(l)).not.toBeNull();
  });
});
