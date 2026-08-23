/**
 * POST /v1/tools/runtime/<tool> — same handlers as the `slaude_runtime` MCP
 * server (adminHandlers), context derived from the job claims. The snake_case →
 * camelCase argument mapping mirrors createRuntimeMcp exactly, and each case
 * parses with the contract schema so tsc checks the mapping against the
 * handler's parameter type — no casts.
 */
import { adminHandlers } from "../../slack/mcp-tools";
import { runtimeContract } from "../../../tools/contracts/runtime";
import { parseToolArgs } from "../../../tools/contracts/types";
import type { JobClaims } from "../auth";
import type { ToolPlaneDeps, ToolResult } from "./deps";

const c = runtimeContract.tools;

export async function executeRuntimeTool(
  tool: string,
  body: unknown,
  claims: JobClaims,
  deps: ToolPlaneDeps,
): Promise<ToolResult | null> {
  const ctx = deps.slackCtx(claims);
  switch (tool) {
    case c.ignore_thread.name:
      return adminHandlers.ignoreThread(ctx, parseToolArgs(c.ignore_thread, body));
    case c.unignore_thread.name:
      parseToolArgs(c.unignore_thread, body);
      return adminHandlers.unignoreThread(ctx);
    case c.ignore_user.name: {
      const a = parseToolArgs(c.ignore_user, body);
      return adminHandlers.ignoreUser(ctx, { userId: a.user_id, duration: a.duration, reason: a.reason });
    }
    case c.unignore_user.name: {
      const a = parseToolArgs(c.unignore_user, body);
      return adminHandlers.unignoreUser(ctx, { userId: a.user_id });
    }
    case c.list_cron_jobs.name:
      parseToolArgs(c.list_cron_jobs, body);
      return adminHandlers.listCronJobs(ctx);
    case c.add_cron_job.name: {
      const a = parseToolArgs(c.add_cron_job, body);
      return adminHandlers.addCronJob(ctx, { cronExpr: a.cron_expr, prompt: a.prompt, target: a.target, whenActive: a.when_active });
    }
    case c.edit_cron_job.name: {
      const a = parseToolArgs(c.edit_cron_job, body);
      return adminHandlers.editCronJob(ctx, { jobId: a.job_id, cronExpr: a.cron_expr, prompt: a.prompt, target: a.target, whenActive: a.when_active });
    }
    case c.pause_cron_job.name: {
      const a = parseToolArgs(c.pause_cron_job, body);
      return adminHandlers.pauseCronJob(ctx, { jobId: a.job_id });
    }
    case c.resume_cron_job.name: {
      const a = parseToolArgs(c.resume_cron_job, body);
      return adminHandlers.resumeCronJob(ctx, { jobId: a.job_id });
    }
    case c.remove_cron_job.name: {
      const a = parseToolArgs(c.remove_cron_job, body);
      return adminHandlers.removeCronJob(ctx, { jobId: a.job_id });
    }
    case c.trigger_ingest.name:
      parseToolArgs(c.trigger_ingest, body);
      return adminHandlers.triggerIngest(ctx);
    case c.reload_session.name:
      return adminHandlers.reloadSession(ctx, parseToolArgs(c.reload_session, body));
    case c.can_use_tool.name: {
      // REST-only (never MCP-mounted): the node worker's permissionResolver
      // opens a gate here and long-polls /v1/pending/:id for the click.
      const a = parseToolArgs(c.can_use_tool, body);
      const res = await deps.openPermission(claims, {
        toolName: a.tool_name,
        input: (a.input ?? {}) as Record<string, unknown>,
        toolUseId: a.tool_use_id,
        decisionReason: a.decision_reason,
        suggestions: a.suggestions,
      });
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }
    default:
      return null;
  }
}
