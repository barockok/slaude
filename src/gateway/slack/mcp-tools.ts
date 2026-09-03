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
import { soulData, effectiveSoulForChannel } from "../../soul/extract";
import * as Ignores from "../../db/ignores";
import * as CronJobs from "../../db/cron-jobs";
import * as OneOnOne from "../../db/one-on-one";
import { getNextRun } from "./cron-parser";
import { run as runIngest } from "../../knowledge/ingest";
import { slackContract } from "../../tools/contracts/slack";
import { runtimeContract } from "../../tools/contracts/runtime";
import { connectContract } from "../../tools/contracts/connect";

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
  reloadSession?: (prompt?: string) => boolean;
  /** Which persona owns this session. 'default' = single-bot mode. */
  personaId?: string;
  /** Session id, when known — used by the control panel to key outbound Slack
   *  suppression while an operator drives the session. */
  sessionId?: string;
};

export const SLACK_MCP_NAME = slackContract.server;

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

  async post_message(
    ctx: SlackContext,
    { channel, text, thread_ts, broadcast }: { channel: string; text: string; thread_ts?: string; broadcast?: boolean },
  ): Promise<ToolResult> {
    try {
      const replyOpts = thread_ts ? (broadcast ? { thread_ts, reply_broadcast: true as const } : { thread_ts }) : {};
      const r = await ctx.client.chat.postMessage({
        channel,
        text: format(text),
        mrkdwn: true,
        ...replyOpts,
      });
      return ok(`posted channel=${r.channel} ts=${r.ts}`);
    } catch (e: any) {
      return err(`slack chat.postMessage failed: ${e?.data?.error ?? e?.message ?? String(e)}`);
    }
  },

  async delete(ctx: SlackContext, { ts, channel }: { ts: string; channel?: string }): Promise<ToolResult> {
    try {
      await ctx.client.chat.delete({ channel: channel ?? ctx.channel, ts });
      return ok("deleted");
    } catch (e: any) {
      return err(`slack chat.delete failed: ${e?.data?.error ?? e?.message ?? String(e)}`);
    }
  },

  async post_ephemeral(
    ctx: SlackContext,
    { user, text, channel, thread_ts }: { user: string; text: string; channel?: string; thread_ts?: string },
  ): Promise<ToolResult> {
    try {
      const r = await ctx.client.chat.postEphemeral({
        channel: channel ?? ctx.channel,
        user,
        thread_ts,
        text: format(text),
      });
      return ok(`posted ephemeral ts=${r.message_ts ?? ""}`);
    } catch (e: any) {
      return err(`slack chat.postEphemeral failed: ${e?.data?.error ?? e?.message ?? String(e)}`);
    }
  },

  async pin(ctx: SlackContext, { ts, channel }: { ts: string; channel?: string }): Promise<ToolResult> {
    try {
      await ctx.client.pins.add({ channel: channel ?? ctx.channel, timestamp: ts });
      return ok("pinned");
    } catch (e: any) {
      const msg = e?.data?.error ?? e?.message ?? String(e);
      if (msg === "already_pinned") return ok("already pinned");
      return err(`slack pins.add failed: ${msg}`);
    }
  },

  async unpin(ctx: SlackContext, { ts, channel }: { ts: string; channel?: string }): Promise<ToolResult> {
    try {
      await ctx.client.pins.remove({ channel: channel ?? ctx.channel, timestamp: ts });
      return ok("unpinned");
    } catch (e: any) {
      return err(`slack pins.remove failed: ${e?.data?.error ?? e?.message ?? String(e)}`);
    }
  },

  async set_topic(ctx: SlackContext, { topic, channel }: { topic: string; channel?: string }): Promise<ToolResult> {
    try {
      await ctx.client.conversations.setTopic({ channel: channel ?? ctx.channel, topic });
      return ok("topic set");
    } catch (e: any) {
      return err(`slack conversations.setTopic failed: ${e?.data?.error ?? e?.message ?? String(e)}`);
    }
  },

  async set_purpose(ctx: SlackContext, { purpose, channel }: { purpose: string; channel?: string }): Promise<ToolResult> {
    try {
      await ctx.client.conversations.setPurpose({ channel: channel ?? ctx.channel, purpose });
      return ok("purpose set");
    } catch (e: any) {
      return err(`slack conversations.setPurpose failed: ${e?.data?.error ?? e?.message ?? String(e)}`);
    }
  },

  async create_canvas(
    ctx: SlackContext,
    { markdown, title, channel }: { markdown: string; title?: string; channel?: string },
  ): Promise<ToolResult> {
    try {
      const r = await ctx.client.conversations.canvases.create({
        channel_id: channel ?? ctx.channel,
        title,
        document_content: { type: "markdown", markdown },
      });
      return ok(`canvas created canvas_id=${r.canvas_id}`);
    } catch (e: any) {
      return err(`slack conversations.canvases.create failed: ${e?.data?.error ?? e?.message ?? String(e)}`);
    }
  },

  async append_canvas(ctx: SlackContext, { markdown, channel }: { markdown: string; channel?: string }): Promise<ToolResult> {
    return editCanvasEnd(ctx, channel, markdown, "insert_at_end");
  },

  async prepend_canvas(ctx: SlackContext, { markdown, channel }: { markdown: string; channel?: string }): Promise<ToolResult> {
    return editCanvasEnd(ctx, channel, markdown, "insert_at_start");
  },

  async read_canvas(ctx: SlackContext, { channel }: { channel?: string }): Promise<ToolResult> {
    try {
      const canvasId = await getCanvasId(ctx, channel);
      if (typeof canvasId !== "string") return canvasId;
      const info = await ctx.client.files.info({ file: canvasId });
      const url = (info.file as any)?.url_private_download;
      if (!url) return err("canvas has no downloadable content yet (empty canvas?)");
      const res = await fetch(url, { headers: { Authorization: `Bearer ${ctx.client.token}` } });
      if (!res.ok) return err(`canvas download failed: HTTP ${res.status}`);
      return ok(await res.text());
    } catch (e: any) {
      return err(`slack read_canvas failed: ${e?.data?.error ?? e?.message ?? String(e)}`);
    }
  },
};

/** Resolve the channel's Canvas id via its file_id (canvas_id and file_id share
 *  a namespace for channel canvases). Returns a ToolResult error if none exists. */
async function getCanvasId(ctx: SlackContext, channel?: string): Promise<string | ToolResult> {
  const r = await ctx.client.conversations.info({ channel: channel ?? ctx.channel });
  const canvasId = ((r.channel as any)?.properties?.canvas?.file_id) as string | undefined;
  if (!canvasId) return err("this channel has no Canvas yet — create one with create_canvas first");
  return canvasId;
}

async function editCanvasEnd(
  ctx: SlackContext,
  channel: string | undefined,
  markdown: string,
  operation: "insert_at_start" | "insert_at_end",
): Promise<ToolResult> {
  try {
    const canvasId = await getCanvasId(ctx, channel);
    if (typeof canvasId !== "string") return canvasId;
    await ctx.client.canvases.edit({
      canvas_id: canvasId,
      changes: [{ operation, document_content: { type: "markdown", markdown } }],
    });
    return ok(`canvas ${operation === "insert_at_end" ? "appended" : "prepended"}`);
  } catch (e: any) {
    return err(`slack canvases.edit failed: ${e?.data?.error ?? e?.message ?? String(e)}`);
  }
}

/** Check whether the current turn's user is manager or approver. When a
 *  channel id is given, approvers are resolved per-channel (a `## Channel`
 *  override replaces the global approver set there); manager/backup are
 *  always honored regardless of channel. */
function isManagerOrApprover(userId?: string, channelId?: string): boolean {
  if (!userId) return false;
  const soul = channelId ? effectiveSoulForChannel(channelId) : soulData();
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

function cronJobLine(j: CronJobs.CronJob): string {
  const flags = [
    j.target,
    j.whenActive === "skip" ? "passive" : null,
    j.paused ? "paused" : null,
  ].filter(Boolean).join(", ");
  return `• \`${j.id.slice(0, 8)}\` \`${j.cronExpr}\` [${flags}] → ${j.prompt} (next: ${new Date(j.nextRunAt).toISOString()})`;
}

async function findCronJob(jobId: string): Promise<CronJobs.CronJob | ToolResult> {
  try {
    const job = await CronJobs.findByPrefix(jobId);
    if (!job) return err(`Job \`${jobId}\` not found.`);
    return job;
  } catch (e: any) {
    return err(e.message);
  }
}

/** Cron / ingest handlers — exposed as MCP tools so the agent can manage
 *  scheduled work and knowledge base directly. */
export const adminHandlers = {
  async listCronJobs(ctx: SlackContext): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId, ctx.channel)) {
      return err("Only manager or approver can list cron jobs.");
    }
    const jobs = await CronJobs.listActive();
    if (!jobs.length) return ok("No active cron jobs.");
    const lines = jobs.map(cronJobLine);
    return ok("*Active cron jobs*\n" + lines.join("\n"));
  },

  async addCronJob(
    ctx: SlackContext,
    { cronExpr, prompt, target, whenActive }: { cronExpr: string; prompt: string; target?: "thread" | "channel"; whenActive?: "fire" | "skip" },
  ): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId, ctx.channel)) {
      return err("Only manager or approver can add cron jobs.");
    }
    let nextRun: number;
    try {
      nextRun = getNextRun(cronExpr);
    } catch (e: any) {
      return err(`Invalid cron expression: ${e.message}`);
    }
    const cronLock = ctx.channel && ctx.threadTs ? await OneOnOne.find(ctx.channel, ctx.threadTs) : null;
    const job = await CronJobs.create({
      slackTeamId: ctx.teamId,
      slackChannelId: ctx.channel,
      slackThreadTs: ctx.threadTs,
      channelId: ctx.channel,
      threadTs: ctx.threadTs,
      createdBy: ctx.userId ?? "agent",
      cronExpr,
      prompt,
      nextRunAt: nextRun,
      target,
      whenActive,
      oauthUser: cronLock?.locked_user ?? undefined,
      // Persist the owning persona so the run fires as that persona (soul + brain
      // + config dir), not the default bot. Undefined/'default' → single-bot.
      personaId: ctx.personaId,
    });
    return ok(
      `Cron job created (\`${job.id.slice(0, 8)}\`) [${job.target}, when_active=${job.whenActive}]. Next run: ${new Date(nextRun).toISOString()}`,
    );
  },

  async editCronJob(
    ctx: SlackContext,
    { jobId, cronExpr, prompt, target, whenActive }: { jobId: string; cronExpr?: string; prompt?: string; target?: "thread" | "channel"; whenActive?: "fire" | "skip" },
  ): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId)) {
      return err("Only manager or approver can edit cron jobs.");
    }
    const job = await findCronJob(jobId);
    if ("content" in job) return job;
    if (cronExpr === undefined && prompt === undefined && target === undefined && whenActive === undefined) {
      return err("No cron fields provided to edit.");
    }
    let nextRunAt: number | undefined;
    if (cronExpr !== undefined) {
      try {
        nextRunAt = getNextRun(cronExpr);
      } catch (e: any) {
        return err(`Invalid cron expression: ${e.message}`);
      }
    }
    await CronJobs.update(job.id, { cronExpr, prompt, nextRunAt, target, whenActive });
    const updated = (await CronJobs.findById(job.id))!;
    return ok(`Cron job \`${updated.id.slice(0, 8)}\` updated. Next run: ${new Date(updated.nextRunAt).toISOString()}`);
  },

  async pauseCronJob(ctx: SlackContext, { jobId }: { jobId: string }): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId)) {
      return err("Only manager or approver can pause cron jobs.");
    }
    const job = await findCronJob(jobId);
    if ("content" in job) return job;
    await CronJobs.pause(job.id);
    return ok(`Cron job \`${job.id.slice(0, 8)}\` paused.`);
  },

  async resumeCronJob(ctx: SlackContext, { jobId }: { jobId: string }): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId)) {
      return err("Only manager or approver can resume cron jobs.");
    }
    const job = await findCronJob(jobId);
    if ("content" in job) return job;
    let nextRun: number;
    try {
      nextRun = getNextRun(job.cronExpr);
    } catch (e: any) {
      return err(`Invalid stored cron expression: ${e.message}`);
    }
    await CronJobs.resume(job.id, nextRun);
    return ok(`Cron job \`${job.id.slice(0, 8)}\` resumed. Next run: ${new Date(nextRun).toISOString()}`);
  },

  async removeCronJob(_ctx: SlackContext, { jobId }: { jobId: string }): Promise<ToolResult> {
    if (!isManagerOrApprover(_ctx.userId, _ctx.channel)) {
      return err("Only manager or approver can remove cron jobs.");
    }
    const job = await findCronJob(jobId);
    if ("content" in job) return job;
    await CronJobs.deactivate(job.id);
    return ok(`Cron job \`${job.id.slice(0, 8)}\` deactivated.`);
  },

  async triggerIngest(ctx: SlackContext): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId, ctx.channel)) {
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
    if (!isManagerOrApprover(ctx.userId, ctx.channel)) {
      return err("Only manager or approver can ignore threads.");
    }
    const parsed = parseDuration(duration);
    if (!parsed.ok) return err(parsed.error);
    const expiresAt = parsed.permanent ? undefined : Date.now() + parsed.minutes * 60 * 1000;
    await Ignores.remove({ targetType: "thread", channelId: ctx.channel, threadTs: ctx.threadTs });
    await Ignores.create({
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
    if (!isManagerOrApprover(ctx.userId, ctx.channel)) {
      return err("Only manager or approver can unignore threads.");
    }
    const removed = await Ignores.remove({ targetType: "thread", channelId: ctx.channel, threadTs: ctx.threadTs });
    if (removed === 0) return ok("no active ignore for this thread");
    return ok("Thread ignore removed. Normal processing resumed.");
  },

  async ignoreUser(
    ctx: SlackContext,
    { userId, duration, reason }: { userId: string; duration: string; reason: string },
  ): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId, ctx.channel)) {
      return err("Only manager or approver can ignore users.");
    }
    const parsed = parseDuration(duration);
    if (!parsed.ok) return err(parsed.error);
    const expiresAt = parsed.permanent ? undefined : Date.now() + parsed.minutes * 60 * 1000;
    await Ignores.remove({ targetType: "user", userId });
    await Ignores.create({
      targetType: "user",
      userId,
      createdBy: ctx.userId ?? "agent",
      expiresAt,
      reason,
    });
    return ok(`user <@${userId}> ignored ${parsed.permanent ? "permanently" : `for ${duration}`}`);
  },

  async unignoreUser(ctx: SlackContext, { userId }: { userId: string }): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId, ctx.channel)) {
      return err("Only manager or approver can unignore users.");
    }
    const removed = await Ignores.remove({ targetType: "user", userId });
    if (removed === 0) return ok(`no active ignore for user <@${userId}>`);
    return ok(`stopped ignoring <@${userId}>`);
  },

  async reloadSession(ctx: SlackContext, { prompt }: { prompt?: string }): Promise<ToolResult> {
    if (!isManagerOrApprover(ctx.userId, ctx.channel)) {
      return err("Only manager or approver can reload session.");
    }
    if (!ctx.reloadSession) {
      return err("reload not wired (transport bug)");
    }
    const ok_ = ctx.reloadSession(prompt);
    if (!ok_) return err("session not live — nothing to reload");
    return prompt
      ? ok("Session reloaded. Prompt will be injected automatically on the fresh session.")
      : ok("Session reloaded. Next message will start fresh with newly-resolved MCPs, plugins, and skills.");
  },
};

/** Build an SDK MCP server bound to a session's SlackContext. Tool names,
 *  descriptions and schemas come from the shared contract (src/tools/contracts). */
export function createSlackMcp(ctx: SlackContext): McpSdkServerConfigWithInstance {
  const c = slackContract.tools;
  return createSdkMcpServer({
    name: SLACK_MCP_NAME,
    version: "0.1.0",
    tools: [
      // DEPRECATED — interaction tools (reply/edit/react/unreact/request_approval/upload/
      // get_thread_history) moved to the platform-neutral `mcp__slaude_surface__*` server.
      // This `reply` alias remains for one release so in-flight sessions / personas that
      // reference the old name keep working. Remove next release.
      tool(c.reply.name, c.reply.description, c.reply.schema, (args) => slackHandlers.reply(ctx, args)),
      tool(c.get_user_profile.name, c.get_user_profile.description, c.get_user_profile.schema, (args) => slackHandlers.get_user_profile(ctx, args)),
      tool(c.get_channel_info.name, c.get_channel_info.description, c.get_channel_info.schema, () => slackHandlers.get_channel_info(ctx)),
      tool(c.list_users_in_channel.name, c.list_users_in_channel.description, c.list_users_in_channel.schema, (args) => slackHandlers.list_users_in_channel(ctx, args)),
      tool(c.search_messages.name, c.search_messages.description, c.search_messages.schema, (args) => slackHandlers.search_messages(ctx, args)),
      tool(c.post_message.name, c.post_message.description, c.post_message.schema, (args) => slackHandlers.post_message(ctx, args)),
      tool(c.delete.name, c.delete.description, c.delete.schema, (args) => slackHandlers.delete(ctx, args)),
      tool(c.post_ephemeral.name, c.post_ephemeral.description, c.post_ephemeral.schema, (args) => slackHandlers.post_ephemeral(ctx, args)),
      tool(c.pin.name, c.pin.description, c.pin.schema, (args) => slackHandlers.pin(ctx, args)),
      tool(c.unpin.name, c.unpin.description, c.unpin.schema, (args) => slackHandlers.unpin(ctx, args)),
      tool(c.set_topic.name, c.set_topic.description, c.set_topic.schema, (args) => slackHandlers.set_topic(ctx, args)),
      tool(c.set_purpose.name, c.set_purpose.description, c.set_purpose.schema, (args) => slackHandlers.set_purpose(ctx, args)),
      tool(c.create_canvas.name, c.create_canvas.description, c.create_canvas.schema, (args) => slackHandlers.create_canvas(ctx, args)),
      tool(c.append_canvas.name, c.append_canvas.description, c.append_canvas.schema, (args) => slackHandlers.append_canvas(ctx, args)),
      tool(c.prepend_canvas.name, c.prepend_canvas.description, c.prepend_canvas.schema, (args) => slackHandlers.prepend_canvas(ctx, args)),
      tool(c.read_canvas.name, c.read_canvas.description, c.read_canvas.schema, (args) => slackHandlers.read_canvas(ctx, args)),
    ],
  });
}

export const RUNTIME_MCP_NAME = runtimeContract.server;

/** Build the surface-agnostic control-plane MCP server (`slaude_runtime`): ignore gates,
 *  cron jobs, KB ingest, session reload. These never produce user-visible output; they're
 *  housekeeping. Still ctx-bound today (cron/ignore use the conversation) — fuller
 *  neutralization is deferred with the gateway. Tool names, descriptions and schemas
 *  come from the shared contract (src/tools/contracts). */
export function createRuntimeMcp(ctx: SlackContext): McpSdkServerConfigWithInstance {
  const c = runtimeContract.tools;
  return createSdkMcpServer({
    name: RUNTIME_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool(c.ignore_thread.name, c.ignore_thread.description, c.ignore_thread.schema,
        (args) => adminHandlers.ignoreThread(ctx, args)),
      tool(c.unignore_thread.name, c.unignore_thread.description, c.unignore_thread.schema,
        () => adminHandlers.unignoreThread(ctx)),
      tool(c.ignore_user.name, c.ignore_user.description, c.ignore_user.schema,
        (args) => adminHandlers.ignoreUser(ctx, { userId: args.user_id, duration: args.duration, reason: args.reason })),
      tool(c.unignore_user.name, c.unignore_user.description, c.unignore_user.schema,
        (args) => adminHandlers.unignoreUser(ctx, { userId: args.user_id })),
      tool(c.list_cron_jobs.name, c.list_cron_jobs.description, c.list_cron_jobs.schema,
        () => adminHandlers.listCronJobs(ctx)),
      tool(c.add_cron_job.name, c.add_cron_job.description, c.add_cron_job.schema,
        (args) => adminHandlers.addCronJob(ctx, { cronExpr: args.cron_expr, prompt: args.prompt, target: args.target, whenActive: args.when_active })),
      tool(c.edit_cron_job.name, c.edit_cron_job.description, c.edit_cron_job.schema,
        (args) => adminHandlers.editCronJob(ctx, { jobId: args.job_id, cronExpr: args.cron_expr, prompt: args.prompt, target: args.target, whenActive: args.when_active })),
      tool(c.pause_cron_job.name, c.pause_cron_job.description, c.pause_cron_job.schema,
        (args) => adminHandlers.pauseCronJob(ctx, { jobId: args.job_id })),
      tool(c.resume_cron_job.name, c.resume_cron_job.description, c.resume_cron_job.schema,
        (args) => adminHandlers.resumeCronJob(ctx, { jobId: args.job_id })),
      tool(c.remove_cron_job.name, c.remove_cron_job.description, c.remove_cron_job.schema,
        (args) => adminHandlers.removeCronJob(ctx, { jobId: args.job_id })),
      tool(c.trigger_ingest.name, c.trigger_ingest.description, c.trigger_ingest.schema,
        () => adminHandlers.triggerIngest(ctx)),
      tool(c.reload_session.name, c.reload_session.description, c.reload_session.schema,
        (args) => adminHandlers.reloadSession(ctx, args)),
    ],
  });
}

export const CONNECT_MCP_NAME = connectContract.server;

export interface ConnectDeps {
  /** Kick off the deterministic connect engine for `server` and return a short
   *  status line for the agent — never the authorize URL (that's posted out-of-band
   *  by the gateway). The agent decides *when*; the engine owns *how*. */
  connect: (server: string) => Promise<string>;
}

/** The natural-language front door to MCP OAuth connect. The agent calls this when a
 *  user asks to connect/authorize a service; it routes into the same gateway engine as
 *  `/mcp connect` (loopback + signed-state + URL-safe out-of-band post + redact teardown).
 *  The authorize URL never passes through the model, and no paste is needed. */
export function connectTools(deps: ConnectDeps) {
  const c = connectContract.tools;
  return [
    tool(c.connect_mcp.name, c.connect_mcp.description, c.connect_mcp.schema,
      async (args) => ok(await deps.connect(args.server))),
  ];
}

export function createConnectMcp(deps: ConnectDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: CONNECT_MCP_NAME, version: "0.1.0", tools: connectTools(deps) });
}

