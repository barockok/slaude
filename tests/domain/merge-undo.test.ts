import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Accounts from "../../src/db/accounts";
import * as AgentGrants from "../../src/db/agent-grants";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import { mergeUsers, getMerge, UNDO_WINDOW_MS, type MergeInput } from "../../src/domain/merge";
import { previewUndo, undoMerge, type UndoOutcome } from "../../src/domain/merge-undo";
import { actingUser } from "../../src/refs/actor";

const TEAM = "T0EXAMPLE";
const ISS = "https://idp.example.com";
const slackKey = (value: string) => ({ service: "slack", kind: "user", workspace: TEAM, value });
const mailKey = (value: string) => ({ service: "email", kind: "address", workspace: "", value });
const oidcKey = (subject: string) => ({ service: "oidc", kind: "subject", workspace: ISS, value: subject });
/** JSONB comes back parsed on Postgres and as text on sqlite. */
const dj = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : (v as Record<string, any>));
const count = async (t: string, where = "1 = 1") => Number((await db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`))!.n);

async function person(opts: { slack?: string; slackState?: Domain.State; email?: string; emailState?: Domain.State; oidc?: string } = {}) {
  const u = await Domain.ensureUser({ displayName: opts.slack ? `name-${opts.slack}` : null });
  if (opts.slack) await Domain.ensureBinding({ ...slackKey(opts.slack), userId: u.id, state: opts.slackState ?? "observed", source: "test" });
  if (opts.email) await Domain.ensureBinding({ ...mailKey(opts.email), userId: u.id, state: opts.emailState ?? "observed", source: "test" });
  if (opts.oidc) await Domain.ensureBinding({ ...oidcKey(opts.oidc), userId: u.id, state: "verified", source: "test" });
  return u.id;
}
const input = (survivorId: string, loserId: string, over: Partial<MergeInput> = {}): MergeInput => ({ survivorId, loserId, kind: "console", actor: "UOPERATOR", ...over });
async function merged(i: MergeInput) {
  const out = await mergeUsers(i);
  if (out.status !== "merged") throw new Error(`merge ${out.status}`);
  return out.merge;
}
const undo = (mergeId: string, over: { actor?: string; reason?: string } = {}) => undoMerge({ mergeId, actor: over.actor ?? "op@example.com", reason: over.reason ?? "test" });
function done(o: UndoOutcome) {
  if (o.status !== "undone") throw new Error(`undo ${o.status} ${o.status === "refused" ? o.reason : ""}`);
  return o;
}

beforeEach(async () => {
  await Accounts._wipeForTests();
  await db.run("DELETE FROM agent_grants");
  await db.run("DELETE FROM audit_events");
  await db.run("DELETE FROM link_token_uses");
  delete process.env.SLAUDE_AUTO_MERGE;
  process.env.SLAUDE_MERGE_NOTICE = "off";
  spyOn(console, "warn").mockImplementation(() => {});
  spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SLAUDE_MERGE_NOTICE;
  spyOn(console, "warn").mockRestore();
  spyOn(console, "log").mockRestore();
});

describe("undoMerge", () => {
  test("round trip: the loser comes back with its id, bindings, grants and aliases; the ledger is undone; the audit event lists ids", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE", email: "lose@example.com" });
    const before = (await Domain.getUser(l))!;
    await db.run("INSERT INTO user_aliases (old_id, user_id, merged_at) VALUES ('old-l', ?, 1)", [l]);
    const g = await AgentGrants.create({ persona: "scout", subjectKind: "user", subjectId: "U0LOSE", role: "member", createdBy: "UOP" });
    await db.run("UPDATE agent_grants SET subject_user_id = ? WHERE id = ?", [l, g.id]);
    const m = await merged(input(s, l));
    expect(await Domain.getUser(l)).toBeNull();

    const out = done(await undo(m.id, { reason: "wrong person" }));
    const back = (await Domain.getUser(l))!;
    expect(back).toMatchObject({ id: l, kind: before.kind, display_name: before.display_name, created_at: before.created_at });
    expect((await Domain.findBinding(slackKey("U0LOSE")))?.user_id).toBe(l);
    expect((await Domain.findBinding(mailKey("lose@example.com")))?.user_id).toBe(l);
    expect((await Domain.findBinding(slackKey("U0SURV")))?.user_id).toBe(s);
    expect((await db.one<{ subject_user_id: string }>("SELECT subject_user_id FROM agent_grants WHERE id = ?", [g.id]))!.subject_user_id).toBe(l);
    expect(await Domain.resolveUserId("old-l")).toBe(l);
    expect(await Domain.resolveUserId(l)).toBe(l);
    expect(await count("user_aliases", `old_id = '${l}'`)).toBe(0);
    const row = (await getMerge(m.id))!;
    expect(row).toMatchObject({ state: "undone", undone_by: "op@example.com" });
    expect(row.undone_at).toBeGreaterThan(0);
    expect(out.moved.bindings.sort()).toEqual(m.moved.bindings.map((b) => b.id).sort());
    expect(out.moved.grants).toEqual([g.id]);
    expect(out.skipped).toEqual([]);
    const ev = await db.one<{ action: string; details: unknown; actor_kind: string; actor_id: string }>("SELECT * FROM audit_events WHERE action = 'user.merge_undone'");
    expect(ev).toMatchObject({ actor_kind: "operator", actor_id: "op@example.com" });
    const d = dj(ev!.details);
    expect(d.merge_id).toBe(m.id);
    expect(d.binding_ids.sort()).toEqual(out.moved.bindings.sort());
    expect(d.reason).toBe("wrong person");
    expect(JSON.stringify(ev!.details)).not.toContain("lose@example.com");
    expect(JSON.stringify(ev!.details)).not.toContain("U0LOSE");
  });

  test("the actor cache is dropped: the Slack id is the loser's again at once", async () => {
    const s = await person({ slack: "U0SURV", slackState: "verified" });
    const l = await person({ slack: "U0LOSE" });
    const m = await merged(input(s, l));
    expect((await actingUser(TEAM, "U0LOSE"))?.userId).toBe(s);
    done(await undo(m.id));
    expect((await actingUser(TEAM, "U0LOSE"))?.userId).toBe(l);
  });

  test("a binding or grant that changed since the merge is left and listed as skipped with the reason", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE", email: "lose@example.com" });
    const g1 = await AgentGrants.create({ persona: "scout", subjectKind: "user", subjectId: "U0LOSE", role: "member", createdBy: "UOP" });
    const g2 = await AgentGrants.create({ persona: "scout", subjectKind: "user", subjectId: "U0LOSE", role: "approver", createdBy: "UOP" });
    await db.run("UPDATE agent_grants SET subject_user_id = ? WHERE persona = 'scout'", [l]);
    const m = await merged(input(s, l));
    const third = await person({ slack: "U0THIRD" });
    const mail = (await Domain.findBinding(mailKey("lose@example.com")))!;
    await db.run("UPDATE bindings SET user_id = ? WHERE id = ?", [third, mail.id]); // moved elsewhere after the merge
    await db.run("DELETE FROM agent_grants WHERE id = ?", [g1.id]); // revoked after the merge
    await db.run("UPDATE agent_grants SET subject_user_id = ? WHERE id = ?", [third, g2.id]); // repointed after the merge
    const out = done(await undo(m.id));
    expect((await Domain.findBinding(mailKey("lose@example.com")))?.user_id).toBe(third);
    expect((await Domain.findBinding(slackKey("U0LOSE")))?.user_id).toBe(l);
    expect(out.skipped.map((x) => `${x.kind}:${x.id}`).sort()).toEqual([`binding:${mail.id}`, `grant:${g1.id}`, `grant:${g2.id}`].sort());
    for (const x of out.skipped) expect(x.reason.length).toBeGreaterThan(3);
    expect((await db.one<{ subject_user_id: string }>("SELECT subject_user_id FROM agent_grants WHERE id = ?", [g2.id]))!.subject_user_id).toBe(third);
  });

  test("a state the merge raised goes back only while it is still verified with the recorded verified_at; no other binding is lowered", async () => {
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "verified" });
    const l = await person({ email: "boss@example.com" });
    const held = (await Domain.findBinding(mailKey("boss@example.com")))!;
    const m = await merged(input(s, l, { kind: "proof", actor: "system", raise: { bindingId: held.id } }));
    expect(m.moved.raised).toHaveLength(1);
    const out = done(await undo(m.id));
    const after = (await Domain.findBinding(mailKey("boss@example.com")))!;
    expect(after).toMatchObject({ user_id: l, state: "observed", verified_at: null });
    expect(out.moved.restored).toEqual([held.id]);
    // Survivor's own verified bindings stay verified.
    expect((await Domain.findBinding(slackKey("U0SURV")))?.state).toBe("verified");
    expect((await Domain.findBinding(oidcKey("sub-1")))?.state).toBe("verified");
  });

  test("a raised binding re-verified since (another verified_at) is left verified and reported", async () => {
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "verified" });
    const l = await person({ email: "boss@example.com" });
    const held = (await Domain.findBinding(mailKey("boss@example.com")))!;
    const m = await merged(input(s, l, { kind: "proof", actor: "system", raise: { bindingId: held.id } }));
    await db.run("UPDATE bindings SET verified_at = verified_at + 5 WHERE id = ?", [held.id]);
    const out = done(await undo(m.id));
    expect((await Domain.findBinding(mailKey("boss@example.com")))?.state).toBe("verified");
    expect(out.moved.restored).toEqual([]);
    expect(out.skipped.find((x) => x.kind === "state")).toMatchObject({ id: held.id });
  });

  test("a merge that raised nothing raises and lowers nothing", async () => {
    const s = await person({ slack: "U0SURV", slackState: "verified" });
    const l = await person({ slack: "U0LOSE", slackState: "observed" });
    const m = await merged(input(s, l));
    done(await undo(m.id));
    expect((await Domain.findBinding(slackKey("U0LOSE")))?.state).toBe("observed");
    expect((await Domain.findBinding(slackKey("U0SURV")))?.state).toBe("verified");
  });
});

describe("window and refusals", () => {
  test("past undo_until is refused and nothing changes", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE" });
    const m = await merged(input(s, l));
    await db.run("UPDATE user_merges SET undo_until = ? WHERE id = ?", [Date.now() - 1, m.id]);
    const out = await undo(m.id);
    expect(out).toMatchObject({ status: "refused", reason: "past-window" });
    expect(await Domain.getUser(l)).toBeNull();
    expect((await getMerge(m.id))!.state).toBe("applied");
    expect(m.undo_until - m.created_at).toBe(UNDO_WINDOW_MS);
  });

  test("undoing twice and an unknown id are refused", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE" });
    const m = await merged(input(s, l));
    done(await undo(m.id));
    expect(await undo(m.id)).toMatchObject({ status: "refused", reason: "already-undone" });
    expect(await undo("no-such-merge")).toMatchObject({ status: "refused", reason: "not-found" });
  });

  test("a chained merge: the survivor merged away later is refused until the later merge is undone first", async () => {
    const a = await person({ slack: "U0AAA" });
    const b = await person({ slack: "U0BBB" });
    const c = await person({ slack: "U0CCC" });
    const m1 = await merged(input(b, a));
    const m2 = await merged(input(c, b));
    expect(await undo(m1.id)).toMatchObject({ status: "refused", reason: "chained" });
    expect(await Domain.getUser(a)).toBeNull();
    done(await undo(m2.id));
    expect((await Domain.findBinding(slackKey("U0AAA")))?.user_id).toBe(b); // M2 gave the binding back to b
    done(await undo(m1.id));
    expect((await Domain.findBinding(slackKey("U0AAA")))?.user_id).toBe(a);
    expect((await Domain.findBinding(slackKey("U0BBB")))?.user_id).toBe(b);
    expect((await Domain.findBinding(slackKey("U0CCC")))?.user_id).toBe(c);
    expect(await count("users")).toBe(3);
  });

  test("a loser id that exists again is refused", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE" });
    const m = await merged(input(s, l));
    await db.run("INSERT INTO users (id, kind, display_name, created_at, updated_at) VALUES (?, 'person', NULL, 1, 1)", [l]);
    expect(await undo(m.id)).toMatchObject({ status: "refused", reason: "loser-exists" });
  });
});

describe("preview", () => {
  test("returns the lists the undo would produce, and writes nothing", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE", email: "lose@example.com" });
    const g = await AgentGrants.create({ persona: "scout", subjectKind: "user", subjectId: "U0LOSE", role: "member", createdBy: "UOP" });
    await db.run("UPDATE agent_grants SET subject_user_id = ? WHERE id = ?", [l, g.id]);
    const m = await merged(input(s, l));
    const mail = (await Domain.findBinding(mailKey("lose@example.com")))!;
    const third = await person({ slack: "U0THIRD" });
    await db.run("UPDATE bindings SET user_id = ? WHERE id = ?", [third, mail.id]);
    const p = await previewUndo(m.id);
    expect(p.status).toBe("preview");
    expect(await Domain.getUser(l)).toBeNull();
    expect((await getMerge(m.id))!.state).toBe("applied");
    const out = done(await undo(m.id));
    if (p.status !== "preview") return;
    expect(p.moved).toEqual(out.moved);
    expect(p.skipped).toEqual(out.skipped);
    expect(await previewUndo(m.id)).toMatchObject({ status: "refused", reason: "already-undone" });
  });
});

describe("proof merges: the link is undone too", () => {
  async function linked() {
    const seen = await person({ slack: "U0SEEN", email: "alice@example.com" });
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "someone@example.com", emailProven: true });
    const token = { jti: "tok-1", expiresAt: Date.now() + 15 * 60_000 };
    expect(await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0SEEN", accountId: a.id, via: "signed-link", token })).toEqual({ ok: true, created: true });
    const m = await db.one<{ id: string }>("SELECT id FROM user_merges WHERE kind = 'proof' AND loser_id = ?", [seen]);
    return { seen, a, token, mergeId: m!.id };
  }

  test("the slack_identities row is removed, the binding goes back observed to the loser, and the pair is vetoed", async () => {
    const { seen, a, mergeId } = await linked();
    expect(await Accounts.accountForSlackUser(TEAM, "U0SEEN")).not.toBeNull();
    const sb = (await Domain.findBinding(slackKey("U0SEEN")))!;
    const ob = (await Domain.findBinding(oidcKey("sub-1")))!;
    const out = done(await undo(mergeId));
    expect(out.moved.unlinked).toBe(true);
    expect(await Accounts.accountForSlackUser(TEAM, "U0SEEN")).toBeNull();
    expect((await Domain.findBinding(slackKey("U0SEEN")))).toMatchObject({ user_id: seen, state: "observed" });
    expect((await Domain.findBinding(oidcKey("sub-1")))?.user_id).not.toBe(seen);
    expect(await db.one("SELECT id FROM merge_vetoes WHERE slack_binding_id = ? AND oidc_binding_id = ?", [sb.id, ob.id])).not.toBeNull();
    // The account itself is not touched.
    expect(await Accounts.findAccountById(a.id)).not.toBeNull();
  });

  test("a replay of the link after undo is refused by the veto, and by the jti ledger once the veto is lifted", async () => {
    const { a, token, mergeId } = await linked();
    done(await undo(mergeId));
    // A fresh token for the same pair: the veto refuses and the token is not spent.
    const fresh = { jti: "tok-2", expiresAt: Date.now() + 60_000 };
    expect(await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0SEEN", accountId: a.id, via: "signed-link", token: fresh })).toEqual({ ok: false, reason: "vetoed" });
    expect(await db.one("SELECT jti FROM link_token_uses WHERE jti = 'tok-2'")).toBeNull();
    // The original token is spent: with the veto lifted the ledger still refuses it.
    await db.run("DELETE FROM merge_vetoes");
    expect(await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0SEEN", accountId: a.id, via: "signed-link", token })).toEqual({ ok: false, reason: "link-used" });
    expect(await Accounts.accountForSlackUser(TEAM, "U0SEEN")).toBeNull();
  });

  test("the engine refuses to merge the vetoed pair again, by any kind", async () => {
    const { seen, mergeId } = await linked();
    done(await undo(mergeId));
    const acctUser = (await Domain.findBinding(oidcKey("sub-1")))!.user_id;
    expect(await mergeUsers(input(acctUser, seen))).toMatchObject({ status: "refused", reason: "veto" });
  });

  test("a post-merge unlink stays unlinked and is reported: no row is re-created, the link is listed as skipped", async () => {
    const { seen, a, mergeId } = await linked();
    expect(await Accounts.unlinkSlackIdentity(TEAM, "U0SEEN", a.id)).toBe(true);
    expect(await Domain.findBinding(slackKey("U0SEEN"))).toBeNull(); // the unlink removed the verified binding
    const out = done(await undo(mergeId));
    expect(await Accounts.accountForSlackUser(TEAM, "U0SEEN")).toBeNull();
    expect(await Domain.findBinding(slackKey("U0SEEN"))).toBeNull();
    expect(out.moved.unlinked).toBe(false);
    expect(out.skipped.map((x) => x.kind as string).sort()).toEqual(["binding", "link", "state"].sort());
    expect(out.skipped.find((x) => x.kind === "link")!.reason).toContain("unlinked");
    // The other loser binding came back.
    expect((await Domain.findBinding(mailKey("alice@example.com")))?.user_id).toBe(seen);
    expect(await Domain.getUser(seen)).not.toBeNull();
  });

  test("a deleted account is not restored: the undo still returns the records and says so", async () => {
    const { seen, a, mergeId } = await linked();
    await Accounts.deleteAccount(a.id);
    const out = done(await undo(mergeId));
    expect(await Accounts.findAccountById(a.id)).toBeNull();
    expect(out.moved.unlinked).toBe(false);
    expect(out.skipped.some((x) => x.kind === "link")).toBe(true);
    expect(await Domain.getUser(seen)).not.toBeNull();
    expect((await Domain.findBinding(mailKey("alice@example.com")))?.user_id).toBe(seen);
  });

  test("a console merge removes no link and records no veto", async () => {
    const s = await person({ oidc: "sub-1", slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE" });
    const m = await merged(input(s, l));
    const out = done(await undo(m.id));
    expect(out.moved.unlinked).toBe(false);
    expect(await count("merge_vetoes")).toBe(0);
  });
});

describe("concurrency", () => {
  test("an undo racing a merge of the same survivor ends consistent: one wins, the other is refused or applies after", async () => {
    for (let round = 0; round < 6; round++) {
      const s = await person({ slack: `U0S${round}` });
      const l = await person({ slack: `U0L${round}` });
      const x = await person({ slack: `U0X${round}` });
      const m = await merged(input(s, l));
      const [u, mg] = await Promise.all([undo(m.id), mergeUsers(input(x, s))]);
      // Whatever the order: no binding is orphaned and every record that exists has a consistent owner.
      expect(await count("bindings b LEFT JOIN users u ON u.id = b.user_id", "u.id IS NULL")).toBe(0);
      if (u.status === "undone") expect(await Domain.getUser(l)).not.toBeNull();
      else expect(u).toMatchObject({ status: "refused", reason: "chained" });
      if (u.status === "refused") expect(mg.status).toBe("merged");
      expect(await count("user_merges", "state = 'applied' AND loser_id = '" + l + "'")).toBe(u.status === "undone" ? 0 : 1);
    }
  });

  test("two undos of one merge: one applies", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE" });
    const m = await merged(input(s, l));
    const [a, b] = await Promise.all([undo(m.id), undo(m.id)]);
    expect([a.status, b.status].sort()).toEqual(["refused", "undone"]);
    expect(await count("users", `id = '${l}'`)).toBe(1);
  });
});
