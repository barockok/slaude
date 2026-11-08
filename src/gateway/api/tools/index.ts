/**
 * REST tool plane: POST /v1/tools/<server>/<tool> (spec §3), one-to-one with
 * today's MCP tools. Each executor validates the body against the shared
 * contract schema (strict) and passes the schema-inferred args straight into
 * the same handlers the MCP servers use — so tsc checks contract-vs-handler
 * drift at compile time and a ZodError here becomes a 400. Results are the
 * MCP-shaped {content:[...]} JSON the in-process handlers return.
 */
import { ZodError } from "zod";
import { surfaceContract } from "../../../tools/contracts/surface";
import { slackContract } from "../../../tools/contracts/slack";
import { runtimeContract } from "../../../tools/contracts/runtime";
import { connectContract } from "../../../tools/contracts/connect";
import { skillsContract } from "../../../tools/contracts/skills";
import { canonicalMemoryTool, isMemoryToolAlias, kbContract } from "../../../tools/contracts/kb";
import { zodIssueLine, type ServerContract } from "../../../tools/contracts/types";
import { m as metric } from "../../../metrics";
import { wakeAllows, wakeRefusal } from "../../../proactive/wake-guard";
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
  body: unknown,
  claims: JobClaims,
  deps: ToolPlaneDeps,
) => Promise<ToolResult | null>;

/** Path segment (spec §3 short name) → contract + executor. */
export const SERVERS: Record<string, { contract: ServerContract; execute: Executor }> = {
  surface: { contract: surfaceContract, execute: executeSurfaceTool },
  slack: { contract: slackContract, execute: executeSlackTool },
  runtime: { contract: runtimeContract, execute: executeRuntimeTool },
  connect: { contract: connectContract, execute: executeConnectTool },
  skills: { contract: skillsContract, execute: (t, b, c) => executeSkillsTool(t, b, c) },
  kb: { contract: kbContract, execute: executeKbTool },
};

export async function executeToolCall(
  server: string,
  tool: string,
  body: unknown,
  claims: JobClaims,
  deps: ToolPlaneDeps,
): Promise<Response> {
  // Own keys only: a segment like `constructor` would otherwise find an
  // Object.prototype member and fail as a 500 instead of a 404.
  const entry = Object.hasOwn(SERVERS, server) ? SERVERS[server] : undefined;
  if (!entry) return notFound(`unknown tool server '${server}'`);
  if (!Object.hasOwn(entry.contract.tools, tool)) return notFound(`unknown tool '${server}/${tool}'`);
  // A memory tool counts under its memory_* name; `alias` says whether the
  // caller used the deprecated kb_* name (a session resumed from before the rename).
  const alias = server === "kb" && isMemoryToolAlias(tool);
  metric.v1ToolCallsTotal.inc({ server, tool: server === "kb" ? canonicalMemoryTool(tool) : tool, alias: alias ? "true" : "false" });
  // A wake's allow-list, from the signed claim. can_use_tool and
  // guardrail_event are the node's plumbing, not a model's call: the first
  // answers for itself (a refusal), the second only records.
  if (claims.wake && tool !== "can_use_tool" && tool !== "guardrail_event" && !wakeAllows(server, tool)) {
    return json(200, { content: [{ type: "text", text: wakeRefusal(tool) }], isError: true });
  }
  let result: ToolResult | null;
  try {
    result = await entry.execute(tool, body, claims, deps);
  } catch (e) {
    if (e instanceof ZodError) return json(400, { error: `invalid input: ${zodIssueLine(e)}` });
    throw e;
  }
  if (result === null) return notFound(`tool '${server}/${tool}' is not mounted in this deployment`);
  return json(200, result);
}
