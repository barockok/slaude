/**
 * POST /v1/tools/kb/<tool> — same handlers as the `slaude_kb` MCP server.
 * Brain tools need the gateway's brain deps (scope/gate/approval); when the
 * brain is disabled they are "not mounted", mirroring createKbMcp.
 */
import { kbHandlers, brainHandlers } from "../../../knowledge/mcp-tools";
import type { JobClaims } from "../auth";
import type { ToolPlaneDeps, ToolResult } from "./deps";

export async function executeKbTool(
  tool: string,
  args: Record<string, unknown>,
  claims: JobClaims,
  deps: ToolPlaneDeps,
): Promise<ToolResult | null> {
  const a = args as any;
  switch (tool) {
    case "list_kbs":
      return kbHandlers.list_kbs();
    case "search_kbs":
      return kbHandlers.search_kbs({ query: a.query, limit: a.limit });
  }
  const ctx = deps.slackCtx(claims);
  const surface = deps.surfaceFor(ctx);
  const brainDeps = deps.brainDeps(ctx, surface);
  if (!brainDeps) return null; // brain disabled → tools not mounted, like createKbMcp
  switch (tool) {
    case "kb_think":
      return brainHandlers.kb_think({ question: a.question }, brainDeps);
    case "kb_search":
      return brainHandlers.kb_search({ query: a.query, limit: a.limit }, brainDeps);
    case "kb_get_page":
      return brainHandlers.kb_get_page({ slug: a.slug }, brainDeps);
    case "kb_list_pages":
      return brainHandlers.kb_list_pages({ type: a.type, tag: a.tag, limit: a.limit }, brainDeps);
    case "kb_graph":
      return brainHandlers.kb_graph({ slug: a.slug }, brainDeps);
    case "kb_memoize":
      return brainHandlers.kb_memoize({ pages: a.pages, target: a.target }, brainDeps);
    case "kb_delete_page":
      return brainHandlers.kb_delete_page({ slug: a.slug, reason: a.reason }, brainDeps);
    default:
      return null;
  }
}
