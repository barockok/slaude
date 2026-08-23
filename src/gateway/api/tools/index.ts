/**
 * REST tool plane: POST /v1/tools/<server>/<tool> (spec §3), one-to-one with
 * today's MCP tools. Bodies are validated against the shared contracts
 * (src/tools/contracts) and results are the MCP-shaped {content:[...]} JSON
 * the in-process handlers return.
 */
import { surfaceContract } from "../../../tools/contracts/surface";
import { slackContract } from "../../../tools/contracts/slack";
import { runtimeContract } from "../../../tools/contracts/runtime";
import { connectContract } from "../../../tools/contracts/connect";
import { skillsContract } from "../../../tools/contracts/skills";
import { kbContract } from "../../../tools/contracts/kb";
import { parseToolInput, type ServerContract } from "../../../tools/contracts/types";
import { m as metric } from "../../../metrics";
import type { JobClaims } from "../auth";
import { json, notFound } from "../http";
import type { ToolPlaneDeps, ToolResult } from "./deps";
import { executeSurfaceTool } from "./surface";
import { executeSlackTool } from "./slack";
import { executeRuntimeTool } from "./runtime";
import { executeConnectTool } from "./connect";
import { executeSkillsTool } from "./skills";
import { executeKbTool } from "./kb";

type Executor = (
  tool: string,
  args: Record<string, unknown>,
  claims: JobClaims,
  deps: ToolPlaneDeps,
) => Promise<ToolResult | null>;

/** Path segment (spec §3 short name) → contract + executor. */
const SERVERS: Record<string, { contract: ServerContract; execute: Executor }> = {
  surface: { contract: surfaceContract, execute: executeSurfaceTool },
  slack: { contract: slackContract, execute: executeSlackTool },
  runtime: { contract: runtimeContract, execute: executeRuntimeTool },
  connect: { contract: connectContract, execute: executeConnectTool },
  skills: { contract: skillsContract, execute: (t, a, c) => executeSkillsTool(t, a, c) },
  kb: { contract: kbContract, execute: executeKbTool },
};

export async function executeToolCall(
  server: string,
  tool: string,
  body: unknown,
  claims: JobClaims,
  deps: ToolPlaneDeps,
): Promise<Response> {
  const entry = SERVERS[server];
  if (!entry) return notFound(`unknown tool server '${server}'`);
  const contract = entry.contract.tools[tool];
  if (!contract) return notFound(`unknown tool '${server}/${tool}'`);
  const parsed = parseToolInput(contract, body);
  if (!parsed.ok) return json(400, { error: `invalid input: ${parsed.error}` });
  metric.v1ToolCallsTotal.inc({ server, tool });
  const result = await entry.execute(tool, parsed.args, claims, deps);
  if (result === null) return notFound(`tool '${server}/${tool}' is not mounted in this deployment`);
  return json(200, result);
}
