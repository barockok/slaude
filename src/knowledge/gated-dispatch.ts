import type { BrainScope, ChannelTrust } from "./scope";
import { agentSourceId, userSourceId } from "./scope";

export type GateTier = "auto" | "approval" | "manager" | "deny";

export interface GateInput {
  userId: string | null;
  lockedUser: string | null;
  channelTrust: ChannelTrust;
  isManager: boolean;
  /** This agent's identity — writes to its own `agent-<id>` slice auto-pass. */
  agentId: string;
  /** Stable per-thread key (`channel:threadTs`). Scopes the standing grant —
   *  one approval in a thread auto-passes later non-destructive writes there. */
  threadKey?: string | null;
}

const READ_OPS = new Set([
  "search", "query", "think", "get_page", "list_pages", "get_links",
  "get_backlinks", "traverse_graph", "get_timeline", "get_tags",
  "get_stats", "sources_list", "resolve_slugs", "takes_list", "takes_search",
]);

// Mutations allowed without a gate when writing to the caller's own slice.
const WRITE_OPS = new Set([
  "put_page", "add_tag", "remove_tag", "add_link", "remove_link", "add_timeline_entry",
]);

// Destructive: approval even on the caller's own slice.
const DESTRUCTIVE_OPS = new Set(["delete_page", "restore_page"]);

// Mutations that write into scope.sourceId — that source row MUST exist first,
// else gbrain's insert hits pages_source_id_fkey. Per-user sources (user-<id>,
// the /1on1 lock scope) are resolved at write time but never bootstrapped, so
// the write path must ensure the source. See
// docs/findings/2026-06-14-brain-memoize-failure.md.
const SCOPE_WRITE_OPS = new Set([...WRITE_OPS, ...DESTRUCTIVE_OPS]);
export const isScopeWriteOp = (op: string): boolean => SCOPE_WRITE_OPS.has(op);

// Brain administration: manager approval always.
const MANAGER_OPS = new Set([
  "purge_deleted_pages", "sources_add", "sources_remove", "sync_brain",
  "schema_apply_mutations", "reload_schema_pack", "revert_version", "forget_fact",
]);

export function classifyBrainOp(op: string, scope: BrainScope, g: GateInput): GateTier {
  if (READ_OPS.has(op)) return "auto";
  if (MANAGER_OPS.has(op)) return "manager";
  if (DESTRUCTIVE_OPS.has(op)) {
    return g.channelTrust === "public" && !g.isManager ? "deny" : "approval";
  }
  if (WRITE_OPS.has(op)) {
    if (g.userId === null) return "auto"; // background turn — agent's own mind
    if (scope.sourceId === agentSourceId(g.agentId)) return "auto"; // agent's own private slice
    if (g.lockedUser === g.userId && scope.sourceId === userSourceId(g.userId)) return "auto"; // user's own 1on1 slice
    // Everything else is a write to the shared/common KB (explicit target:"shared").
    // Legit to ask approval — including the manager (the standing grant collapses
    // repeat cards per thread). Non-manager in a public channel: denied.
    if (g.channelTrust === "trusted" || g.isManager) return "approval";
    return "deny";
  }
  return "manager"; // unknown op: fail closed
}

// Field-compatible subset of the Surface ApprovalRequest contract.
export interface ApprovalReq {
  summary: string;
  tools?: string[];
  risks?: string;
  category?: string;
}
export interface ApprovalRes {
  approved: boolean;
  by: string;
  note?: string;
}

export interface GatedCallDeps {
  scope: BrainScope;
  gate: GateInput;
  /** Slack user ids allowed to approve manager-tier (kb-admin) ops — the
   *  manager + backup. ApprovalGate routing is config-driven; this is the
   *  hard backstop on WHO clicked, independent of routing. */
  managers: string[];
  requestApproval: (r: ApprovalReq) => Promise<ApprovalRes>;
  call: () => Promise<unknown>;
  describe: string;
}

export type GatedResult = { ok: true; result: unknown } | { ok: false; reason: string };

// ── Standing grant ─────────────────────────────────────────────────────────
// A non-destructive brain write ("approval" tier from WRITE_OPS) cards the human
// once per thread; after they approve, later such writes in the SAME thread
// auto-pass for a TTL window. In-memory only — process restart re-asks. Keeps
// the gate's authorization (deny/scope/manager-tier) fully intact; only the
// repeat *card* is suppressed for the trusted writer. Destructive and
// manager-tier ops are never covered. See docs/findings/2026-06-14-brain-memoize-failure.md.
// Read per-grant (not at import) so tests/ops can tune the window via env.
// Explicit 0 disables the standing grant (every write cards); unset/invalid → 8h.
const grantTtlMs = (): number => {
  const n = Number(process.env.SLAUDE_KB_GRANT_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 8 * 60 * 60 * 1000;
};
interface StandingGrant { by: string; expiresAt: number; }
const standingGrants = new Map<string, StandingGrant>();

/** WRITE_OPS only — destructive/manager ops always card. */
const isStandingGrantable = (op: string): boolean => WRITE_OPS.has(op);

/**
 * Grant key binds the grant to BOTH the thread AND the writer. A grant opened
 * by one user's approval must NOT auto-pass a different user's writes in the
 * same thread (trusted channels are multi-user). Null when either part is
 * missing — no key means no grant (always card). userId === null is an agent
 * turn, which is "auto" tier and never reaches the grant path anyway.
 */
function grantKey(g: GateInput): string | null {
  if (!g.threadKey || !g.userId) return null;
  return `${g.threadKey} ${g.userId}`;
}

/** Test hook: clear all in-memory grants. */
export function resetStandingGrants(): void { standingGrants.clear(); }

function liveGrant(key: string | null, now: number): boolean {
  if (!key) return false;
  const g = standingGrants.get(key);
  if (!g) return false;
  if (g.expiresAt <= now) { standingGrants.delete(key); return false; }
  return true;
}

export async function gatedBrainCall(op: string, d: GatedCallDeps): Promise<GatedResult> {
  const tier = classifyBrainOp(op, d.scope, d.gate);
  if (tier === "deny") {
    return { ok: false, reason: `kb operation "${op}" is not allowed from this channel` };
  }
  if (tier === "manager" && d.managers.length === 0) {
    return { ok: false, reason: `kb operation "${op}" requires a manager and none is configured in SOUL.md` };
  }
  const now = Date.now();
  const grantable = tier === "approval" && isStandingGrantable(op);
  const gkey = grantKey(d.gate);
  // Standing-grant fast path: a live grant for THIS writer in THIS thread skips
  // the repeat card. Per-writer key — one user's approval never covers another.
  if (grantable && liveGrant(gkey, now)) {
    return { ok: true, result: await d.call() };
  }
  if (tier === "approval" || tier === "manager") {
    const r = await d.requestApproval({
      summary: d.describe,
      tools: [op],
      category: tier === "manager" ? "kb-admin" : "kb",
    });
    if (!r.approved) return { ok: false, reason: `denied by ${r.by}${r.note ? `: ${r.note}` : ""}` };
    if (tier === "manager" && !d.managers.includes(r.by)) {
      return { ok: false, reason: `kb operation "${op}" needs manager approval — approved by ${r.by}, who is not the manager` };
    }
    // First approval opens a standing grant scoped to (thread, this writer) —
    // not the approver, and not the whole thread — for later writes by them.
    if (grantable && gkey) {
      standingGrants.set(gkey, { by: r.by, expiresAt: now + grantTtlMs() });
    }
  }
  return { ok: true, result: await d.call() };
}
