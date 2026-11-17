import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import { proposeMerge } from "../../src/domain/merge";
import { activationLines, approveProposal, dismissProposal, type ApprovalOutcome } from "../../src/domain/merge-proposals";

const TEAM = "T0EXAMPLE";
const slackKey = (value: string) => ({ service: "slack", kind: "user", workspace: TEAM, value });
const mailKey = (value: string) => ({ service: "email", kind: "address", workspace: "", value });
const oidcKey = (subject: string) => ({ service: "oidc", kind: "subject", workspace: "https://idp.example.com", value: subject });
const count = async (t: string, where = "1 = 1") => Number((await db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`))!.n);

async function person(opts: { slack?: string; slackState?: Domain.State; email?: string; oidc?: string; kind?: Domain.UserKind } = {}) {
  const u = await Domain.ensureUser({ kind: opts.kind ?? "person" });
  if (opts.slack) await Domain.ensureBinding({ ...slackKey(opts.slack), userId: u.id, state: opts.slackState ?? "observed", source: "test" });
  if (opts.email) await Domain.ensureBinding({ ...mailKey(opts.email), userId: u.id, state: "observed", source: "test" });
  if (opts.oidc) await Domain.ensureBinding({ ...oidcKey(opts.oidc), userId: u.id, state: "verified", source: "test" });
  return u.id;
}
const putGrant = (id: string, subjectId: string, role: string) =>
  db.run(
    `INSERT INTO agent_grants (id, persona, subject_kind, subject_id, role, deny, dm_only, created_by, created_at${db.dialect === "pg" ? ", tenant_id" : ""})
     VALUES (?, 'scout', 'user', ?, ?, ${db.dialect === "pg" ? "FALSE, FALSE" : "0, 0"}, 'UOP', 1${db.dialect === "pg" ? ", 'default'" : ""})`,
    [id, subjectId, role],
  );
const proposal = async (a: string, b: string, reason: "conflict" | "two-emails" = "conflict") => proposeMerge(db, a, b, reason, { why: "test" });
/** The outcome the server shows for a proposal, as an operator would echo it back. */
const outcomeOf = async (id: string): Promise<ApprovalOutcome> => {
  const o = await approveProposal({ id, operator: "op@example.com" });
  if (o.status !== "confirm") throw new Error(`no outcome: ${o.status}`);
  return o.outcome;
};
const state = async (id: string) => (await db.one<{ state: string; resolved_by: string | null }>("SELECT state, resolved_by FROM merge_proposals WHERE id = ?", [id]))!;

beforeEach(async () => {
  process.env.SLAUDE_ACCESS_SOURCE = "internal";
  await db.run("DELETE FROM agent_grants");
  await db.run("DELETE FROM audit_events");
  await Domain._wipeForTests();
  process.env.SLAUDE_MERGE_NOTICE = "off";
  spyOn(console, "warn").mockImplementation(() => {});
  spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SLAUDE_ACCESS_SOURCE;
  delete process.env.SLAUDE_MERGE_NOTICE;
  spyOn(console, "warn").mockRestore();
  spyOn(console, "log").mockRestore();
});

describe("approveProposal", () => {
  test("without the confirmation it only previews: the grants it would activate, nothing merged", async () => {
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "verified" });
    const l = await person({ slack: "U0LOSE" });
    await putGrant("g1", `user:${l}`, "approver");
    await db.run("UPDATE agent_grants SET subject_user_id = ? WHERE id = 'g1'", [l]);
    const id = await proposal(s, l);
    const out = await approveProposal({ id, operator: "op@example.com" });
    expect(out).toMatchObject({ status: "confirm", outcome: { activates: ["scout:approver:grant:g1"], bindings: 1, grants: 1 } });
    if (out.status === "confirm") expect(JSON.stringify(out.outcome)).not.toContain("U0LOSE");
    expect(await Domain.getUser(l)).not.toBeNull();
    expect(await count("user_merges")).toBe(0);
    expect((await state(id)).state).toBe("open");
  });

  test("with the exact list it merges kind console as the operator, marks the proposal merged and audits user.merged", async () => {
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "verified" });
    const l = await person({ slack: "U0LOSE" });
    await putGrant("g1", `user:${l}`, "approver");
    await db.run("UPDATE agent_grants SET subject_user_id = ? WHERE id = 'g1'", [l]);
    const id = await proposal(s, l);
    const out = await approveProposal({ id, operator: "op@example.com", confirm: await outcomeOf(id) });
    expect(out.status).toBe("merged");
    if (out.status !== "merged") return;
    expect(out.merge).toMatchObject({ kind: "console", actor: "op@example.com", state: "applied" });
    expect(await Domain.getUser(l)).toBeNull();
    expect(await state(id)).toEqual({ state: "merged", resolved_by: "op@example.com" });
    const ev = await db.one<{ actor_kind: string; actor_id: string }>("SELECT actor_kind, actor_id FROM audit_events WHERE action = 'user.merged'");
    expect(ev).toEqual({ actor_kind: "operator", actor_id: "op@example.com" });
  });

  test("an outcome that differs from what would happen now is refused with the current one, nothing merged", async () => {
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "verified" });
    const l = await person({ slack: "U0LOSE" });
    await putGrant("g1", `user:${l}`, "approver");
    await db.run("UPDATE agent_grants SET subject_user_id = ? WHERE id = 'g1'", [l]);
    const id = await proposal(s, l);
    const real = await outcomeOf(id);
    const wrong: ApprovalOutcome[] = [
      { ...real, activates: [] },
      { ...real, activates: ["scout:member:grant:other"] },
      { ...real, activates: [...real.activates, "scout:manager:grant:g2"] },
      { ...real, survivor: real.loser, loser: real.survivor },
      { ...real, bindings: real.bindings + 1 },
      { ...real, inactivePrivileged: ["scout:manager:grant:g9"] },
    ];
    for (const confirm of wrong) {
      const out = await approveProposal({ id, operator: "op@example.com", confirm });
      expect(out).toMatchObject({ status: "confirm-mismatch", outcome: real });
    }
    expect(await count("user_merges")).toBe(0);
    expect((await state(id)).state).toBe("open");
  });

  test("a merge that activates nothing is confirmed with an empty list", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE" });
    const id = await proposal(s, l);
    const real = await outcomeOf(id);
    expect(real.activates).toEqual([]);
    // An empty list is not a blind approval: the direction and counts must match too.
    expect((await approveProposal({ id, operator: "op@example.com", confirm: { ...real, survivor: "x***@example.com" } })).status).toBe("confirm-mismatch");
    expect((await approveProposal({ id, operator: "op@example.com", confirm: real })).status).toBe("merged");
  });

  test("keeps the any-verified refusal: a verified loser is refused, no state is raised, the proposal stays open", async () => {
    const a = await person({ oidc: "sub-1", slack: "U0AAA", slackState: "verified" });
    const b = await person({ oidc: "sub-2", slack: "U0BBB", slackState: "verified" });
    const id = await proposal(a, b);
    expect(await approveProposal({ id, operator: "op@example.com" })).toMatchObject({ status: "refused", reason: "verified-loser" });
    expect(await count("user_merges")).toBe(0);
    expect((await state(id)).state).toBe("open");
    expect(await count("merge_proposals")).toBe(1);
    expect((await Domain.findBinding(slackKey("U0BBB")))?.user_id).toBe(b);
  });

  test("never raises a binding state", async () => {
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "verified" });
    const l = await person({ slack: "U0LOSE", email: "lose@example.com" });
    const id = await proposal(s, l);
    const out = await approveProposal({ id, operator: "op@example.com", confirm: await outcomeOf(id) });
    expect(out.status).toBe("merged");
    expect((await Domain.findBinding(slackKey("U0LOSE")))?.state).toBe("observed");
    expect((await Domain.findBinding(mailKey("lose@example.com")))?.state).toBe("observed");
    expect(out.status === "merged" && out.merge.moved.raised).toEqual([]);
  });

  test("a bot or agent record is refused", async () => {
    const p = await person({ slack: "U0PERSON" });
    const bot = await person({ slack: "U0BOT", kind: "bot" });
    const id = await proposal(p, bot);
    expect(await approveProposal({ id, operator: "op@example.com" })).toMatchObject({ status: "refused", reason: "bot-or-agent" });
  });

  test("a stale proposal is refused: a record gone, or both already one record", async () => {
    const a = await person({ slack: "U0AAA" });
    const b = await person({ slack: "U0BBB" });
    const c = await person({ slack: "U0CCC" });
    const gone = await proposal(a, b);
    await db.run("DELETE FROM bindings WHERE user_id = ?", [b]);
    await db.run("DELETE FROM users WHERE id = ?", [b]);
    expect(await approveProposal({ id: gone, operator: "op@example.com" })).toMatchObject({ status: "stale" });
    const same = await proposal(a, c);
    const { mergeUsers } = await import("../../src/domain/merge");
    await mergeUsers({ survivorId: a, loserId: c, kind: "console", actor: "UOP" });
    expect(await approveProposal({ id: same, operator: "op@example.com" })).toMatchObject({ status: "stale" });
    expect((await state(same)).state).toBe("open");
  });

  test("not found and not open", async () => {
    const a = await person({ slack: "U0AAA" });
    const b = await person({ slack: "U0BBB" });
    expect(await approveProposal({ id: "nope", operator: "op@example.com" })).toEqual({ status: "not-found" });
    const id = await proposal(a, b);
    await dismissProposal({ id, operator: "op@example.com" });
    expect(await approveProposal({ id, operator: "op@example.com" })).toMatchObject({ status: "not-open", state: "dismissed" });
  });

  test("a privileged grant is listed with its role", async () => {
    const s = await person({ oidc: "sub-1", slack: "U0SURV", slackState: "verified" });
    const l = await person({ slack: "U0LOSE" });
    await putGrant("g1", `user:${l}`, "manager");
    const id = await proposal(s, l);
    expect(await approveProposal({ id, operator: "op@example.com" })).toMatchObject({ status: "confirm", outcome: { activates: ["scout:manager:grant:g1"] } });
  });

  test("activationLines is sorted and unique", () => {
    expect(
      activationLines([
        { persona: "b", role: "member", source: "console", entry: "grant:2", privileged: false },
        { persona: "a", role: "manager", source: "console", entry: "grant:1", privileged: true },
        { persona: "a", role: "manager", source: "console", entry: "grant:1", privileged: true },
      ]),
    ).toEqual(["a:manager:grant:1", "b:member:grant:2"]);
  });
});

describe("dismissProposal", () => {
  test("marks it dismissed with the operator; a second dismiss is refused; the pair is not proposed again", async () => {
    const a = await person({ slack: "U0AAA" });
    const b = await person({ slack: "U0BBB" });
    const id = await proposal(a, b);
    expect(await dismissProposal({ id, operator: "op@example.com" })).toEqual({ status: "dismissed" });
    expect(await state(id)).toEqual({ state: "dismissed", resolved_by: "op@example.com" });
    expect(await dismissProposal({ id, operator: "op@example.com" })).toMatchObject({ status: "not-open" });
    expect(await dismissProposal({ id: "nope", operator: "op@example.com" })).toEqual({ status: "not-found" });
    expect(await proposal(a, b)).toBe(id);
    expect((await state(id)).state).toBe("dismissed");
  });
});

describe("two connections", () => {
  test("two approvals of one proposal produce one merge", async () => {
    const s = await person({ slack: "U0SURV" });
    const l = await person({ slack: "U0LOSE" });
    const id = await proposal(s, l);
    const confirm = await outcomeOf(id);
    const [x, y] = await Promise.all([
      approveProposal({ id, operator: "op1@example.com", confirm }),
      approveProposal({ id, operator: "op2@example.com", confirm }),
    ]);
    expect([x.status, y.status].filter((v) => v === "merged")).toHaveLength(1);
    expect(await count("user_merges", "state = 'applied'")).toBe(1);
  });
});
