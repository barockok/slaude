/**
 * Contract for the `slaude_runtime` MCP server (control-plane housekeeping:
 * ignore gates, cron jobs, KB ingest, session reload).
 */
import { z } from "zod";
import type { ServerContract } from "./types";

export const RUNTIME_SERVER = "slaude_runtime";

export const runtimeContract = {
  server: RUNTIME_SERVER,
  tools: {
    ignore_thread: {
      name: "ignore_thread",
      description:
        "Temporarily ignore this thread when the conversation drifts out of mandate. Use to prevent infinite loops or unproductive back-and-forth. The thread will be silently dropped until the ignore expires or a manager removes it. Requires manager or approver authorization.",
      schema: {
        duration: z
          .string()
          .describe("Duration like '5m', '10m', '1h'. Use 'permanent' only as absolute last resort. Max 24h."),
        reason: z.string().describe("Brief reason why the thread is being ignored."),
      },
    },
    unignore_thread: {
      name: "unignore_thread",
      description:
        "Resume normal processing in this thread after a previous ignore_thread call. Use when the conversation has returned to your mandate, the user explicitly asks to un-ignore, or you previously ignored by mistake. Requires manager or approver authorization.",
      schema: {},
    },
    ignore_user: {
      name: "ignore_user",
      description:
        "Temporarily ignore a specific user across all threads. Use when a user is repeatedly sending off-topic or disruptive messages. The user will be silently dropped until the ignore expires or a manager removes it. Requires manager or approver authorization.",
      schema: {
        user_id: z.string().describe("User ID to ignore (e.g. U123ABC)."),
        duration: z.string().describe("Duration like '5m', '10m', '1h', or 'permanent'. Max 24h."),
        reason: z.string().describe("Brief reason why the user is being ignored."),
      },
    },
    unignore_user: {
      name: "unignore_user",
      description: "Stop ignoring a previously ignored user. Requires manager or approver authorization.",
      schema: {
        user_id: z.string().describe("User ID to unignore (e.g. U123ABC)."),
      },
    },
    list_cron_jobs: {
      name: "list_cron_jobs",
      description:
        "List all active scheduled cron jobs. Use when the user asks what recurring tasks are set up, wants to audit scheduled work, or needs a job ID before calling remove_cron_job. Returns job IDs, cron expressions, prompts, and next run times.",
      schema: {},
    },
    add_cron_job: {
      name: "add_cron_job",
      description:
        "Schedule a recurring prompt that fires on a cron expression and posts results back to Slack. Use when the user asks for regular check-ins (e.g. 'daily summary'), weekly reports, recurring reminders, or periodic tasks. Requires manager or approver authorization. Use 5-field cron format: minute hour day-of-month month day-of-week (UTC). Examples: '0 9 * * 1-5' = weekdays at 9am UTC; '0 0 * * *' = daily midnight; '*/30 * * * *' = every 30 minutes. By default the result posts in THIS thread; pass target='channel' to broadcast at the channel root instead. By default the job fires even if someone is chatting in the target; pass when_active='skip' to defer that run while a human is active.",
      schema: {
        cron_expr: z.string().describe("5-field cron expression in UTC. e.g. '0 9 * * 1-5' for weekdays at 9am."),
        prompt: z.string().describe("The prompt sent to you each time the job fires. Be specific so future you knows what to do."),
        target: z.enum(["thread", "channel"]).optional().describe("Where the result posts: 'thread' (default, this thread) or 'channel' (the channel root, a fresh top-level message)."),
        when_active: z.enum(["fire", "skip"]).optional().describe("Behavior when a human is active in the target: 'fire' (default, run anyway) or 'skip' (defer this run, humans get priority)."),
      },
    },
    edit_cron_job: {
      name: "edit_cron_job",
      description:
        "Update an existing scheduled cron job. Use when the user wants to change the schedule, prompt, posting target, or passive/active behavior without deleting and recreating the job. Requires manager or approver authorization.",
      schema: {
        job_id: z.string().describe("Full job ID or 8-character prefix from list_cron_jobs."),
        cron_expr: z.string().optional().describe("Replacement 5-field cron expression in UTC."),
        prompt: z.string().optional().describe("Replacement prompt sent each time the job fires."),
        target: z.enum(["thread", "channel"]).optional().describe("Replacement posting target."),
        when_active: z.enum(["fire", "skip"]).optional().describe("Replacement active-session behavior."),
      },
    },
    pause_cron_job: {
      name: "pause_cron_job",
      description:
        "Pause a scheduled cron job without deleting it. Paused jobs stay listed and can be manually run once or resumed later. Requires manager or approver authorization.",
      schema: {
        job_id: z.string().describe("Full job ID or 8-character prefix from list_cron_jobs."),
      },
    },
    resume_cron_job: {
      name: "resume_cron_job",
      description:
        "Resume a paused cron job and recompute its next future run from its stored cron expression. Requires manager or approver authorization.",
      schema: {
        job_id: z.string().describe("Full job ID or 8-character prefix from list_cron_jobs."),
      },
    },
    remove_cron_job: {
      name: "remove_cron_job",
      description:
        "Deactivate a scheduled cron job by its full ID or 8-char prefix. The job is soft-deleted (set inactive) — historical runs remain in the database. Use when a recurring task is no longer needed, the user asks to cancel something scheduled, or a job was created by mistake. Call list_cron_jobs first to find the ID. Requires manager or approver authorization.",
      schema: {
        job_id: z.string().describe("Full job ID or 8-character prefix from list_cron_jobs."),
      },
    },
    trigger_ingest: {
      name: "trigger_ingest",
      description:
        "Synchronize raw knowledge-base content into the processed wiki format. Use when new raw files have been added to the KB and the user asks to refresh, rebuild, or update the knowledge base. This can be slow — only trigger when actually needed. Requires manager or approver authorization.",
      schema: {},
    },
    can_use_tool: {
      name: "can_use_tool",
      description:
        "REST-only (never mounted for the model): a node worker opens a permission gate for a tool call the SDK wants to run. The gateway applies the auto-allow policy; when a human decision is needed it posts the Block Kit permission card and returns {pendingId} for the node to long-poll on /v1/pending/:id (spec §3 'Blocking tools'). Short-circuits return {decision} immediately.",
      restOnly: true,
      schema: {
        tool_name: z.string().describe("Tool the SDK asked to run (e.g. 'Bash')."),
        input: z.record(z.unknown()).optional().describe("Tool input, echoed on the approval card."),
        tool_use_id: z.string().describe("SDK toolUseID — becomes the pending gate id."),
        decision_reason: z.string().optional().describe("SDK-provided reason line, shown on the card."),
        suggestions: z
          .array(z.unknown())
          .optional()
          .describe("SDK PermissionUpdate suggestions, persisted so an 'always allow' click can be honored node-side."),
      },
    },
    reload_session: {
      name: "reload_session",
      description:
        "Gracefully reload the current session so newly installed MCP servers, plugins, or skills are picked up on the next turn. Closes the SDK loop cleanly (no scary error messages) and marks the session idle. The next inbound message starts a fresh Query with freshly-resolved MCPs, plugins, and skills. Optionally pass `prompt` to auto-inject a message immediately after reload so the session resumes without waiting for user input. Requires manager or approver authorization.",
      schema: {
        prompt: z.string().optional().describe("If provided, injected as the first message of the fresh session so the flow resumes automatically."),
      },
    },
  },
} as const satisfies ServerContract;
