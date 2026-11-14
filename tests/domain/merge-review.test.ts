import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Accounts from "../../src/db/accounts";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import { mergeUsers } from "../../src/domain/merge";
import { undoMerge } from "../../src/domain/merge-undo";
import { reconcile } from "../../src/domain/reconcile";

const TEAM = "T0EXAMPLE";
const ISS = "https://idp.example.com";
const slack = (value: string) => ({ service: "slack", kind: "user", workspace: TEAM, value });
const mail = (value: string) => ({ service: "email", kind: "address", workspace: "", value });
const oidc = (subject: string) => ({ service: "oidc", kind: "subject", workspace: ISS, value: subject });
const count = async (t: string, where = "1 = 1") => Number((await db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`))!.n);
const putGrant = (id: string, subjectId: string, role: string) =>
  db.run(
    `INSERT INTO agent_grants (id, persona, subject_kind, subject_id, role, deny, dm_only, created_by, created_at${db.dialect === "pg" ? ", tenant_id" : ""})
     VALUES (?, 'scout', 'user', ?, ?, ${db.dialect === "pg" ? "FALSE, FALSE" : "0, 0"}, 'UOP', 1${db.dialect === "pg" ? ", 'default'" : ""})`,
    [id, subjectId, role],
  );
async function person(o: { slack?: string; slackState?: Domain.State; email?: string; oidc?: string } = {}) {
  const u = await Domain.ensureUser({});
  if (o.slack) await Domain.ensureBinding({ ...slack(o.slack), userId: u.id, state: o.slackState ?? "observed", source: "test" });
  if (o.email) await Domain.ensureBinding({ ...mail(o.email), userId: u.id, state: "observed", source: "test" });
  if (o.oidc) await Domain.ensureBinding({ ...oidc(o.oidc), userId: u.id, state: "verified", source: "test" });
  return u.id;
}

const ENV = ["SLAUDE_ACCESS_SOURCE", "SLAUDE_PRIVILEGED_NEEDS_VERIFIED", "SLAUDE_MERGE_NOTICE"];
const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SLAUDE_ACCESS_SOURCE = "internal";
  process.env.SLAUDE_MERGE_NOTICE = "off";
  await Accounts._wipeForTests();
  await db.run("DELETE FROM agent_grants");
  await db.run("DELETE FROM audit_events");
  spyOn(console, "warn").mockImplementation(() => {});
  spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  spyOn(console, "warn").mockRestore();
  spyOn(console, "log").mockRestore();
});

describe("undo of a login (email) merge is vetoed too", () => {
  test("the next proven login and a reconcile do not merge the pair again", async () => {
    const seen = await person({ slack: "U0SEEN", email: "alice@example.com" });
    await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com", emailProven: true });
    const ledger = await db.one<{ id: string }>("SELECT id FROM user_merges WHERE kind = 'proof'");
    expect(ledger).not.toBeNull();
    const out = await undoMerge({ mergeId: ledger!.id, actor: "op@example.com", reason: "wrong person" });
    expect(out.status).toBe("undone");
    expect(await count("merge_vetoes")).toBe(1);
    expect((await Domain.findBinding(mail("alice@example.com")))?.user_id).toBe(seen);

    await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com", emailProven: true });
    await reconcile({ unlocked: true, liveTeamIds: () => [TEAM] });
    expect(await count("user_merges")).toBe(1); // still only the undone one
    expect(await count("user_merges", "state = 'applied'")).toBe(0);
    expect((await Domain.findBinding(mail("alice@example.com")))?.user_id).toBe(seen);
    expect(await count("merge_proposals")).toBeGreaterThan(0);
  });

  test("the veto holds after the person unlinks before the undo (a new binding id is a new binding, the key is the same)", async () => {
    await person({ slack: "U0SEEN" });
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com", emailProven: true });
    await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0SEEN", accountId: a.id, via: "signed-link" });
    const ledger = (await db.one<{ id: string }>("SELECT id FROM user_merges WHERE kind = 'proof' AND moved LIKE '%veto_pair%' ORDER BY created_at DESC"))!;
    expect(await Accounts.unlinkSlackIdentity(TEAM, "U0SEEN", a.id)).toBe(true);
    expect((await undoMerge({ mergeId: ledger.id, actor: "op@example.com", reason: "unlinked first" })).status).toBe("undone");
    // The Slack id is seen again: a brand new binding id.
    await Domain.ensureBinding({ ...slack("U0SEEN"), state: "observed", source: "first-sight" });
    expect(await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0SEEN", accountId: a.id, via: "signed-link" })).toEqual({ ok: false, reason: "vetoed" });
  });
});

describe("the proof binding must still be on the loser", () => {
  test("a raise whose binding is not on the loser after the lock is stale: nothing moves", async () => {
    const s = await person({ oidc: "sub-1", email: "alice@example.com" });
    const l = await person({ slack: "U0LOSE" });
    const notOnLoser = (await Domain.findBinding(mail("alice@example.com")))!; // it sits on the survivor
    const out = await mergeUsers({ survivorId: s, loserId: l, kind: "proof", actor: "system", raise: { bindingId: notOnLoser.id } });
    expect(out).toMatchObject({ status: "refused", reason: "stale" });
    expect(await Domain.getUser(l)).not.toBeNull();
    expect(await count("user_merges")).toBe(0);
  });

  test("an undo returning the binding while an adopt waits: the adopt is a conflict, not a merge without the proof", async () => {
    const seen = await person({ slack: "U0SEEN", email: "alice@example.com" });
    await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com", emailProven: true });
    const ledger = (await db.one<{ id: string }>("SELECT id FROM user_merges"))!;
    await undoMerge({ mergeId: ledger.id, actor: "op@example.com", reason: "undo then adopt" });
    await db.run("DELETE FROM merge_vetoes");
    const acct = (await Domain.findBinding(oidc("sub-1")))!.user_id;
    const held = (await Domain.findBinding(mail("alice@example.com")))!;
    expect(held.user_id).toBe(seen);
    // The engine is told the proof binding sits on a record it no longer does.
    const out = await mergeUsers({ survivorId: acct, loserId: seen, kind: "proof", actor: "system", raise: { bindingId: "gone-binding" } });
    expect(out).toMatchObject({ status: "refused", reason: "stale" });
  });
});

describe("activated answers Rules A and D, over the reach of both records", () => {
  test("a direct slack manager entry the loser's Slack id already used is not newly activated", async () => {
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "verified" });
    const l = await person({ slack: "U0BOSS" });
    await putGrant("g-mgr", "U0BOSS", "manager");
    const out = await mergeUsers({ survivorId: s, loserId: l, kind: "console", actor: "UOP" });
    expect(out.status === "merged" && out.merge.moved.activated).toEqual([]);
    expect(out.status === "merged" && out.merge.moved.inactive_privileged).toEqual([]);
  });

  test("with the verified-binding flag on, another binding's verified state does not activate a direct slack entry", async () => {
    process.env.SLAUDE_PRIVILEGED_NEEDS_VERIFIED = "1";
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "verified" });
    const l = await person({ slack: "U0BOSS" });
    await putGrant("g-mgr", "U0BOSS", "manager");
    const out = await mergeUsers({ survivorId: s, loserId: l, kind: "console", actor: "UOP" });
    expect(out.status === "merged" && out.merge.moved.activated).toEqual([]);
  });

  test("an email manager grant activates through a verified acting Slack binding, and waits without one", async () => {
    const mk = async (state: Domain.State) => {
      await db.run("DELETE FROM agent_grants");
      await Domain._wipeForTests();
      const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: state });
      const l = await person({ email: "boss@example.com" });
      await putGrant("g-e", "email:boss@example.com", "manager");
      const held = (await Domain.findBinding(mail("boss@example.com")))!;
      const out = await mergeUsers({ survivorId: s, loserId: l, kind: "proof", actor: "system", raise: { bindingId: held.id } });
      if (out.status !== "merged") throw new Error(out.status);
      return out.merge.moved;
    };
    expect((await mk("verified")).activated.map((a) => a.entry)).toEqual(["grant:g-e"]);
    const waiting = await mk("observed");
    expect(waiting.activated).toEqual([]);
    expect(waiting.inactive_privileged).toEqual([{ persona: "scout", role: "manager", entry: "grant:g-e" }]);
  });

  test("under shadow nothing is recorded as activated, and the ledger says why; the would-be list is kept", async () => {
    process.env.SLAUDE_ACCESS_SOURCE = "shadow";
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "verified" });
    const l = await person({ email: "boss@example.com" });
    await putGrant("g-e", "email:boss@example.com", "manager");
    const held = (await Domain.findBinding(mail("boss@example.com")))!;
    const out = await mergeUsers({ survivorId: s, loserId: l, kind: "proof", actor: "system", raise: { bindingId: held.id } });
    if (out.status !== "merged") throw new Error(out.status);
    expect(out.merge.moved.activated).toEqual([]);
    expect(out.merge.moved.inactive_privileged).toEqual([]);
    expect(out.merge.moved.access_source).toBe("shadow");
    expect(out.merge.moved.would_activate?.map((a) => a.entry)).toEqual(["grant:g-e"]);
  });
});

describe("a veto read failure never fails a link", () => {
  test("with the veto table unreadable the link still stands", async () => {
    await person({ slack: "U0SEEN" });
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com", emailProven: true });
    await db.run("ALTER TABLE merge_vetoes RENAME TO merge_vetoes_off");
    try {
      expect(await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0SEEN", accountId: a.id, via: "signed-link" })).toEqual({ ok: true, created: true });
      expect(await Accounts.accountForSlackUser(TEAM, "U0SEEN")).not.toBeNull();
    } finally {
      await db.run("ALTER TABLE merge_vetoes_off RENAME TO merge_vetoes");
    }
  });
});
