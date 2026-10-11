/**
 * Node-side MCP shims (spec §6): the SAME tool names, descriptions and zod
 * schemas the in-process gateway servers mount — imported from
 * src/tools/contracts — with handlers that POST /v1/tools/<server>/<tool>
 * and return the gateway's MCP-shaped result verbatim. The model cannot tell
 * a shim from the in-process server; the wire hop is invisible.
 *
 * Exceptions:
 *   - restOnly contract entries (runtime/can_use_tool) are never mounted —
 *     they are node plumbing, not model tools.
 *   - surface/request_approval blocks the MODEL, not the HTTP call: the REST
 *     endpoint returns {pendingId} (spec §3), so the shim long-polls
 *     /v1/pending/:id and renders the same "approved by ..." text the
 *     in-process handler returns.
 *   - slaude_session (token budget) stays node-local — the worker mounts the
 *     existing createSessionMcp next to these shims.
 *
 * The job token is resolved per call (not captured at mount) so a coalesced
 * follow-up job's fresher token replaces one about to expire mid-session.
 */
import {
  createSdkMcpServer,
  tool,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { surfaceContract } from "../../tools/contracts/surface";
import { slackContract } from "../../tools/contracts/slack";
import { runtimeContract } from "../../tools/contracts/runtime";
import { connectContract } from "../../tools/contracts/connect";
import { skillsContract } from "../../tools/contracts/skills";
import { kbContract } from "../../tools/contracts/kb";
import { mcpMountedTools, type ServerContract } from "../../tools/contracts/types";
import { decisionFromApprovalRow } from "../../gateway/slack/approval-gate";
import type { NodeClient, ToolResult } from "../client";
import { pollPending } from "../pending";
import { VOICE_QUIET_SLACK_TOOLS, VOICE_QUIET_TOOLS, VOICE_SUPPRESSED_RESULT } from "../../voice/turn-flags";

/** Contract server name → REST path segment (spec §3 tool plane). */
export const REST_SERVER_SEGMENT: Record<string, string> = {
  [surfaceContract.server]: "surface",
  [slackContract.server]: "slack",
  [runtimeContract.server]: "runtime",
  [connectContract.server]: "connect",
  [skillsContract.server]: "skills",
  [kbContract.server]: "kb",
};

export interface ShimDeps {
  client: NodeClient;
  /** Live per-session job token (worker-maintained; newest job wins). */
  tokenFor(sessionId: string): string | undefined;
  /** Abort signal for the session's current turn, when available — stops the
   *  request_approval long-poll on /abort. */
  signalFor?(sessionId: string): AbortSignal | undefined;
  /** True while this session runs a voice-origin turn (voice mode, plan
   *  deviation 3): user-visible surface writes are dropped locally. */
  voiceActive?(sessionId: string): boolean;
}

const errResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function shimServer(contract: ServerContract, sessionId: string, deps: ShimDeps): McpServerConfig {
  const segment = REST_SERVER_SEGMENT[contract.server]!;
  return createSdkMcpServer({
    name: contract.server,
    version: "0.1.0",
    tools: mcpMountedTools(contract).map((t) =>
      // Return type widened to the SDK's CallToolResult via `any`: our
      // ToolResult is the same MCP shape minus the SDK's index signature.
      tool(t.name, t.description, t.schema, async (args: Record<string, unknown>): Promise<any> => {
        const token = deps.tokenFor(sessionId);
        if (!token) return errResult(`no job token for session ${sessionId} — turn not started via the queue?`);
        const quiet =
          (contract.server === surfaceContract.server && VOICE_QUIET_TOOLS.has(t.name)) ||
          (contract.server === slackContract.server && VOICE_QUIET_SLACK_TOOLS.has(t.name));
        if (quiet && deps.voiceActive?.(sessionId)) return VOICE_SUPPRESSED_RESULT;
        try {
          if (contract.server === surfaceContract.server && t.name === surfaceContract.tools.request_approval.name) {
            return await requestApprovalOverRest(sessionId, args, token, deps);
          }
          return await deps.client.postTool(segment, t.name, args, token);
        } catch (e) {
          return errResult(`${segment}/${t.name} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    ),
  });
}

/** request_approval: open (→ pendingId) + long-poll + render the same text
 *  the in-process surface handler returns. */
async function requestApprovalOverRest(
  sessionId: string,
  args: Record<string, unknown>,
  token: string,
  deps: ShimDeps,
): Promise<ToolResult> {
  const opened = await deps.client.postTool("surface", "request_approval", args, token);
  if (opened.isError) return opened;
  let pendingId: string;
  try {
    pendingId = (JSON.parse(opened.content[0]?.text ?? "{}") as { pendingId?: string }).pendingId ?? "";
  } catch {
    pendingId = "";
  }
  if (!pendingId) return errResult("approval open returned no pendingId");
  const outcome = await pollPending(deps.client, pendingId, {
    signal: deps.signalFor?.(sessionId),
    jobToken: () => deps.tokenFor(sessionId) ?? token,
  });
  if (outcome === "aborted") return errResult("approval request aborted");
  if (outcome === "notfound") return errResult("approval gate disappeared before a decision");
  if ("refused" in outcome) return errResult(`the gateway refused the approval poll (${outcome.refused.status})`);
  const d = decisionFromApprovalRow({ status: outcome.status, resolvedBy: outcome.resolvedBy });
  return {
    content: [
      {
        type: "text",
        text: d.approved ? `approved by <@${d.by}>` : `denied by <@${d.by}>${d.note ? ` (${d.note})` : ""}`,
      },
    ],
  };
}

/** All REST-backed shim servers for one session, keyed by MCP server name. */
export function buildShimServers(sessionId: string, deps: ShimDeps): Record<string, McpServerConfig> {
  const contracts: ServerContract[] = [
    surfaceContract,
    slackContract,
    runtimeContract,
    connectContract,
    skillsContract,
    kbContract,
  ];
  const servers: Record<string, McpServerConfig> = {};
  for (const c of contracts) servers[c.server] = shimServer(c, sessionId, deps);
  return servers;
}
