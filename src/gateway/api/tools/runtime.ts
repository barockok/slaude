/**
 * POST /v1/tools/runtime/<tool> — same handlers as the `slaude_runtime` MCP
 * server (adminHandlers), context derived from the job claims. The snake_case →
 * camelCase argument mapping mirrors createRuntimeMcp exactly.
 */
import { adminHandlers } from "../../slack/mcp-tools";
import type { JobClaims } from "../auth";
import type { ToolPlaneDeps, ToolResult } from "./deps";

export async function executeRuntimeTool(
  tool: string,
  args: Record<string, unknown>,
  claims: JobClaims,
  deps: ToolPlaneDeps,
): Promise<ToolResult | null> {
  const ctx = deps.slackCtx(claims);
  const a = args as any;
  switch (tool) {
    case "ignore_thread":
      return adminHandlers.ignoreThread(ctx, { duration: a.duration, reason: a.reason });
    case "unignore_thread":
      return adminHandlers.unignoreThread(ctx);
    case "ignore_user":
      return adminHandlers.ignoreUser(ctx, { userId: a.user_id, duration: a.duration, reason: a.reason });
    case "unignore_user":
      return adminHandlers.unignoreUser(ctx, { userId: a.user_id });
    case "list_cron_jobs":
      return adminHandlers.listCronJobs(ctx);
    case "add_cron_job":
      return adminHandlers.addCronJob(ctx, { cronExpr: a.cron_expr, prompt: a.prompt, target: a.target, whenActive: a.when_active });
    case "edit_cron_job":
      return adminHandlers.editCronJob(ctx, { jobId: a.job_id, cronExpr: a.cron_expr, prompt: a.prompt, target: a.target, whenActive: a.when_active });
    case "pause_cron_job":
      return adminHandlers.pauseCronJob(ctx, { jobId: a.job_id });
    case "resume_cron_job":
      return adminHandlers.resumeCronJob(ctx, { jobId: a.job_id });
    case "remove_cron_job":
      return adminHandlers.removeCronJob(ctx, { jobId: a.job_id });
    case "trigger_ingest":
      return adminHandlers.triggerIngest(ctx);
    case "reload_session":
      return adminHandlers.reloadSession(ctx, { prompt: a.prompt });
    default:
      return null;
  }
}
