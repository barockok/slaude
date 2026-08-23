/**
 * Dependencies the REST tool plane needs from the live gateway. Built inside
 * createGateway (src/gateway/core/gateway.ts) so every REST tool call runs the
 * SAME engines as the MCP tools: the same Surface factory, approval gate,
 * OneOnOne/mention-only/connect engines, and brain scoping.
 *
 * The SessionContext is derived FROM THE JOB TOKEN (team, channel, thread,
 * initiator, persona) — never from the request body.
 */
import type { SlackContext } from "../../slack/mcp-tools";
import type { Surface } from "../../core/surface";
import type { SurfaceMcpOpts } from "../../core/surface-mcp";
import type { BrainToolDeps } from "../../../knowledge/mcp-tools";
import type { PermissionDecision } from "../../slack/permission-gate";
import type { JobClaims } from "../auth";

/** MCP-shaped tool result, exactly what the SDK handlers return. */
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface ToolPlaneDeps {
  /** Build a per-request SlackContext from the verified job claims (client
   *  resolved per persona/tenant; approval + reload engines wired). */
  slackCtx(claims: JobClaims): SlackContext;
  /** Build the interaction Surface for that context (persona-aware factory). */
  surfaceFor(ctx: SlackContext): Surface;
  /** Surface tool opts (initiator getter + 1on1/mention-only engines) bound to
   *  the claims' session. */
  surfaceOpts(claims: JobClaims, ctx: SlackContext): SurfaceMcpOpts;
  /** The natural-language MCP OAuth connect engine (slaude_connect). */
  connect(claims: JobClaims, ctx: SlackContext, server: string): Promise<string>;
  /** Brain tool deps (scope/gate/approval) for the context; undefined when the
   *  brain is disabled. */
  brainDeps(ctx: SlackContext, surface: Surface): BrainToolDeps | undefined;
  /** Non-blocking permission gate open (runtime/can_use_tool, spec §3
   *  "Blocking tools"): immediate policy decision, or a pendingId the node
   *  long-polls on /v1/pending/:id. */
  openPermission(
    claims: JobClaims,
    args: {
      toolName: string;
      input: Record<string, unknown>;
      toolUseId: string;
      decisionReason?: string;
      suggestions?: unknown[];
    },
  ): Promise<{ decision: PermissionDecision } | { pendingId: string }>;
  /** Non-blocking plan-approval open (surface/request_approval over REST):
   *  card posted, durable row minted, {pendingId} returned for long-polling. */
  openApproval(
    claims: JobClaims,
    args: { summary: string; tools?: string[]; files?: string[]; risks?: string; category?: string },
  ): Promise<{ pendingId: string }>;
}
