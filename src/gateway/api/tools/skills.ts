/**
 * POST /v1/tools/skills/<tool> — same handlers as the `slaude_skills` MCP
 * server, persona-scoped from the job claims.
 */
import { makeSkillHandlers } from "../../../skills/mcp-tools";
import type { JobClaims } from "../auth";
import type { ToolResult } from "./deps";

export async function executeSkillsTool(
  tool: string,
  args: Record<string, unknown>,
  claims: JobClaims,
): Promise<ToolResult | null> {
  const handlers = makeSkillHandlers(claims.persona);
  const a = args as any;
  switch (tool) {
    case "list_skills":
      return handlers.list_skills();
    case "read_skill":
      return handlers.read_skill({ slug: a.slug });
    case "write_skill":
      return handlers.write_skill({ slug: a.slug, name: a.name, description: a.description, body: a.body });
    case "delete_skill":
      return handlers.delete_skill({ slug: a.slug });
    case "sync_manifest":
      return handlers.sync_manifest();
    default:
      return null;
  }
}
