import type { BrainScope, ChannelTrust } from "./scope";
import { userSourceId } from "./scope";

export type GateTier = "auto" | "approval" | "manager" | "deny";

export interface GateInput {
  userId: string | null;
  lockedUser: string | null;
  channelTrust: ChannelTrust;
  isManager: boolean;
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
    if (g.userId === null) return "auto"; // agent writing its own mind
    if (g.lockedUser === g.userId && scope.sourceId === userSourceId(g.userId)) return "auto";
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

export async function gatedBrainCall(op: string, d: GatedCallDeps): Promise<GatedResult> {
  const tier = classifyBrainOp(op, d.scope, d.gate);
  if (tier === "deny") {
    return { ok: false, reason: `kb operation "${op}" is not allowed from this channel` };
  }
  if (tier === "manager" && d.managers.length === 0) {
    return { ok: false, reason: `kb operation "${op}" requires a manager and none is configured in SOUL.md` };
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
  }
  return { ok: true, result: await d.call() };
}
