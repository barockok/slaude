/**
 * Read models over the merge ledger and its proposals for the console (read
 * only). Lists page newest first on `(created_at, id)`. Nothing here returns a
 * full address or a Slack id: every value that names a person is masked
 * (`maskIdentifier`), so no caller can forget to.
 */
import { db as globalDb, type DbClient } from "./schema";
import * as Domain from "./domain";
import type { BindingRow, UserRow } from "./domain";
import { clampLimit, maskActor, maskIdentifier, parseCursor, pickPreferred, type PageOpts } from "./domain-read";
import { parseMergeRow, UNDO_WINDOW_MS, type MergeRow } from "../domain/merge";
import type {
  MergeBindingView, MergeDetail, MergeListItem, MergePage, NoticeState, ProposalItem, ProposalPage, ProposalSide, StateCounts,
} from "../gateway/panel/api-types";

const h = (tx?: DbClient): DbClient => tx ?? globalDb;
const num = (v: unknown) => Number(v);
const days = Math.round(UNDO_WINDOW_MS / 86_400_000);

/** What undo can and cannot do, shown with every merge and in the release note. */
export const UNDO_LIMITS: readonly string[] = [
  "Undo moves records and grants back. Credentials and memory slices were never moved, so undo does not touch them.",
  "Items changed after the merge (a binding unlinked, a grant revoked or edited) are not reverted: they are left as they are and listed as skipped.",
  `Past the window (${days} days) undo is refused.`,
  "A merge that a later merge chained onto must be undone later-first.",
  "A deleted account is not restored.",
];
export const PROOF_UNDO_LIMIT =
  "Undoing a proof merge also removes the link between the Slack account and the sign-in account, and forbids that pair from linking again until an operator lifts the veto.";

export function listItem(r: MergeRow, now: number): MergeListItem {
  return {
    id: r.id,
    createdAt: num(r.created_at),
    kind: r.kind,
    state: r.state,
    actor: maskActor(r.actor) ?? "",
    survivorId: r.survivor_id,
    loserId: r.loser_id,
    undoUntil: num(r.undo_until),
    undoable: r.state === "applied" && now < num(r.undo_until),
    noticeState: r.notice_state as NoticeState,
    counts: {
      bindings: r.moved.bindings.length,
      grants: r.moved.grants.length,
      activated: r.moved.activated.length,
      inactivePrivileged: r.moved.inactive_privileged.length,
    },
  };
}

export async function listMerges(f: { state?: "applied" | "undone" }, o: PageOpts = {}, now: number = Date.now(), tx?: DbClient): Promise<MergePage> {
  const c = h(tx);
  const limit = clampLimit(o.limit);
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.state) { where.push("state = ?"); args.push(f.state); }
  const cur = parseCursor(o.cursor);
  if (cur) { where.push("(created_at < ? OR (created_at = ? AND id < ?))"); args.push(cur.at, cur.at, cur.id); }
  const rows = await c.query<Parameters<typeof parseMergeRow>[0]>(
    `SELECT * FROM user_merges ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...args, limit + 1],
  );
  const page = rows.slice(0, limit).map(parseMergeRow);
  const last = page[page.length - 1];
  return { items: page.map((r) => listItem(r, now)), nextCursor: rows.length > limit && last ? `${num(last.created_at)}:${last.id}` : null };
}

/** Why the notice is in the state it is, from the audit event the notice wrote (ids and counts only). */
async function noticeDetail(r: MergeRow, c: DbClient): Promise<string | null> {
  const rows = await c.query<{ details: unknown }>(
    "SELECT details FROM audit_events WHERE action = 'user.merge_notice' AND target_id = ? ORDER BY id DESC LIMIT 20",
    [r.survivor_id],
  );
  for (const row of rows) {
    const d = (typeof row.details === "string" ? safeParse(row.details) : row.details) as Record<string, unknown> | null;
    if (!d || d.merge_id !== r.id) continue;
    const bits: string[] = [];
    if (typeof d.reason === "string") bits.push(String(d.reason));
    if (typeof d.person === "string") bits.push(`person ${d.person}`);
    if (typeof d.managers_sent === "number" || typeof d.managers_failed === "number") bits.push(`managers sent ${d.managers_sent ?? 0}, failed ${d.managers_failed ?? 0}`);
    if (Array.isArray(d.errors) && d.errors.length) bits.push(`errors: ${d.errors.map(String).join(", ")}`);
    return bits.join("; ") || null;
  }
  return null;
}
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function getMergeDetail(id: string, now: number = Date.now(), tx?: DbClient): Promise<MergeDetail | null> {
  const c = h(tx);
  const raw = await c.one<Parameters<typeof parseMergeRow>[0]>("SELECT * FROM user_merges WHERE id = ?", [id]);
  if (!raw) return null;
  const r = parseMergeRow(raw);
  const mv = r.moved;
  const bindings: MergeBindingView[] = [];
  for (const b of mv.bindings) {
    const row = await c.one<BindingRow>("SELECT * FROM bindings WHERE id = ?", [b.id]);
    bindings.push({
      id: b.id,
      service: row?.service ?? "",
      kind: row?.kind ?? "",
      workspace: row?.workspace ?? "",
      value: row ? maskIdentifier(row.service, row.kind, row.value) : "",
      state: row?.state ?? null,
      now: !row ? "removed" : row.user_id === r.survivor_id ? "survivor" : "elsewhere",
    });
  }
  const grants: MergeDetail["grants"] = [];
  for (const g of mv.grants) {
    const row = await c.one<{ subject_user_id: string | null }>("SELECT subject_user_id FROM agent_grants WHERE id = ?", [g.id]);
    grants.push({ id: g.id, persona: g.persona, now: !row ? "removed" : row.subject_user_id === r.survivor_id ? "survivor" : "elsewhere" });
  }
  return {
    ...listItem(r, now),
    undoneAt: r.undone_at,
    undoneBy: maskActor(r.undone_by),
    loserKind: mv.loser.kind,
    proof: { slackBindingId: mv.proof_binding_ids.slack, oidcBindingId: mv.proof_binding_ids.oidc },
    bindings,
    grants,
    raised: mv.raised.map((x) => ({ bindingId: x.binding_id, fromState: x.from_state, verifiedAt: x.verified_at === null ? null : num(x.verified_at) })),
    aliases: { added: mv.aliases_added.length, repointed: mv.aliases_repointed.length },
    activated: mv.activated,
    inactivePrivileged: mv.inactive_privileged,
    notice: { state: r.notice_state as NoticeState, detail: await noticeDetail(r, c) },
    limits: r.kind === "proof" ? [...UNDO_LIMITS, PROOF_UNDO_LIMIT] : [...UNDO_LIMITS],
  };
}

async function side(id: string, c: DbClient): Promise<ProposalSide> {
  const u = await c.one<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  if (!u) return { id, exists: false, kind: null, preferred: null, bindings: { declared: 0, observed: 0, verified: 0 } };
  const bs = await c.query<BindingRow>("SELECT * FROM bindings WHERE user_id = ?", [id]);
  const counts: StateCounts = { declared: 0, observed: 0, verified: 0 };
  for (const b of bs) counts[b.state]++;
  const pref = pickPreferred(bs);
  return { id, exists: true, kind: u.kind, preferred: pref ? (pref.service === "email" ? maskIdentifier("email", pref.kind, pref.value) : `${pref.service} ${pref.kind} ${maskIdentifier(pref.service, pref.kind, pref.value)}`) : null, bindings: counts };
}

export async function listProposals(f: { state?: "open" | "dismissed" | "merged" }, o: PageOpts = {}, tx?: DbClient): Promise<ProposalPage> {
  const c = h(tx);
  const limit = clampLimit(o.limit);
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.state) { where.push("state = ?"); args.push(f.state); }
  const cur = parseCursor(o.cursor);
  if (cur) { where.push("(created_at < ? OR (created_at = ? AND id < ?))"); args.push(cur.at, cur.at, cur.id); }
  const rows = await c.query<{
    id: string; created_at: number; user_a: string; user_b: string; reason: "conflict" | "two-emails"; state: "open" | "dismissed" | "merged";
    resolved_by: string | null; resolved_at: number | null;
  }>(`SELECT * FROM merge_proposals ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`, [...args, limit + 1]);
  const page = rows.slice(0, limit);
  const items: ProposalItem[] = [];
  for (const p of page) {
    let stale = false;
    let staleReason: string | null = null;
    if (p.state === "open") {
      const a = await Domain.resolveUserId(p.user_a, c);
      const b = await Domain.resolveUserId(p.user_b, c);
      if (!a || !b) [stale, staleReason] = [true, "a record of this proposal no longer exists"];
      else if (a === b) [stale, staleReason] = [true, "the two records are already one"];
    }
    items.push({
      id: p.id,
      createdAt: num(p.created_at),
      reason: p.reason,
      state: p.state,
      a: await side(p.user_a, c),
      b: await side(p.user_b, c),
      stale,
      staleReason,
      resolvedBy: maskActor(p.resolved_by),
      resolvedAt: p.resolved_at === null ? null : num(p.resolved_at),
    });
  }
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > limit && last ? `${num(last.created_at)}:${last.id}` : null };
}
