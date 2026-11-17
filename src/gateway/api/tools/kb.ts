/**
 * POST /v1/tools/kb/<tool> — same handlers as the `slaude_kb` MCP server.
 * Brain tools need the gateway's brain deps (scope/gate/approval); when the
 * brain is disabled they are "not mounted", mirroring createKbMcp. Args are
 * contract-parsed and flow straight into the handlers — tsc checks the
 * contract against each handler's parameter type. A deprecated kb_* alias is
 * mapped to its memory_* name first: same schema, same handler.
 */
import { kbHandlers, brainHandlers } from "../../../knowledge/mcp-tools";
import { personaKbs } from "../../../knowledge/persona-kb";
import { canonicalMemoryTool, kbContract } from "../../../tools/contracts/kb";
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
  tool = canonicalMemoryTool(tool);
  // Only the KBs the token's persona may read (its kbSources ∩ installed).
  switch (tool) {
    case c.memory_stores.name:
      parseToolArgs(c.memory_stores, body);
      return kbHandlers.list_kbs(personaKbs(claims.persona));
    case c.memory_search_stores.name:
      return kbHandlers.search_kbs(parseToolArgs(c.memory_search_stores, body), personaKbs(claims.persona));
  }
  const ctx = deps.slackCtx(claims);
  const surface = deps.surfaceFor(ctx);
  const brainDeps = deps.brainDeps(ctx, surface, claims);
  if (!brainDeps) return null; // brain disabled → tools not mounted, like createKbMcp
  switch (tool) {
    case c.memory_think.name:
      return brainHandlers.kb_think(parseToolArgs(c.memory_think, body), brainDeps);
    case c.memory_search.name:
      return brainHandlers.kb_search(parseToolArgs(c.memory_search, body), brainDeps);
    case c.memory_get.name:
      return brainHandlers.kb_get_page(parseToolArgs(c.memory_get, body), brainDeps);
    case c.memory_list.name:
      return brainHandlers.kb_list_pages(parseToolArgs(c.memory_list, body), brainDeps);
    case c.memory_graph.name:
      return brainHandlers.kb_graph(parseToolArgs(c.memory_graph, body), brainDeps);
    case c.memory_save.name:
      return brainHandlers.kb_memoize(parseToolArgs(c.memory_save, body), brainDeps);
    case c.memory_about.name:
      return brainHandlers.memory_about(parseToolArgs(c.memory_about, body), brainDeps);
    case c.memory_thread_history.name:
      return brainHandlers.kb_thread_history(parseToolArgs(c.memory_thread_history, body), brainDeps);
    case c.memory_delete.name:
      return brainHandlers.kb_delete_page(parseToolArgs(c.memory_delete, body), brainDeps);
    default:
      return null;
  }
}
