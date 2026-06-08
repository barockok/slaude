import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { WebClient } from "@slack/web-api";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { mdToMrkdwn } from "./format";
import { redactSlack } from "./redact";
import { soulData } from "../../soul/extract";
import * as Ignores from "../../db/ignores";
import * as CronJobs from "../../db/cron-jobs";
import { getNextRun } from "./cron-parser";
import { run as runIngest } from "../../knowledge/ingest";

function format(text: string): string {
  return redactSlack(mdToMrkdwn(text), soulData().redactPatterns);
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/**
 * Per-session Slack output context. The slack MCP tools close over this
 * object. The adapter mutates `inboundTs` when a new user message arrives so
 * the agent's reactions land on the right message.
 */
export type SlackContext = {
  client: WebClient;
  channel: string;
  threadTs: string;
  /** ts of the latest inbound user message in this thread. */
  inboundTs: string;
  /** When "channel", `reply` posts at channel root (omits thread_ts). Default: thread. */
  postTarget?: "thread" | "channel";
  /** Slack user id of the current turn's author. */
  userId?: string;
  /** Slack team id of the current workspace. */
  teamId?: string;
  /** Optional approval gate — set by the adapter so request_approval works. */
  requestApproval?: (req: {
    summary: string;
    tools?: string[];
    files?: string[];
    risks?: string;
    category?: string;
  }) => Promise<{ approved: boolean; by: string; note?: string }>;
  /** Optional session reload — set by the adapter so reload_session works. */
  reloadSession?: () => boolean;
};

export const SLACK_MCP_NAME = "slaude_slack";

export const slackHandlers = {
  async reply(ctx: SlackContext, { text }: { text: string }): Promise<ToolResult> {
    try {
      const r = await ctx.client.chat.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.postTarget === "channel" ? undefined : ctx.threadTs,
        text: format(text),
        mrkdwn: true,
      });
      return ok(`posted ts=${r.ts}`);
    } catch (e: any) {
      return err(`slack reply failed: ${e?.message ?? String(e)}`);
    }
  },

  async edit(ctx: SlackContext, { ts, text }: { ts: string; text: string }): Promise<ToolResult> {
    try {
      await ctx.client.chat.update({
        channel: ctx.channel,
        ts,
        text: format(text),
      });
      return ok("edited");
    } catch (e: any) {
      return err(`slack edit failed: ${e?.message ?? String(e)}`);
    }
  },

  async react(ctx: SlackContext, { name, ts }: { name: string; ts?: string }): Promise<ToolResult> {
    try {
      await ctx.client.reactions.add({
        channel: ctx.channel,
        timestamp: ts ?? ctx.inboundTs,
        name,
      });
      return ok(`reacted :${name}:`);
    } catch (e: any) {
      const msg = e?.data?.error ?? e?.message ?? String(e);
      if (msg === "already_reacted") return ok("already reacted");
      return err(`slack react failed: ${msg}`);
    }
  },

  async unreact(ctx: SlackContext, { name, ts }: { name: string; ts?: string }): Promise<ToolResult> {
    try {
      await ctx.client.reactions.remove({
        channel: ctx.channel,
        timestamp: ts ?? ctx.inboundTs,
        name,
      });
      return ok(`unreacted :${name}:`);
    } catch (e: any) {
      return err(`slack unreact failed: ${e?.data?.error ?? e?.message ?? String(e)}`);
    }
  },

  async request_approval(
    ctx: SlackContext,
    {
      summary,
      tools,
      files,
      risks,
      category,
    }: {
      summary: string;
      tools?: string[];
      files?: string[];
      risks?: string;
      category?: string;
    },
  ): Promise<ToolResult> {
    if (!ctx.requestApproval) {
      return err("approval gate not wired (transport bug)");
    }
    try {
      const r = await ctx.requestApproval({ summary, tools, files, risks, category });
      if (r.approved) {
        return ok(`approved by <@${r.by}>`);
      }
      return ok(`denied by <@${r.by}>${r.note ? ` (${r.note})` : ""}`);
    } catch (e: any) {
      return err(`approval request failed: ${e?.message ?? String(e)}`);
    }
  },

  async upload(
    ctx: SlackContext,
    {
      path,
      title,
      initial_comment,
      alt_text,
    }: {
      path: string;
      title?: string;
      initial_comment?: string;
      alt_text?: string;
    },
  ): Promise<ToolResult> {
    try {
      statSync(path); // throws if missing
      const filename = basename(path);
      const r = await ctx.client.files.uploadV2({
        channel_id: ctx.channel,
        thread_ts: ctx.threadTs,
        file: createReadStream(path),
        filename,
        title: title ?? filename,
        ...(initial_comment ? { initial_comment: format(initial_comment) } : {}),
        ...(alt_text ? { alt_text } : {}),
      } as any);
      const ids = ((r as any).files ?? [])
        .map((f: any) => f?.files?.[0]?.id ?? f?.id)
        .filter(Boolean);
      return ok(`uploaded${ids.length ? ` file_id=${ids.join(",")}` : ""}`);
    } catch (e: any) {
      const msg = e?.data?.error ?? e?.message ?? String(e);
      return err(`slack upload failed: ${msg}`);
    }
  },

  async get_user_profile(ctx: SlackContext, { user_id }: { user_id?: string }): Promise<ToolResult> {
    try {
      if (!user_id) {
        return err("user_id required — pass the user_id from the channel envelope (e.g. U123ABC)");
      }
      const r = await ctx.client.users.info({ user: user_id });
      const u = (r.user ?? {}) as any;
      const p = (u.profile ?? {}) as any;
      const payload = {
        id: u.id,
        name: u.name,
        real_name: p.real_name,
        display_name: p.display_name,
        title: p.title,
        email: p.email,
        phone: p.phone,
        status_text: p.status_text,
        status_emoji: p.status_emoji,
        timezone: u.tz,
        timezone_label: u.tz_label,
        pronouns: p.pronouns,
        first_name: p.first_name,
        last_name: p.last_name,
        is_admin: u.is_admin,
        is_owner: u.is_owner,
        is_bot: u.is_bot,
        updated: u.updated,
      };
      return ok(JSON.stringify(payload, null, 2));
    } catch (e: any) {
      return err(`slack users.info failed: ${e?.data?.error ?? e?.message ?? String(e)}`);
    }
  },

  async get_channel_info(ctx: SlackContext): Promise<ToolResult> {
    try {
      const r = await ctx.client.conversations.info({ channel: ctx.channel });
      const c = (r.channel ?? {}) as any;
      const payload = {
        id: c.id,
        name: c.name,
        is_channel: c.is_channel,
        is_group: c.is_group,
        is_im: c.is_im,
        is_private: c.is_private,
        is_archived: c.is_archived,
        created: c.created,
        creator: c.creator,
        topic: c.topic?.value,
        purpose: c.purpose?.value,
        num_members: c.num_members,
      };
      return ok(JSON.stringify(payload, null, 2));
    } catch (e: any) {
      return err(`slack conversations.info failed: ${e?.data?.error ?? e?.message ?? String(e)}`);
    }
  },

  async get_thread_history(
    ctx: SlackContext,
    { limit, include_replies }: { limit?: number; include_replies?: boolean },
  ): Promise<ToolResult> {
    try {
      const r = await ctx.client.conversations.replies({
        channel: ctx.channel,
        ts: ctx.threadTs,
        limit: limit ?? 20,
      });
      const msgs = ((r.messages ?? []) as any[]).map((m) => ({
        ts: m.ts,
        user: m.user,
        text: m.text,
        thread_ts: m.thread_ts,
        reply_count: m.reply_count,
        ...(include_replies !== false && m.replies
          ? { replies: m.replies.map((r: any) => ({ ts: r.ts, user: r.user })) }
          : {}),
      }));
      return ok(JSON.stringify({ messages: msgs, has_more: r.has_more }, null, 2));
    } catch (e: any) {
      return err(`slack conversations.replies failed: ${e?.data?.error ?? e?.message ?? String(e)}`);
    }
  },

  async list_users_in_channel(ctx: SlackContext, { limit }: { limit?: number }): Promise<ToolResult> {
    try {
      const r = await ctx.client.conversations.members({
        channel: ctx.channel,
        limit: limit ?? 200,
      });
      return ok(
        JSON.stringify(
          { members: r.members ?? [], has_more: r.response_metadata?.next_cursor ? true : false },
          null,
          2,
        ),
      );
    } catch (e: any) {
      return err(`slack conversations.members failed: ${e?.data?.error ?? e?.message ?? String(e)}`);
    }
  },

  async search_messages(
    ctx: SlackContext,
    { query, count }: { query: string; count?: number },
  ): Promise<ToolResult> {
    try {
      const r = await ctx.client.search.messages({
        query,
        count: count ?? 10,
        sort: "score",
        sort_dir: "desc",
      });
      const matches = ((r.messages?.matches ?? []) as any[]).map((m) => ({
        ts: m.ts,
        channel: { id: m.channel?.id, name: m.channel?.name },
        user: m.user,
        username: m.username,
        text: m.text,
        permalink: m.permalink,
        score: m.score,
      }));
      return ok(JSON.stringify({ total: r.messages?.total, matches }, null, 2));
    } catch (e: any) {
      return err(`slack search.messages failed: ${e?.data?.error ?? e?.message ?? String(e)}`);
    }
  },
};

/** Check whether the current turn's user is manager or approver. */
function isManagerOrApprover(userId?: string): boolean {
  if (!userId) return false;
  const soul = soulData();
  if (soul.manager?.userId === userId) return true;
  if (soul.backupManager?.userId === userId) return true;
  if (soul.approvers?.some((a) => a.userId === userId)) return true;
  return false;
}

/** Parse a duration string like '5m', '1h', or 'permanent'.
 *  Returns minutes or permanent flag. Rejects invalid suffixes, decimals, and >24h. */
export function parseDuration(raw: string): { ok: true; minutes: number; permanent: boolean } | { ok: false; error: string } {
  if (raw === "permanent") return { ok: true, permanent: true, minutes: 0 };
  const match = raw.match(/^(\d+)(m|h)$/);
  if (!match) return { ok: false, error: "duration must be like '5m', '10m', '1h', or 'permanent'" };
  const num = parseInt(match[1]!, 10);
  const unit = match[2] as "m" | "h";
  const minutes = unit === "h" ? num * 60 : num;
  const MAX_MINUTES = 24 * 60; // 24 hours
  if (minutes > MAX_MINUTES) return { ok: false, error: "duration cannot exceed 24h" };
  return { ok: true, permanent: false, minutes };
}

/** Cron / ingest handlers — exposed as MCP tools so the agent can manage
 *  scheduled work and knowledge base directly. */
export const adminHandlers = {
  async listCronJobs(): Promise<ToolResult> {
    const jobs = CronJobs.listActive();
    if (!jobs.length) return ok("No active cron jobs.");
    const lines = jobs.map(
      (j) =>
        `• \`${j.id.slice(0, 8)}\` \`${j.cronExpr}\` [${j.target}] → ${j.prompt} (next: ${new Date(j.nextRunAt).toISOString()})`,
    );
    return ok("*Active cron jobs*\n" + lines.join("\n"));
  },

  async addCronJob(
    ctx: SlackContext,
    { cronExpr, prompt }: { cronExpr: string; prompt: string },
  ): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId)) {
      return err("Only manager or approver can add cron jobs.");
    }
    let nextRun: number;
    try {
      nextRun = getNextRun(cronExpr);
    } catch (e: any) {
      return err(`Invalid cron expression: ${e.message}`);
    }
    const job = CronJobs.create({
      slackTeamId: ctx.teamId,
      slackChannelId: ctx.channel,
      slackThreadTs: ctx.threadTs,
      channelId: ctx.channel,
      threadTs: ctx.threadTs,
      createdBy: ctx.userId ?? "agent",
      cronExpr,
      prompt,
      nextRunAt: nextRun,
    });
    return ok(
      `Cron job created (\`${job.id.slice(0, 8)}\`). Next run: ${new Date(nextRun).toISOString()}`,
    );
  },

  async removeCronJob(_ctx: SlackContext, { jobId }: { jobId: string }): Promise<ToolResult> {
    if (!isManagerOrApprover(_ctx.userId)) {
      return err("Only manager or approver can remove cron jobs.");
    }
    let job: CronJobs.CronJob | null;
    try {
      job = CronJobs.findByPrefix(jobId);
    } catch (e: any) {
      return err(e.message);
    }
    if (!job) return err(`Job \`${jobId}\` not found.`);
    CronJobs.deactivate(job.id);
    return ok(`Cron job \`${job.id.slice(0, 8)}\` deactivated.`);
  },

  async triggerIngest(ctx: SlackContext): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId)) {
      return err("Only manager or approver can trigger ingest.");
    }
    const result = await runIngest({ triggeredBy: ctx.userId ?? "agent" });
    if (result.ok) {
      return ok(`Ingest complete — ${result.summary}`);
    }
    return err(`Ingest failed: ${result.reason}`);
  },

  async ignoreThread(
    ctx: SlackContext,
    { duration, reason }: { duration: string; reason: string },
  ): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId)) {
      return err("Only manager or approver can ignore threads.");
    }
    const parsed = parseDuration(duration);
    if (!parsed.ok) return err(parsed.error);
    const expiresAt = parsed.permanent ? undefined : Date.now() + parsed.minutes * 60 * 1000;
    Ignores.remove({ targetType: "thread", channelId: ctx.channel, threadTs: ctx.threadTs });
    Ignores.create({
      targetType: "thread",
      channelId: ctx.channel,
      threadTs: ctx.threadTs,
      createdBy: ctx.userId ?? "agent",
      expiresAt,
      reason,
    });
    return ok(`thread ignored ${parsed.permanent ? "permanently" : `for ${duration}`}`);
  },

  async unignoreThread(ctx: SlackContext): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId)) {
      return err("Only manager or approver can unignore threads.");
    }
    const removed = Ignores.remove({ targetType: "thread", channelId: ctx.channel, threadTs: ctx.threadTs });
    if (removed === 0) return ok("no active ignore for this thread");
    return ok("Thread ignore removed. Normal processing resumed.");
  },

  async ignoreUser(
    ctx: SlackContext,
    { userId, duration, reason }: { userId: string; duration: string; reason: string },
  ): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId)) {
      return err("Only manager or approver can ignore users.");
    }
    const parsed = parseDuration(duration);
    if (!parsed.ok) return err(parsed.error);
    const expiresAt = parsed.permanent ? undefined : Date.now() + parsed.minutes * 60 * 1000;
    Ignores.remove({ targetType: "user", userId });
    Ignores.create({
      targetType: "user",
      userId,
      createdBy: ctx.userId ?? "agent",
      expiresAt,
      reason,
    });
    return ok(`user <@${userId}> ignored ${parsed.permanent ? "permanently" : `for ${duration}`}`);
  },

  async unignoreUser(ctx: SlackContext, { userId }: { userId: string }): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId)) {
      return err("Only manager or approver can unignore users.");
    }
    const removed = Ignores.remove({ targetType: "user", userId });
    if (removed === 0) return ok(`no active ignore for user <@${userId}>`);
    return ok(`stopped ignoring <@${userId}>`);
  },

  async reloadSession(ctx: SlackContext): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId)) {
      return err("Only manager or approver can reload session.");
    }
    if (!ctx.reloadSession) {
      return err("reload not wired (transport bug)");
    }
    const ok_ = ctx.reloadSession();
    if (!ok_) return err("session not live — nothing to reload");
    return ok("Session reloaded. Next message will start fresh with newly-resolved MCPs, plugins, and skills.");
  },
};

/** Build an SDK MCP server bound to a session's SlackContext. */
export function createSlackMcp(ctx: SlackContext): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SLACK_MCP_NAME,
    version: "0.1.0",
    tools: [
      // DEPRECATED — interaction tools (reply/edit/react/unreact/request_approval/upload/
      // get_thread_history) moved to the platform-neutral `mcp__slaude_surface__*` server.
      // This `reply` alias remains for one release so in-flight sessions / personas that
      // reference the old name keep working. Remove next release.
      tool(
        "reply",
        "DEPRECATED — use mcp__slaude_surface__reply. Send a message to the user in the current conversation.",
        {
          text: z.string().describe("Message body. Markdown supported."),
        },
        (args) => slackHandlers.reply(ctx, args),
      ),

      tool(
        "get_user_profile",
        "Fetch a Slack user's profile. Use this to learn who you're talking to — their name, title, timezone, status, pronouns, etc. Pass a user ID (e.g. U123ABC). This helps you personalize responses and avoid asking info the profile already contains.",
        {
          user_id: z.string().describe("Slack user ID (e.g. U123ABC)."),
        },
        (args) => slackHandlers.get_user_profile(ctx, args),
      ),

      tool(
        "get_channel_info",
        "Get info about the current Slack channel or DM — name, topic, purpose, member count, creation date, and whether it's archived. Helps you understand the conversational context (e.g. is this #general, a private team channel, or a 1:1 DM?).",
        {},
        () => slackHandlers.get_channel_info(ctx),
      ),

      tool(
        "list_users_in_channel",
        "List the members of the current Slack channel. Use this to understand who's in the room, find user IDs to look up profiles, or check if a specific person is present. Returns user IDs — call get_user_profile to resolve names/details.",
        {
          limit: z.number().min(1).max(1000).optional().describe("Max members to fetch (1-1000). Default 200."),
        },
        (args) => slackHandlers.list_users_in_channel(ctx, args),
      ),

      tool(
        "search_messages",
        "Search Slack messages in the workspace. Use this to find prior discussions, decisions, or context the user is referencing. Supports Slack search syntax (e.g. 'from:@alice deploy', 'in:#engineering outage', 'after:2024-01-01'). Results are ordered by relevance.",
        {
          query: z.string().describe("Search query. Slack search syntax supported: from:@user, in:#channel, after:YYYY-MM-DD, before:YYYY-MM-DD, has:link, etc."),
          count: z.number().min(1).max(20).optional().describe("Max results (1-20). Default 10."),
        },
        (args) => slackHandlers.search_messages(ctx, args),
      ),

    ],
  });
}

export const RUNTIME_MCP_NAME = "slaude_runtime";

/** Build the surface-agnostic control-plane MCP server (`slaude_runtime`): ignore gates,
 *  cron jobs, KB ingest, session reload. These never produce user-visible output; they're
 *  housekeeping. Still ctx-bound today (cron/ignore use the conversation) — fuller
 *  neutralization is deferred with the gateway. */
export function createRuntimeMcp(ctx: SlackContext): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: RUNTIME_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool(
        "ignore_thread",
        "Temporarily ignore this thread when the conversation drifts out of mandate. Use to prevent infinite loops or unproductive back-and-forth. The thread will be silently dropped until the ignore expires or a manager removes it. Requires manager or approver authorization.",
        {
          duration: z
            .string()
            .describe("Duration like '5m', '10m', '1h'. Use 'permanent' only as absolute last resort. Max 24h."),
          reason: z.string().describe("Brief reason why the thread is being ignored."),
        },
        (args) => adminHandlers.ignoreThread(ctx, args),
      ),

      tool(
        "unignore_thread",
        "Resume normal processing in this thread after a previous ignore_thread call. Use when the conversation has returned to your mandate, the user explicitly asks to un-ignore, or you previously ignored by mistake. Requires manager or approver authorization.",
        {},
        () => adminHandlers.unignoreThread(ctx),
      ),

      tool(
        "ignore_user",
        "Temporarily ignore a specific user across all threads. Use when a user is repeatedly sending off-topic or disruptive messages. The user will be silently dropped until the ignore expires or a manager removes it. Requires manager or approver authorization.",
        {
          user_id: z.string().describe("User ID to ignore (e.g. U123ABC)."),
          duration: z.string().describe("Duration like '5m', '10m', '1h', or 'permanent'. Max 24h."),
          reason: z.string().describe("Brief reason why the user is being ignored."),
        },
        (args) => adminHandlers.ignoreUser(ctx, { userId: args.user_id, duration: args.duration, reason: args.reason }),
      ),

      tool(
        "unignore_user",
        "Stop ignoring a previously ignored user. Requires manager or approver authorization.",
        {
          user_id: z.string().describe("User ID to unignore (e.g. U123ABC)."),
        },
        (args) => adminHandlers.unignoreUser(ctx, { userId: args.user_id }),
      ),

      tool(
        "list_cron_jobs",
        "List all active scheduled cron jobs. Use when the user asks what recurring tasks are set up, wants to audit scheduled work, or needs a job ID before calling remove_cron_job. Returns job IDs, cron expressions, prompts, and next run times.",
        {},
        () => adminHandlers.listCronJobs(),
      ),

      tool(
        "add_cron_job",
        "Schedule a recurring prompt that fires on a cron expression and posts results to this thread. Use when the user asks for regular check-ins (e.g. 'daily summary'), weekly reports, recurring reminders, or periodic tasks. Requires manager or approver authorization. Use 5-field cron format: minute hour day-of-month month day-of-week (UTC). Examples: '0 9 * * 1-5' = weekdays at 9am UTC; '0 0 * * *' = daily midnight; '*/30 * * * *' = every 30 minutes.",
        {
          cron_expr: z.string().describe("5-field cron expression in UTC. e.g. '0 9 * * 1-5' for weekdays at 9am."),
          prompt: z.string().describe("The prompt sent to you each time the job fires. Be specific so future you knows what to do."),
        },
        (args) => adminHandlers.addCronJob(ctx, { cronExpr: args.cron_expr, prompt: args.prompt }),
      ),

      tool(
        "remove_cron_job",
        "Deactivate a scheduled cron job by its full ID or 8-char prefix. The job is soft-deleted (set inactive) — historical runs remain in the database. Use when a recurring task is no longer needed, the user asks to cancel something scheduled, or a job was created by mistake. Call list_cron_jobs first to find the ID. Requires manager or approver authorization.",
        {
          job_id: z.string().describe("Full job ID or 8-character prefix from list_cron_jobs."),
        },
        (args) => adminHandlers.removeCronJob(ctx, { jobId: args.job_id }),
      ),

      tool(
        "trigger_ingest",
        "Synchronize raw knowledge-base content into the processed wiki format. Use when new raw files have been added to the KB and the user asks to refresh, rebuild, or update the knowledge base. This can be slow — only trigger when actually needed. Requires manager or approver authorization.",
        {},
        () => adminHandlers.triggerIngest(ctx),
      ),

      tool(
        "reload_session",
        "Gracefully reload the current session so newly installed MCP servers, plugins, or skills are picked up on the next turn. Closes the SDK loop cleanly (no scary error messages) and marks the session idle. The next inbound message starts a fresh Query with freshly-resolved MCPs, plugins, and skills. Requires manager or approver authorization.",
        {},
        () => adminHandlers.reloadSession(ctx),
      ),
    ],
  });
}
