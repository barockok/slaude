/**
 * Console routes for merges and merge proposals (slice C, task 29).
 *
 *   GET  /panel/api/merges?state&cursor&limit              the merge ledger, newest first
 *   GET  /panel/api/merges/:id                             one merge with its limits and notice state
 *   POST /panel/api/merges/:id/undo-preview                what an undo would move and skip (no write)
 *   POST /panel/api/merges/:id/undo                        { reason } undo it (reason required)
 *   GET  /panel/api/merge-proposals?state&cursor&limit     pairs a human settles
 *   POST /panel/api/merge-proposals/:id/approve            { activates? } merge kind console, typed confirmation
 *   POST /panel/api/merge-proposals/:id/dismiss            drop the proposal
 *
 * Every route is superadmin only (the caller's `requireSuper` answers 403 and
 * writes the refusal audit row). The api's anti-CSRF guard has already run for
 * every POST, as for the grant POST. Mutations are audited as the operator
 * (`user.merge_undone`, `user.merged`, `merge.proposal.*`). Answers carry no
 * full address and no Slack id (src/db/merge-read.ts masks them).
 */
import { z } from "zod";
import { audit } from "./auth/audit";
import type { PanelRole } from "./auth/roles";
import { DOMAIN_PAGE_MAX, validCursor } from "../../db/domain-read";
import { getMergeDetail, listMerges, listProposals } from "../../db/merge-read";
import { previewUndo, undoMerge, UNDO_REFUSAL_TEXT, type UndoLists } from "../../domain/merge-undo";
import { approveProposal, dismissProposal } from "../../domain/merge-proposals";
import type { RefusalReason } from "../../domain/merge";
import type {
  ApproveProposalResponse, MergePage, MergeDetail, ProposalPage, UndoPreviewResponse, UndoResponse,
} from "./api-types";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface MergeRouteCtx {
  operatorId: string;
  role: PanelRole;
  /** The 403 for a non-superadmin (and its audit row), or null. */
  requireSuper: (action: string) => Response | null;
}

const listQuery = (states: readonly [string, ...string[]]) =>
  z
    .object({
      state: z.enum(states).optional(),
      cursor: z.string().min(1).max(64).optional(),
      limit: z.coerce.number().int().min(1).max(DOMAIN_PAGE_MAX).optional(),
    })
    .strict();
const mergesQuery = listQuery(["applied", "undone"]);
const proposalsQuery = listQuery(["open", "dismissed", "merged"]);
const undoBody = z.object({ reason: z.string().trim().min(3, "a reason of at least 3 characters is required").max(500) }).strict();
const approveBody = z.object({ activates: z.array(z.string().min(1).max(300)).max(500).optional() }).strict();
const dismissBody = z.object({}).strict();

const issuesLine = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
const queryOf = (url: URL) => Object.fromEntries(url.searchParams.entries());

async function bodyOf(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  const text = await req.text();
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, res: json(400, { error: "malformed JSON body" }) };
  }
}

const REFUSAL_TEXT: Record<RefusalReason, string> = {
  "verified-loser": "one of the records holds a verified binding: unlink or delete the losing account first, then approve again",
  "bot-or-agent": "a bot or an agent record is never merged",
  "two-emails": "the two records hold different verified emails",
  veto: "an undone merge forbade this pair from joining: lift the veto first",
  "auto-merge-off": "automatic merging is off",
  stale: "the records changed while merging: nothing was changed, try again",
};

const lists = (o: UndoLists): Pick<UndoPreviewResponse, "moved" | "skipped"> => ({ moved: o.moved, skipped: o.skipped });

export async function handleMergeRoutes(req: Request, url: URL, seg: string[], ctx: MergeRouteCtx): Promise<Response | null> {
  const { operatorId, role } = ctx;

  // --- merges ---------------------------------------------------------------
  if (seg[2] === "merges") {
    if (seg.length === 3) {
      if (req.method !== "GET") return json(405, { error: "method not allowed" });
      const denied = ctx.requireSuper("merge.read");
      if (denied) return denied;
      const q = mergesQuery.safeParse(queryOf(url));
      if (!q.success) return json(400, { error: issuesLine(q.error) });
      if (!validCursor(q.data.cursor)) return json(400, { error: "cursor: invalid cursor" });
      return json(200, (await listMerges({ state: q.data.state as "applied" | "undone" | undefined }, { cursor: q.data.cursor, limit: q.data.limit })) satisfies MergePage);
    }
    const id = decode(seg[3]);
    if (id === null) return json(404, { error: "not found" });
    if (seg.length === 4) {
      if (req.method !== "GET") return json(405, { error: "method not allowed" });
      const denied = ctx.requireSuper("merge.read");
      if (denied) return denied;
      const d = await getMergeDetail(id);
      return d ? json(200, d satisfies MergeDetail) : json(404, { error: "not found" });
    }
    if (seg.length === 5 && seg[4] === "undo-preview") {
      if (req.method !== "POST") return json(405, { error: "method not allowed" });
      const denied = ctx.requireSuper("merge.undo.preview");
      if (denied) return denied;
      const out = await previewUndo(id);
      if (out.status === "refused") return json(out.reason === "not-found" ? 404 : 409, { error: out.message, reason: out.reason });
      audit({ action: "merge.undo.preview", operator: operatorId, role, outcome: "ok", detail: { mergeId: id } });
      return json(200, { mergeId: id, undoable: true, ...lists(out) } satisfies UndoPreviewResponse);
    }
    if (seg.length === 5 && seg[4] === "undo") {
      if (req.method !== "POST") return json(405, { error: "method not allowed" });
      const denied = ctx.requireSuper("merge.undo");
      if (denied) return denied;
      const parsed = await bodyOf(req);
      if (!parsed.ok) return parsed.res;
      const b = undoBody.safeParse(parsed.value);
      if (!b.success) return json(400, { error: issuesLine(b.error) });
      const out = await undoMerge({ mergeId: id, actor: operatorId, reason: b.data.reason });
      if (out.status === "refused") {
        audit({ action: "merge.undo", operator: operatorId, role, outcome: "error", detail: { mergeId: id, refused: out.reason } });
        return json(out.reason === "not-found" ? 404 : 409, { error: out.message || UNDO_REFUSAL_TEXT[out.reason], reason: out.reason });
      }
      if (out.status !== "undone") return json(500, { error: "unexpected undo result" });
      const merge = (await getMergeDetail(id))!;
      return json(200, { status: "undone", mergeId: id, ...lists(out), merge } satisfies UndoResponse);
    }
    return json(404, { error: "not found" });
  }

  // --- proposals --------------------------------------------------------------
  if (seg[2] === "merge-proposals") {
    if (seg.length === 3) {
      if (req.method !== "GET") return json(405, { error: "method not allowed" });
      const denied = ctx.requireSuper("merge.read");
      if (denied) return denied;
      const q = proposalsQuery.safeParse(queryOf(url));
      if (!q.success) return json(400, { error: issuesLine(q.error) });
      if (!validCursor(q.data.cursor)) return json(400, { error: "cursor: invalid cursor" });
      return json(200, (await listProposals({ state: q.data.state as "open" | "dismissed" | "merged" | undefined }, { cursor: q.data.cursor, limit: q.data.limit })) satisfies ProposalPage);
    }
    const id = decode(seg[3]);
    if (id === null) return json(404, { error: "not found" });
    if (seg.length === 5 && seg[4] === "approve") {
      if (req.method !== "POST") return json(405, { error: "method not allowed" });
      const denied = ctx.requireSuper("merge.proposal.approve");
      if (denied) return denied;
      const parsed = await bodyOf(req);
      if (!parsed.ok) return parsed.res;
      const b = approveBody.safeParse(parsed.value);
      if (!b.success) return json(400, { error: issuesLine(b.error) });
      const out = await approveProposal({ id, operator: operatorId, activates: b.data.activates });
      switch (out.status) {
        case "not-found": return json(404, { error: "no such proposal" });
        case "not-open": return json(409, { error: `this proposal is already ${out.state}`, state: out.state });
        case "stale": return json(409, { error: `stale proposal: ${out.reason}`, stale: true });
        case "refused": return json(409, { error: REFUSAL_TEXT[out.reason], reason: out.reason });
        case "confirm-mismatch":
          return json(409, { error: "the grants this merge would activate are not the ones you confirmed", activates: out.activates, inactivePrivileged: out.inactivePrivileged });
        case "confirm":
          return json(200, { status: "confirm", survivorId: out.survivorId, loserId: out.loserId, activates: out.activates, inactivePrivileged: out.inactivePrivileged } satisfies ApproveProposalResponse);
        case "merged":
          return json(200, { status: "merged", merge: (await getMergeDetail(out.merge.id))! } satisfies ApproveProposalResponse);
      }
    }
    if (seg.length === 5 && seg[4] === "dismiss") {
      if (req.method !== "POST") return json(405, { error: "method not allowed" });
      const denied = ctx.requireSuper("merge.proposal.dismiss");
      if (denied) return denied;
      const parsed = await bodyOf(req);
      if (!parsed.ok) return parsed.res;
      const b = dismissBody.safeParse(parsed.value);
      if (!b.success) return json(400, { error: issuesLine(b.error) });
      const out = await dismissProposal({ id, operator: operatorId });
      if (out.status === "not-found") return json(404, { error: "no such proposal" });
      if (out.status === "not-open") return json(409, { error: `this proposal is already ${out.state}`, state: out.state });
      return json(200, { ok: true });
    }
    return json(404, { error: "not found" });
  }
  return null;
}

function decode(s: string | undefined): string | null {
  try {
    return s === undefined ? null : decodeURIComponent(s);
  } catch {
    return null;
  }
}
