/**
 * POST /v1/tools/skills/<tool> — same handlers as the `slaude_skills` MCP
 * server, persona-scoped from the job claims. Contract-parsed args flow
 * straight into the handlers, type-checked by tsc — no casts.
 */
import { makeSkillHandlers } from "../../../skills/mcp-tools";
import { skillsContract } from "../../../tools/contracts/skills";
import { parseToolArgs } from "../../../tools/contracts/types";
import type { JobClaims } from "../auth";
import type { ToolResult } from "./deps";

const c = skillsContract.tools;

export async function executeSkillsTool(
  tool: string,
  body: unknown,
  claims: JobClaims,
): Promise<ToolResult | null> {
  const handlers = makeSkillHandlers(claims.persona);
  switch (tool) {
    case c.list_skills.name:
      parseToolArgs(c.list_skills, body);
      return handlers.list_skills();
    case c.read_skill.name:
      return handlers.read_skill(parseToolArgs(c.read_skill, body));
    case c.write_skill.name:
      return handlers.write_skill(parseToolArgs(c.write_skill, body));
    case c.delete_skill.name:
      return handlers.delete_skill(parseToolArgs(c.delete_skill, body));
    case c.sync_manifest.name:
      parseToolArgs(c.sync_manifest, body);
      return handlers.sync_manifest();
    default:
      return null;
  }
}
