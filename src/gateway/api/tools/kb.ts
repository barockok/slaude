/**
 * POST /v1/tools/kb/<tool> — same handlers as the `slaude_kb` MCP server.
 * Brain tools need the gateway's brain deps (scope/gate/approval); when the
 * brain is disabled they are "not mounted", mirroring createKbMcp. Args are
 * contract-parsed and flow straight into the handlers — tsc checks the
 * contract against each handler's parameter type.
 */
import { kbHandlers, brainHandlers } from "../../../knowledge/mcp-tools";
import { kbContract } from "../../../tools/contracts/kb";
import { parseToolArgs } from "../../../tools/contracts/types";
import type { JobClaims } from "../auth";
import type { ToolPlaneDeps, ToolResult } from "./deps";

const c = kbContract.tools;

export async function executeKbTool(
  tool: string,
  body: unknown,
  claims: JobClaims,
  deps: ToolPlaneDeps,
): Promise<ToolResult | null> {
  switch (tool) {
    case c.list_kbs.name:
      parseToolArgs(c.list_kbs, body);
      return kbHandlers.list_kbs();
    case c.search_kbs.name:
      return kbHandlers.search_kbs(parseToolArgs(c.search_kbs, body));
  }
  const ctx = deps.slackCtx(claims);
  const surface = deps.surfaceFor(ctx);
  const brainDeps = deps.brainDeps(ctx, surface);
  if (!brainDeps) return null; // brain disabled → tools not mounted, like createKbMcp
  switch (tool) {
    case c.kb_think.name:
      return brainHandlers.kb_think(parseToolArgs(c.kb_think, body), brainDeps);
    case c.kb_search.name:
      return brainHandlers.kb_search(parseToolArgs(c.kb_search, body), brainDeps);
    case c.kb_get_page.name:
      return brainHandlers.kb_get_page(parseToolArgs(c.kb_get_page, body), brainDeps);
    case c.kb_list_pages.name:
      return brainHandlers.kb_list_pages(parseToolArgs(c.kb_list_pages, body), brainDeps);
    case c.kb_graph.name:
      return brainHandlers.kb_graph(parseToolArgs(c.kb_graph, body), brainDeps);
    case c.kb_memoize.name:
      return brainHandlers.kb_memoize(parseToolArgs(c.kb_memoize, body), brainDeps);
    case c.kb_delete_page.name:
      return brainHandlers.kb_delete_page(parseToolArgs(c.kb_delete_page, body), brainDeps);
    default:
      return null;
  }
}
