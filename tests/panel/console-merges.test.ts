/**
 * Console API: merges and merge proposals. Superadmin only, every refusal
 * audited, undo needs a reason, and no answer carries a full address or a
 * Slack id.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { flushAudits } from "../../src/audit/emit";
import { db } from "../../src/db/schema";
import * as Domain from "../../src/db/domain";
import { mergeUsers, proposeMerge, getMerge } from "../../src/domain/merge";
import type { ApproveProposalResponse, MergeDetail, MergePage, ProposalPage, UndoPreviewResponse, UndoResponse } from "../../src/gateway/panel/api-types";

const SECRET = "t".repeat(32);
const cookie = (email: string) => `${AT_COOKIE}=${mintSession({ sub: "s", email }, "at", { secret: SECRET })}`;
const superadmin = cookie("lead@example.com");
const operator = cookie("alice@example.com");

const panel = () => createPanelApi({ registry: null, pubsub: null, panelLock: null, chat: async () => {} });
async function call(path: string, o: { who?: string | null; method?: string; body?: unknown; csrf?: boolean } = {}) {
  const who = o.who === undefined ? superadmin : o.who;
  const headers: Record<string, string> = {};
  if (who) headers.cookie = who;
  if (o.csrf !== false) headers["x-panel-csrf"] = "1";
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = (await panel().fetch(new Request(`https://panel.example.com${path}`, { method: o.method ?? "GET", headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) })))!;
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as any };
}
const post = (path: string, body?: unknown, who: string | null = superadmin, csrf = true) => call(path, { method: "POST", body: body ?? {}, who, csrf });

const WS = "T0EXAMPLE";
const slack = (value: string, state: Domain.State = "observed") => ({ service: "slack", kind: "user", workspace: WS, value, state, source: "test" }) as const;
const mail = (value: string, state: Domain.State = "observed") => ({ service: "email", kind: "address", workspace: "", value, state, source: "test" }) as const;
const oidc = (value: string) => ({ service: "oidc", kind: "subject", workspace: "https://idp.example.com", value, state: "verified", source: "test" }) as const;
const count = async (t: string, where = "1 = 1") => Number((await db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`))!.n);
const putGrant = (id: string, subjectId: string, role: string) =>
  db.run(
    `INSERT INTO agent_grants (id, persona, subject_kind, subject_id, role, deny, dm_only, created_by, created_at${db.dialect === "pg" ? ", tenant_id" : ""})
     VALUES (?, 'scout', 'user', ?, ?, ${db.dialect === "pg" ? "FALSE, FALSE" : "0, 0"}, 'UOP', 1${db.dialect === "pg" ? ", 'default'" : ""})`,
    [id, subjectId, role],
  );

/** Every secret a response must never carry. */
const FORBIDDEN = ["lose@example.com", "alice.real@example.com", "U0LOSE", "U0SURV", "U0OTHER", "boss@example.com"];
const noLeak = (text: string) => { for (const f of FORBIDDEN) expect(text).not.toContain(f); };

async function seedMerge() {
  const s = (await Domain.ensureBinding({ ...slack("U0SURV", "verified") })).userId;
  await Domain.ensureBinding({ ...oidc("sub-1"), userId: s });
  const l = (await Domain.ensureBinding({ ...slack("U0LOSE") })).userId;
  await Domain.ensureBinding({ ...mail("lose@example.com"), userId: l });
  await putGrant("g1", `user:${l}`, "approver");
  await db.run("UPDATE agent_grants SET subject_user_id = ? WHERE id = 'g1'", [l]);
  const out = await mergeUsers({ survivorId: s, loserId: l, kind: "console", actor: "lead@example.com" });
  if (out.status !== "merged") throw new Error("seed merge failed");
  return { s, l, merge: out.merge };
}

const saved: Record<string, string | undefined> = {};
const ENV = ["SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_SUPERADMIN", "SLAUDE_PANEL_OPERATORS", "SLAUDE_MERGE_NOTICE"];
beforeEach(async () => {
  process.env.SLAUDE_ACCESS_SOURCE = "internal";
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
  process.env.SLAUDE_MERGE_NOTICE = "off";
  __resetRoleCache();
  await db.run("DELETE FROM agent_grants");
  await db.run("DELETE FROM audit_events");
  await Domain._wipeForTests();
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  delete process.env.SLAUDE_ACCESS_SOURCE;
  await flushAudits();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetRoleCache();
  spyOn(console, "log").mockRestore();
  spyOn(console, "warn").mockRestore();
});

const ROUTES: Array<[string, string]> = [
  ["GET", "/panel/api/merges"],
  ["GET", "/panel/api/merges/m1"],
  ["POST", "/panel/api/merges/m1/undo-preview"],
  ["POST", "/panel/api/merges/m1/undo"],
  ["GET", "/panel/api/merge-vetoes"],
  ["POST", "/panel/api/merge-vetoes/v1/lift"],
  ["GET", "/panel/api/merge-proposals"],
  ["POST", "/panel/api/merge-proposals/p1/approve"],
  ["POST", "/panel/api/merge-proposals/p1/dismiss"],
];

describe("auth and roles", () => {
  test("a request without a session is refused", async () => {
    for (const [method, path] of ROUTES) expect((await call(path, { who: null, method, body: method === "POST" ? {} : undefined })).status).toBe(401);
  });

  test("an operator gets 403 on every route, each refusal is audited, and nothing changes", async () => {
    const { l, merge } = await seedMerge();
    for (const [method, path] of ROUTES) {
      const r = await call(path.replace("m1", merge.id), { who: operator, method, body: method === "POST" ? { reason: "no way" } : undefined });
      expect(r.status).toBe(403);
      expect(r.body.required).toBe("superadmin");
    }
    await flushAudits();
    const refused = await db.query<{ action: string; actor_id: string; decision: string }>("SELECT action, actor_id, decision FROM audit_events WHERE decision = 'refused'");
    expect(refused).toHaveLength(ROUTES.length);
    expect(new Set(refused.map((x) => x.actor_id))).toEqual(new Set(["alice@example.com"]));
    expect(refused.map((x) => x.action).sort()).toEqual(
      ["panel.merge.proposal.approve", "panel.merge.proposal.dismiss", "panel.merge.read", "panel.merge.read", "panel.merge.read", "panel.merge.read", "panel.merge.undo", "panel.merge.undo.preview", "panel.merge.veto.lift"].sort(),
    );
    expect(await Domain.getUser(l)).toBeNull(); // the merge stands
    expect((await getMerge(merge.id))!.state).toBe("applied");
    expect(await count("audit_events", "action = 'user.merge_undone'")).toBe(0);
  });

  test("a POST without the anti-CSRF header is refused before anything runs", async () => {
    const { merge } = await seedMerge();
    const r = await post(`/panel/api/merges/${merge.id}/undo`, { reason: "csrf test" }, superadmin, false);
    expect(r.status).toBe(403);
    expect((await getMerge(merge.id))!.state).toBe("applied");
    const p = await post("/panel/api/merge-proposals/x/dismiss", {}, superadmin, false);
    expect(p.status).toBe(403);
  });

  test("a wrong method is refused", async () => {
    expect((await call("/panel/api/merges", { method: "POST", body: {} })).status).toBe(405);
    expect((await call("/panel/api/merges/x/undo", { method: "GET" })).status).toBe(405);
    expect((await call("/panel/api/merge-proposals/x/approve", { method: "GET" })).status).toBe(405);
  });
});

describe("GET merges", () => {
  test("empty, then one merge, with the state filter and masked actor", async () => {
    expect((await call("/panel/api/merges")).body as MergePage).toEqual({ items: [], nextCursor: null });
    const { merge, s, l } = await seedMerge();
    const r = await call("/panel/api/merges");
    expect(r.status).toBe(200);
    const page = r.body as MergePage;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: merge.id, kind: "console", state: "applied", actor: "l***@example.com", survivorId: s, loserId: l, undoable: true, noticeState: expect.any(String),
      counts: { bindings: 2, grants: 1, activated: 1, inactivePrivileged: 0 },
    });
    noLeak(r.text);
    expect(r.text).not.toContain("lead@example.com");
    expect(((await call("/panel/api/merges?state=undone")).body as MergePage).items).toHaveLength(0);
    expect((await call("/panel/api/merges?state=bogus")).status).toBe(400);
    expect((await call("/panel/api/merges?cursor=%25%25")).status).toBe(400);
  });

  test("detail: ids, masked values, where each item is now, limits, notice", async () => {
    const { merge } = await seedMerge();
    const r = await call(`/panel/api/merges/${merge.id}`);
    expect(r.status).toBe(200);
    const d = r.body as MergeDetail;
    expect(d.bindings).toHaveLength(2);
    expect(d.bindings.map((b) => b.value).sort()).toEqual(["U0***SE", "l***@example.com"].sort());
    expect(d.bindings.every((b) => b.now === "survivor")).toBe(true);
    expect(d.grants).toEqual([{ id: "g1", persona: "scout", now: "survivor" }]);
    expect(d.activated.map((a) => a.entry)).toEqual(["grant:g1"]);
    expect(d.limits.join(" ")).toContain("Credentials and memory slices were never moved");
    expect(d.limits.join(" ")).toContain("later-first");
    expect(d.limits.join(" ")).toContain("deleted account is not restored");
    expect(d.notice.state).toBeDefined();
    noLeak(r.text);
    expect((await call("/panel/api/merges/nope")).status).toBe(404);
  });
});

describe("undo", () => {
  test("the preview lists what would move and writes nothing", async () => {
    const { merge, l } = await seedMerge();
    const r = await post(`/panel/api/merges/${merge.id}/undo-preview`);
    expect(r.status).toBe(200);
    const p = r.body as UndoPreviewResponse;
    expect(p.moved.bindings).toHaveLength(2);
    expect(p.moved.grants).toEqual(["g1"]);
    expect(p.skipped).toEqual([]);
    noLeak(r.text);
    expect(await Domain.getUser(l)).toBeNull();
    expect((await post("/panel/api/merges/nope/undo-preview")).status).toBe(404);
  });

  test("a reason is required: missing, empty and too short are 400 and nothing is undone", async () => {
    const { merge, l } = await seedMerge();
    for (const body of [{}, { reason: "" }, { reason: "  " }, { reason: "ab" }, { reason: 5 }, { why: "x" }]) {
      expect((await post(`/panel/api/merges/${merge.id}/undo`, body)).status).toBe(400);
    }
    expect(await Domain.getUser(l)).toBeNull();
    expect((await getMerge(merge.id))!.state).toBe("applied");
  });

  test("undo with a reason: records return, the merge is undone, audited as the operator, answer masked", async () => {
    const { merge, l } = await seedMerge();
    const r = await post(`/panel/api/merges/${merge.id}/undo`, { reason: "wrong person" });
    expect(r.status).toBe(200);
    const out = r.body as UndoResponse;
    expect(out).toMatchObject({ status: "undone", mergeId: merge.id });
    expect(out.merge).toMatchObject({ state: "undone", undoable: false, undoneBy: "l***@example.com" });
    noLeak(r.text);
    expect(await Domain.getUser(l)).not.toBeNull();
    await flushAudits();
    const ev = await db.one<{ actor_kind: string; actor_id: string; details: unknown }>("SELECT actor_kind, actor_id, details FROM audit_events WHERE action = 'user.merge_undone'");
    expect(ev).toMatchObject({ actor_kind: "operator", actor_id: "lead@example.com" });
    expect(JSON.stringify(ev!.details)).toContain("wrong person");
  });

  test("a second undo and a past-window undo are 409 with the reason, audited as an error", async () => {
    const { merge } = await seedMerge();
    await db.run("UPDATE user_merges SET undo_until = ? WHERE id = ?", [Date.now() - 1, merge.id]);
    const late = await post(`/panel/api/merges/${merge.id}/undo`, { reason: "too late" });
    expect(late.status).toBe(409);
    expect(late.body.reason).toBe("past-window");
    expect((await post(`/panel/api/merges/${merge.id}/undo-preview`)).status).toBe(409);
    await flushAudits();
    expect(await count("audit_events", "action = 'panel.merge.undo.preview'")).toBe(1); // the refused preview is audited
    await db.run("UPDATE user_merges SET undo_until = ? WHERE id = ?", [Date.now() + 100000, merge.id]);
    expect((await post(`/panel/api/merges/${merge.id}/undo`, { reason: "now fine" })).status).toBe(200);
    const again = await post(`/panel/api/merges/${merge.id}/undo`, { reason: "again" });
    expect(again.status).toBe(409);
    expect(again.body.reason).toBe("already-undone");
    await flushAudits();
    expect(await count("audit_events", "action = 'panel.merge.undo'")).toBe(2);
  });
});

describe("proposals", () => {
  async function seedProposal() {
    const s = (await Domain.ensureBinding({ ...slack("U0SURV", "verified") })).userId;
    await Domain.ensureBinding({ ...oidc("sub-1"), userId: s });
    const l = (await Domain.ensureBinding({ ...slack("U0LOSE") })).userId;
    await Domain.ensureBinding({ ...mail("lose@example.com"), userId: l });
    await putGrant("g1", `user:${l}`, "approver");
    await db.run("UPDATE agent_grants SET subject_user_id = ? WHERE id = 'g1'", [l]);
    const id = await proposeMerge(db, s, l, "conflict", { why: "test" });
    return { s, l, id };
  }

  test("lists open proposals with masked sides; a pair already one record is flagged stale", async () => {
    const { s, l, id } = await seedProposal();
    const r = await call("/panel/api/merge-proposals");
    const page = r.body as ProposalPage;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id, reason: "conflict", state: "open", stale: false });
    expect([page.items[0]!.a.id, page.items[0]!.b.id].sort()).toEqual([s, l].sort());
    noLeak(r.text);
    await mergeUsers({ survivorId: s, loserId: l, kind: "console", actor: "UOP" });
    const after = (await call("/panel/api/merge-proposals")).body as ProposalPage;
    expect(after.items[0]).toMatchObject({ stale: true, staleReason: "the two records are already one" });
    expect(((await call("/panel/api/merge-proposals?state=merged")).body as ProposalPage).items).toHaveLength(0);
    expect((await call("/panel/api/merge-proposals?state=bogus")).status).toBe(400);
  });

  test("approve without the outcome answers the whole outcome, including the grants it would activate and merges nothing", async () => {
    const { id, l } = await seedProposal();
    const r = await post(`/panel/api/merge-proposals/${id}/approve`);
    expect(r.status).toBe(200);
    expect(r.body as ApproveProposalResponse).toMatchObject({ status: "confirm", outcome: { activates: ["scout:approver:grant:g1"], bindings: 2, grants: 1 } });
    noLeak(r.text);
    expect(await Domain.getUser(l)).not.toBeNull();
  });

  test("approve with the outcome merges as the operator; a different outcome is 409 with the current one and is audited", async () => {
    const { id, l } = await seedProposal();
    const shown = ((await post(`/panel/api/merge-proposals/${id}/approve`)).body as { outcome: any }).outcome;
    const bad = await post(`/panel/api/merge-proposals/${id}/approve`, { confirm: { ...shown, activates: [] } });
    expect(bad.status).toBe(409);
    expect(bad.body.outcome).toEqual(shown);
    expect(await Domain.getUser(l)).not.toBeNull();
    const ok = await post(`/panel/api/merge-proposals/${id}/approve`, { confirm: shown });
    expect(ok.status).toBe(200);
    const out = ok.body as ApproveProposalResponse;
    expect(out.status).toBe("merged");
    expect(out.status === "merged" && out.merge).toMatchObject({ kind: "console", state: "applied", actor: "l***@example.com" });
    noLeak(ok.text);
    expect(await Domain.getUser(l)).toBeNull();
    await flushAudits();
    expect(await count("audit_events", "action = 'user.merged' AND actor_kind = 'operator' AND actor_id = 'lead@example.com'")).toBe(1);
    expect(await count("audit_events", "action = 'merge.proposal.approved'")).toBe(1);
    // The mismatch above and this settled proposal are refusals, and both are audited.
    expect((await post(`/panel/api/merge-proposals/${id}/approve`, { confirm: shown })).status).toBe(409);
    await flushAudits();
    expect(await count("audit_events", "action = 'panel.merge.proposal.approve' AND decision IS NULL")).toBe(2);
  });

  test("a stale proposal is refused", async () => {
    const { s, l, id } = await seedProposal();
    await mergeUsers({ survivorId: s, loserId: l, kind: "console", actor: "UOP" });
    const r = await post(`/panel/api/merge-proposals/${id}/approve`);
    expect(r.status).toBe(409);
    expect(r.body.stale).toBe(true);
    expect((await post("/panel/api/merge-proposals/nope/approve")).status).toBe(404);
  });

  test("the any-verified refusal holds for the console", async () => {
    const a = (await Domain.ensureBinding({ ...slack("U0OTHER", "verified") })).userId;
    await Domain.ensureBinding({ ...oidc("sub-a"), userId: a });
    const b = (await Domain.ensureBinding({ ...slack("U0LOSE", "verified") })).userId;
    await Domain.ensureBinding({ ...oidc("sub-b"), userId: b });
    const id = await proposeMerge(db, a, b, "conflict", {});
    const r = await post(`/panel/api/merge-proposals/${id}/approve`);
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("verified-loser");
    expect(r.text).toContain("unlink or delete the losing account");
    noLeak(r.text);
    expect(await count("user_merges")).toBe(0);
  });

  test("dismiss, once", async () => {
    const { id } = await seedProposal();
    expect((await post(`/panel/api/merge-proposals/${id}/dismiss`)).status).toBe(200);
    expect((await post(`/panel/api/merge-proposals/${id}/dismiss`)).status).toBe(409);
    expect((await post("/panel/api/merge-proposals/nope/dismiss")).status).toBe(404);
    const page = (await call("/panel/api/merge-proposals?state=dismissed")).body as ProposalPage;
    expect(page.items[0]).toMatchObject({ state: "dismissed", resolvedBy: "l***@example.com" });
    await flushAudits();
    expect(await count("audit_events", "action = 'merge.proposal.dismissed' AND actor_id = 'lead@example.com'")).toBe(1);
  });
});

describe("vetoes", () => {
  async function undoneProofMerge() {
    await Domain.ensureBinding({ ...slack("U0SEEN") });
    const { upsertAccount, linkSlackIdentity } = await import("../../src/db/accounts");
    const a = await upsertAccount({ issuer: "https://idp.example.com", subject: "sub-9", email: "alice.real@example.com", emailProven: true });
    await linkSlackIdentity({ teamId: WS, slackUserId: "U0SEEN", accountId: a.id, via: "signed-link" });
    const ledger = (await db.one<{ id: string }>("SELECT id FROM user_merges WHERE kind = 'proof'"))!;
    expect((await post(`/panel/api/merges/${ledger.id}/undo`, { reason: "wrong person" })).status).toBe(200);
    return { a, ledger };
  }

  test("an undo leaves a veto the list shows without anything a person is recognised by; lifting needs a reason and is audited", async () => {
    await undoneProofMerge();
    const r = await call("/panel/api/merge-vetoes");
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    noLeak(r.text);
    expect(r.text).not.toContain("U0SEEN");
    const id = r.body.items[0].id as string;
    expect((await post(`/panel/api/merge-vetoes/${id}/lift`, {})).status).toBe(400);
    expect((await post(`/panel/api/merge-vetoes/${id}/lift`, { reason: "ab" })).status).toBe(400);
    expect(await count("merge_vetoes")).toBe(1);
    expect((await post(`/panel/api/merge-vetoes/${id}/lift`, { reason: "it was the right person" }, superadmin, false)).status).toBe(403);
    expect((await post(`/panel/api/merge-vetoes/${id}/lift`, { reason: "it was the right person" })).status).toBe(200);
    expect(await count("merge_vetoes")).toBe(0);
    await flushAudits();
    const ev = await db.one<{ actor_id: string; actor_kind: string }>("SELECT actor_id, actor_kind FROM audit_events WHERE action = 'merge.veto.lifted'");
    expect(ev).toEqual({ actor_id: "lead@example.com", actor_kind: "operator" });
    expect((await post(`/panel/api/merge-vetoes/${id}/lift`, { reason: "again" })).status).toBe(404);
  });

  test("with the veto lifted the pair can link again", async () => {
    const { a } = await undoneProofMerge();
    const { linkSlackIdentity } = await import("../../src/db/accounts");
    expect(await linkSlackIdentity({ teamId: WS, slackUserId: "U0SEEN", accountId: a.id, via: "signed-link" })).toEqual({ ok: false, reason: "vetoed" });
    const id = ((await call("/panel/api/merge-vetoes")).body.items[0].id) as string;
    await post(`/panel/api/merge-vetoes/${id}/lift`, { reason: "operator decided" });
    expect((await linkSlackIdentity({ teamId: WS, slackUserId: "U0SEEN", accountId: a.id, via: "signed-link" })).ok).toBe(true);
  });

  test("a proposal the engine refused for a veto or a verified record carries a hint", async () => {
    const a = (await Domain.ensureBinding({ ...slack("U0OTHER", "verified") })).userId;
    await Domain.ensureBinding({ ...oidc("sub-a"), userId: a });
    const b = (await Domain.ensureBinding({ ...slack("U0LOSE", "verified") })).userId;
    await Domain.ensureBinding({ ...oidc("sub-b"), userId: b });
    const id = await proposeMerge(db, a, b, "conflict", { why: "verified-loser" });
    const page = (await call("/panel/api/merge-proposals")).body as ProposalPage;
    expect(page.items.find((p) => p.id === id)!.hint).toContain("squatting");
  });
});
