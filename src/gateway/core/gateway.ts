import type { AgentManager, AgentEvent } from "../../agent/manager";
import { env } from "../../config/env";
import { m as metric } from "../../metrics";
import {
  discoverSkills,
  matchSkillInvocation,
  buildSkillInvocation,
} from "../../skills/loader";
import { ReactionTracker } from "../slack/reactions";
import { Presence } from "../slack/presence";
import { Status } from "../slack/status";
import { PermissionGate } from "../slack/permission-gate";
import { ApprovalGate } from "../slack/approval-gate";
import { IgnoreGate } from "../slack/ignore-gate";
import { parseSlashCommand, helpText, humanModeName, MODE_LABELS } from "../slack/commands";
import { soulData } from "../../soul/extract";
import { createSlackMcp, SLACK_MCP_NAME, createRuntimeMcp, RUNTIME_MCP_NAME, type SlackContext, parseDuration } from "../slack/mcp-tools";
import { makeSlackSurfaceFactory } from "../slack/surface";
import { createSurfaceMcp, SURFACE_MCP_NAME } from "./surface-mcp";
import type { Surface, SurfaceFactory, SessionBinding } from "./surface";
import { createSkillsMcp, SKILLS_MCP_NAME } from "../../skills/mcp-tools";
import { createSessionMcp, SESSION_MCP_NAME } from "../../agent/session-mcp";
import { createKbMcp, KB_MCP_NAME } from "../../knowledge/mcp-tools";
import { loadEncryptionKey } from "../../config/env";
import { createBroker } from "../../agent/connect-broker/index";
import { createConnectMcp, CONNECT_MCP_NAME, type BrokerToolCtx } from "../../agent/connect-broker/broker-mcp";
import { buildApprovalRequester } from "../slack/connect-wiring";
import { resolveUserName } from "../slack/users";
import { downloadAttachments, type SlackFile } from "../slack/attachments";
import * as Sessions from "../../db/sessions";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../config/home";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { canTriggerIngest } from "../slack/ingest-auth";
import * as kbIngest from "../../knowledge/ingest";
import * as Ignores from "../../db/ignores";
import * as CronJobs from "../../db/cron-jobs";
import * as OneOnOne from "../../db/one-on-one";
import { CronScheduler } from "../slack/cron-scheduler";
import { getNextRun } from "../slack/cron-parser";
import type { Transport } from "./transport";

export interface SessionMcpCtx { slack: SlackContext; surface: Surface; connect?: BrokerToolCtx }
export interface GatewayHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** TEST/SIM SEAM ONLY. Live per-session MCP contexts built by the resolver.
   *  Undefined until the session's resolver has run. Production never calls this. */
  __sessionCtx(sessionId: string): SessionMcpCtx | undefined;
}

function loadExternalMcp(): Record<string, McpServerConfig> {
  const f = join(paths.home, ".mcp.json");
  if (!existsSync(f)) return {};
  const expand = (s: string) =>
    s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? "");
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8"));
    const servers = parsed?.mcpServers ?? {};
    // Expand ${VAR} placeholders from process.env across stdio + http/sse fields.
    for (const cfg of Object.values<any>(servers)) {
      if (cfg?.env && typeof cfg.env === "object") {
        for (const [k, v] of Object.entries<any>(cfg.env)) {
          if (typeof v === "string") cfg.env[k] = expand(v);
        }
      }
      if (cfg?.headers && typeof cfg.headers === "object") {
        for (const [k, v] of Object.entries<any>(cfg.headers)) {
          if (typeof v === "string") cfg.headers[k] = expand(v);
        }
      }
      if (typeof cfg?.url === "string") cfg.url = expand(cfg.url);
      if (Array.isArray(cfg?.args)) {
        cfg.args = cfg.args.map((a: unknown) => (typeof a === "string" ? expand(a) : a));
      }
    }
    return servers;
  } catch (err) {
    console.error(`[mcp] failed to load ${f}:`, err);
    return {};
  }
}

const REACT_RECEIVED = "eyes";
const REACT_WORKING = "gear";
const REACT_DONE = "white_check_mark";
const REACT_ERROR = "x";

const STATUS_THINKING = { text: "thinking", emoji: ":thought_balloon:" };

type SessionRoute = {
  ctx: SlackContext;
  /** The interaction Surface for this session. Built once; reads ctx live (getters). */
  surface: Surface;
  /** Whether the agent has emitted user-visible output this turn (surface reply/edit/upload). */
  spoke: boolean;
};

export interface GatewayOptions {
  /** Override how a Surface is built per session. Defaults to a SlackSurface over the
   *  transport client — the extension seam for future surfaces. */
  surfaceFactory?: SurfaceFactory;
}

/** A live SessionBinding view over the mutated-in-place SlackContext, so the Surface always
 *  reads the current turn's conversation/inbound/user (the gateway mutates ctx across turns). */
function bindingFor(ctx: SlackContext): SessionBinding {
  return {
    get conversationId() { return ctx.channel; },
    get threadRef() { return ctx.threadTs; },
    get inboundRef() { return ctx.inboundTs; },
    get userId() { return ctx.userId; },
    get teamId() { return ctx.teamId; },
    requestApproval: (r) => ctx.requestApproval!(r),
    reloadSession: () => ctx.reloadSession?.() ?? false,
  };
}

export function createGateway(agent: AgentManager, t: Transport, opts: GatewayOptions = {}): GatewayHandle {

  const surfaceFactory: SurfaceFactory = opts.surfaceFactory ?? makeSlackSurfaceFactory(t.client as any);

  const reactions = new ReactionTracker(t.client);
  const presence = new Presence(t.client as any);
  const status = new Status(t.client);
  const permissions = new PermissionGate(t);
  const approvals = new ApprovalGate(t, env.slack.approvers(), {
    timeoutSeconds: () => soulData().approvalTimeoutSeconds,
  });
  const ignoreGate = new IgnoreGate();
  // Clean up expired ignores every 5 minutes
  setInterval(() => {
    import("../../db/ignores").then((m) => m.cleanupExpired());
  }, 5 * 60 * 1000);

  // Contextual MCP connections broker (`slaude_connect`). OFF by default — gated
  // behind SLAUDE_ENABLE_CONNECT_BROKER (explicit switch, decoupled from the
  // encryption key) so a default deployment exposes no connection tools; `/1on1`
  // mode is the shipped per-thread feature. Enabling requires BOTH the flag AND
  // SLAUDE_ENCRYPTION_KEY. spawnChild / postConnectUrl are deploy-time seams.
  const connectBroker = (() => {
    if (!env.enableConnectBroker()) {
      console.log("[connect-broker] disabled (set SLAUDE_ENABLE_CONNECT_BROKER=1 to enable)");
      return null;
    }
    let key: Buffer;
    try {
      key = loadEncryptionKey();
    } catch (e) {
      console.log(`[connect-broker] disabled: ${(e as Error).message}`);
      return null;
    }
    const requestApproval = buildApprovalRequester(approvals);
    return createBroker({
      key,
      idleMs: 5 * 60_000,
      spawnChild: () => {
        throw new Error("connect-broker: vendor MCP child spawn is wired at deploy time (CDP login host)");
      },
      requestApproval,
      isMember: () => true, // MVP: Slack delivered the event => caller is in the channel.
    });
  })();
  const cronScheduler = new CronScheduler({
    agent,
    client: t.client as any,
    onExecute: (job, sessionId) => {
      // Register a route so cron sessions get Slack MCP tools + event handling.
      const ctx: SlackContext = {
        client: t.client as any,
        channel: job.slackChannelId!,
        threadTs: job.slackThreadTs ?? job.channelId,
        inboundTs: String(Date.now()), // synthetic — no real inbound msg for cron
        userId: job.createdBy,
        teamId: job.slackTeamId ?? undefined,
      };
      ctx.requestApproval = (req) =>
        approvals.request({
          channel: ctx.channel,
          threadTs: ctx.threadTs,
          ...req,
        });
      ctx.reloadSession = () => agent.reload(sessionId);
      routes.set(sessionId, { ctx, surface: surfaceFactory(bindingFor(ctx)), spoke: false });
    },
  });
  cronScheduler.start();
  agent.setPermissionResolver(permissions.resolver);

  // Diag: dump bot identity + granted scopes once at startup.
  void (async () => {
    try {
      const res = await t.client.auth.test();
      const scopesHeader = (res as any).response_metadata?.scopes ?? (res as any).headers?.["x-oauth-scopes"];
      console.log(`[slack-auth] team=${(res as any).team} user=${(res as any).user} bot_id=${(res as any).bot_id} url=${(res as any).url}`);
      console.log(`[slack-auth] scopes=${scopesHeader ?? "(unknown — check app OAuth page)"}`);
    } catch (e: any) {
      console.error("[slack-auth] auth.test failed:", e?.data?.error ?? e?.message);
    }
  })();

  // Per-session route + slack context. Mutated on each new inbound user message.
  const routes = new Map<string, SessionRoute>();
  const sessionCtx = new Map<string, SessionMcpCtx>();
  // Dedup events by (channel, ts).
  const seenEvents = new Set<string>();

  // MCP resolver — first-call-per-session wires the slack MCP server bound to
  // the session's SlackContext object. We mutate fields on the same context
  // object across turns so the SDK MCP server stays valid for the session.
  // External MCPs are configured via ~/.claude/mcp.json or .mcp.json in the
  // working dir — claude-code picks them up natively and merges them.
  const externalMcp = loadExternalMcp();
  if (Object.keys(externalMcp).length) {
    console.log(`[mcp] loaded external servers: ${Object.keys(externalMcp).join(", ")}`);
  }
  // Stop-hook enforcement: if a turn ends without any user-visible Slack tool
  // (reply / edit / upload), block the stop once with an instruction that
  // forces the agent to call `mcp__slaude_slack__reply` before exiting.
  agent.setStopGuard((sessionId) => {
    const route = routes.get(sessionId);
    if (!route) return null;
    if (route.spoke) return null;
    return "You have not delivered a reply to the user. Call `mcp__slaude_surface__reply` now with your answer to the inbound message, then stop. Do not stop without replying.";
  });

  agent.setMcpResolver((sessionId) => {
    const route = routes.get(sessionId);
    if (!route) return undefined;
    const servers: Record<string, McpServerConfig> = {
      [SURFACE_MCP_NAME]: createSurfaceMcp(route.surface),
      [RUNTIME_MCP_NAME]: createRuntimeMcp(route.ctx),
      [SLACK_MCP_NAME]: createSlackMcp(route.ctx),
      [SKILLS_MCP_NAME]: createSkillsMcp(),
      [SESSION_MCP_NAME]: createSessionMcp({
        getSnapshot: () => agent.getTokenSnapshot(sessionId),
      }),
      [KB_MCP_NAME]: createKbMcp(),
      ...externalMcp,
    };
    // Mount the per-user connections broker when enabled and the thread is
    // fully keyed (team + channel + thread). Caller identity is bound in-band
    // via on_behalf_of (B1) — the agent must pass route.ctx.userId.
    let connectCtx: BrokerToolCtx | undefined;
    if (connectBroker && route.ctx.teamId && route.ctx.userId) {
      connectCtx = connectBroker.buildCtx({
        // Live read: route.ctx.userId is mutated per inbound turn (see the
        // per-message update below). The resolver runs once at session boot,
        // so a snapshot here would freeze auth to the booting user.
        getCallerUserId: () => route.ctx.userId ?? "unknown",
        thread: { team_id: route.ctx.teamId, channel_id: route.ctx.channel, thread_ts: route.ctx.threadTs },
        postConnectUrl: async (_service) => ({
          // Deploy-time seam: the CDP login host returns a one-time live-view URL.
          url: "(login host not configured in this build)",
          expiresInMs: 0,
        }),
      });
      servers[CONNECT_MCP_NAME] = createConnectMcp(connectCtx);
    }
    sessionCtx.set(sessionId, { slack: route.ctx, surface: route.surface, connect: connectCtx });
    return servers;
  });

  agent.on("event", (e: AgentEvent) => {
    console.log(`[agent-evt] ${e.type} session=${e.sessionId}${"tool" in e ? ` tool=${e.tool}` : ""}${"error" in e ? ` err=${e.error}` : ""}`);
    const route = routes.get(e.sessionId);
    if (!route) return;

    switch (e.type) {
      case "toolCall": {
        // Any user-visible tool counts as "spoke" — reply, edit, upload all
        // surface content. (react alone doesn't satisfy: an emoji isn't a real
        // answer.) Matches the canonical surface namespace + the deprecated
        // slack namespace during the transition.
        const userVisible =
          e.tool === `mcp__${SURFACE_MCP_NAME}__reply` ||
          e.tool === `mcp__${SURFACE_MCP_NAME}__edit` ||
          e.tool === `mcp__${SURFACE_MCP_NAME}__upload` ||
          e.tool === `mcp__${SLACK_MCP_NAME}__reply` ||
          e.tool === `mcp__${SLACK_MCP_NAME}__edit` ||
          e.tool === `mcp__${SLACK_MCP_NAME}__upload`;
        if (userVisible) {
          route.spoke = true;
          void reactions.set(e.sessionId, route.ctx.channel, route.ctx.inboundTs, REACT_WORKING);
        } else {
          // Animated humanized status next to the bot name.
          void status.set(
            e.sessionId,
            route.ctx.channel,
            route.ctx.threadTs,
            humanizeToolStatus(e.tool, e.input as any),
          );
        }
        break;
      }
      case "done": {
        void (async () => {
          // Auto-evolve turns are internal — don't reset reactions/presence
          // (they were already finalized on the user-visible turn's done).
          if (e.autoEvolve) return;
          // No fallback notice: setStopGuard above forces a reply via the SDK
          // Stop hook. If the agent still stops without spoke, manager logs
          // to stderr — surfacing a Slack message here would be redundant.
          await reactions.set(e.sessionId, route.ctx.channel, route.ctx.inboundTs, REACT_DONE);
          reactions.forget(e.sessionId);
          presence.exit(e.sessionId);
          await status.clear(e.sessionId);
        })();
        break;
      }
      case "error": {
        void (async () => {
          try {
            await t.client.chat.postMessage({
              channel: route.ctx.channel,
              thread_ts: route.ctx.threadTs,
              text: `:warning: error: \`${e.error}\``,
              mrkdwn: true,
            });
          } catch {}
          await reactions.set(e.sessionId, route.ctx.channel, route.ctx.inboundTs, REACT_ERROR);
          reactions.forget(e.sessionId);
          presence.exit(e.sessionId);
          await status.clear(e.sessionId);
        })();
        break;
      }
      case "compacting": {
        void status.set(
          e.sessionId,
          route.ctx.channel,
          route.ctx.threadTs,
          e.trigger === "manual" ? "compacting context (manual)…" : "compacting context…",
        );
        break;
      }
    }
  });

  async function handleMessage(args: any) {
    const { event, client, context } = args;
    const teamId: string | undefined = context.teamId ?? event.team;
    const channelId: string = event.channel;
    const userId: string | undefined = event.user;
    const eventTs: string = event.ts;
    const text: string = (event.text || "").trim();
    const channelType: string = event.channel_type ?? "";

    console.log(
      `[slack-rx] type=${event.type} subtype=${event.subtype ?? "-"} ch=${channelId} ts=${eventTs} thread=${event.thread_ts ?? "-"} user=${userId} txt=${JSON.stringify(text.slice(0, 80))}`,
    );

    if (!teamId || !userId) return;
    // Drop only self-echoes; other bots' messages flow through so slaude can
    // see CI alerts, summarizer bots, etc. in shared threads.
    const selfBotId = await getSelfBotId();
    if (event.bot_id && selfBotId && event.bot_id === selfBotId) {
      console.log(`[slack-rx] drop ch=${channelId} ts=${eventTs} — self bot echo`);
      metric.slackDropsTotal.inc({ reason: "self_bot" });
      return;
    }

    // Dedup
    const dedupKey = `${channelId}:${eventTs}`;
    if (seenEvents.has(dedupKey)) {
      console.log(`[slack-rx] drop ch=${channelId} ts=${eventTs} — dedup (already seen)`);
      metric.slackDropsTotal.inc({ reason: "dedup" });
      return;
    }
    seenEvents.add(dedupKey);

    const isDM = channelType === "im";
    const threadTs: string = event.thread_ts || (isDM ? eventTs : eventTs);

    // Ignore gate: temp/permanent ignores for users or threads
    {
      const ignored = ignoreGate.shouldDrop(userId, channelId, threadTs);
      if (ignored) {
        console.log(`[slack-rx] drop ch=${channelId} user=${userId} thread=${threadTs} — ignored`);
        metric.slackDropsTotal.inc({ reason: "ignored" });
        return;
      }
    }

    // Hard blocklist: blocked user → drop before any further processing.
    // Never reaches Claude (no token spend, no logs). Channel blocking is
    // unnecessary — default posture already denies anywhere not allowed/trusted.
    {
      const soul = soulData();
      if (soul.blockedUsers.includes(userId)) {
        console.log(`[slack-rx] drop ch=${channelId} user=${userId} — blocked user`);
        metric.slackDropsTotal.inc({ reason: "blocked_user" });
        return;
      }
    }

    // Channel-mode gate, driven entirely by SOUL.md:
    //   - trusted channel → team zone, anyone can address slaude (most open)
    //   - allowed channel  → public zone, anyone can address slaude (mind exposure)
    //   - DM or unlisted   → manager-only (approvers can still click Approve /
    //     Deny on request_approval blocks but cannot chat)
    {
      const soul = soulData();
      const isDM_ = channelType === "im";
      const isTrusted = !isDM_ && soul.trustedChannels.includes(channelId);
      const isAllowed = !isDM_ && soul.allowedChannels.includes(channelId);
      const publicZone = isTrusted || isAllowed;
      if (!publicZone) {
        const managerId = soul.manager.userId;
        const backupId = soul.backupManager.userId;
        const allowed = (managerId && userId === managerId) || (backupId && userId === backupId);
        if (!allowed) {
          console.log(
            `[slack-rx] drop ch=${channelId} user=${userId} — non-whitelist/DM accepts manager/backup only` +
              (managerId ? "" : " (no manager set in SOUL.md)"),
          );
          metric.slackDropsTotal.inc({ reason: "whitelist" });
          return;
        }
      }
    }

    // 1on1 lock: while active, only the locked user + manager/backup are heard in
    // this thread. After channel-mode (overrides "anyone can chat" in trusted/allowed
    // channels) and before slash parsing (a non-allowed user can't /1on1 off to hijack
    // someone else's lock). Approval buttons are unaffected — they go through
    // ApprovalGate's action handler, not this path.
    {
      const lock = OneOnOne.find(channelId, threadTs);
      if (lock) {
        const soul = soulData();
        const isMgr = userId === soul.manager.userId || userId === soul.backupManager.userId;
        if (userId !== lock.locked_user && !isMgr) {
          console.log(`[slack-rx] drop ch=${channelId} user=${userId} thread=${threadTs} — 1on1 locked to ${lock.locked_user}`);
          metric.slackDropsTotal.inc({ reason: "one_on_one" });
          return;
        }
      }
    }

    const botUserId = (await client.auth.test()).user_id as string;
    const stripped = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
    const hasFiles = Array.isArray(event.files) && event.files.length > 0;
    if (!stripped && !hasFiles) return;

    const session = agent.ensureSession({
      team_id: teamId,
      channel_id: channelId,
      thread_ts: threadTs,
    });

    // Slash commands: /mode, /abort, /help. Handled locally; do not forward to model.
    const slash = parseSlashCommand(stripped);
    if (slash) {
      const reply = async (txt: string) => {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: txt,
          mrkdwn: true,
        });
      };
      if (slash.kind === "help") {
        await reply(helpText());
        return;
      }
      if (slash.kind === "mode-help") {
        const modes = Object.entries(MODE_LABELS)
          .map(([k, v]) => `• \`${humanModeName(k as any)}\` — ${v}`)
          .join("\n");
        await reply(`*usage:* \`/mode <ask|accept-edits|bypass|plan|dont-ask>\`\n${modes}`);
        return;
      }
      if (slash.kind === "mode") {
        await agent.setPermissionMode(session.id, slash.mode);
        await reply(`mode → \`${humanModeName(slash.mode)}\``);
        return;
      }
      if (slash.kind === "abort") {
        agent.abort(session.id);
        await reply("aborted");
        return;
      }
      if (slash.kind === "ingest") {
        const soul = soulData();
        if (!canTriggerIngest(userId, soul)) {
          await reply("not authorized to trigger /ingest — manager or approver only");
          return;
        }
        await reply(":hourglass_flowing_sand: ingest started…");
        const result = await kbIngest.run({ triggeredBy: userId });
        if (result.ok) {
          await reply(`:white_check_mark: ingest done — ${result.summary}`);
        } else {
          await reply(`:x: ingest failed: ${result.reason}`);
        }
        return;
      }
      if (slash.kind === "one-on-one") {
        if (slash.action === "on") {
          OneOnOne.lock({ channelId, threadTs, lockedUser: userId, createdBy: userId });
          await reply(`:lock: *1on1 mode* — only <@${userId}> and the manager will be heard in this thread. \`/1on1 off\` to release.`);
          return;
        }
        const existing = OneOnOne.find(channelId, threadTs);
        if (!existing) {
          await reply("No active 1on1 in this thread.");
          return;
        }
        OneOnOne.unlock(channelId, threadTs);
        await reply(":unlock: 1on1 released — the thread is open again.");
        return;
      }
      if (slash.kind === "ignore" || slash.kind === "unignore") {
        // Authorization: manager or approver only
        const soul = soulData();
        const managerId = soul.manager.userId;
        const backupId = soul.backupManager.userId;
        const isManager = (managerId && userId === managerId) || (backupId && userId === backupId);
        const isApprover = soul.approvers.some((a) => a.userId === userId);
        if (!isManager && !isApprover) {
          await reply(":no_entry: only manager or approver can manage ignores");
          return;
        }

        if (slash.kind === "ignore") {
          if (slash.target === "user") {
            const duration = slash.duration;
            let expiresAt: number | undefined;
            if (duration) {
              const parsed = parseDuration(duration);
              if (!parsed.ok) {
                await reply(`:warning: ${parsed.error}`);
                return;
              }
              expiresAt = parsed.permanent ? undefined : Date.now() + parsed.minutes * 60 * 1000;
            }
            Ignores.remove({ targetType: "user", userId: slash.userId });
            Ignores.create({ targetType: "user", userId: slash.userId, createdBy: userId, expiresAt, reason: "manual" });
            const durText = duration ? `for ${duration}` : "permanently";
            await reply(`:mute: ignoring <@${slash.userId}> ${durText}`);
          } else {
            const duration = slash.duration;
            let expiresAt: number | undefined;
            if (duration) {
              const parsed = parseDuration(duration);
              if (!parsed.ok) {
                await reply(`:warning: ${parsed.error}`);
                return;
              }
              expiresAt = parsed.permanent ? undefined : Date.now() + parsed.minutes * 60 * 1000;
            }
            Ignores.remove({ targetType: "thread", channelId, threadTs });
            Ignores.create({ targetType: "thread", channelId, threadTs, createdBy: userId, expiresAt, reason: "manual" });
            const durText = duration ? `for ${duration}` : "permanently";
            await reply(`:mute: ignoring this thread ${durText}`);
          }
          return;
        }

        if (slash.kind === "unignore") {
          if (slash.target === "user") {
            Ignores.remove({ targetType: "user", userId: slash.userId });
            await reply(`:speaker: stopped ignoring <@${slash.userId}>`);
          } else {
            Ignores.remove({ targetType: "thread", channelId, threadTs });
            await reply(":speaker: stopped ignoring this thread");
          }
          return;
        }
      }

      if (slash.kind === "cron-add" || slash.kind === "cron-list" || slash.kind === "cron-remove") {
        const soul = soulData();
        const managerId = soul.manager.userId;
        const backupId = soul.backupManager.userId;
        const isManager = (managerId && userId === managerId) || (backupId && userId === backupId);
        const isApprover = soul.approvers.some((a) => a.userId === userId);

        if (slash.kind === "cron-list") {
          if (!isManager && !isApprover) {
            await reply(":no_entry: only manager or approver can list cron jobs");
            return;
          }
          const jobs = CronJobs.listActive();
          if (!jobs.length) {
            await reply("No active cron jobs.");
            return;
          }
          const lines = jobs.map((j) => `• \`${j.id.slice(0, 8)}\` \`${j.cronExpr}\` → ${j.prompt}`);
          await reply("*Active cron jobs*\n" + lines.join("\n"));
          return;
        }

        if (slash.kind === "cron-remove") {
          if (!isManager && !isApprover) {
            await reply(":no_entry: only manager or approver can remove cron jobs");
            return;
          }
          CronJobs.deactivate(slash.id);
          await reply(`:wastebasket: cron job \`${slash.id.slice(0, 8)}\` removed`);
          return;
        }

        if (slash.kind === "cron-add") {
          if (!isManager && !isApprover) {
            await reply(":no_entry: only manager or approver can add cron jobs");
            return;
          }

          let nextRun: number;
          try {
            nextRun = getNextRun(slash.cronExpr);
          } catch (e: any) {
            await reply(`:warning: invalid cron expression: ${e.message}`);
            return;
          }

          if (isApprover && !isManager) {
            // Approver-initiated: require manager approval
            const approval = await approvals.request({
              channel: channelId,
              threadTs: threadTs,
              summary: `Cron job: "${slash.prompt}" at "${slash.cronExpr}"`,
              category: "cron",
              risks: "Scheduled agent execution — runs unattended.",
            });
            if (!approval.approved) {
              await reply(":x: cron job denied by manager");
              return;
            }
          }

          const job = CronJobs.create({
            slackTeamId: teamId,
            slackChannelId: channelId,
            slackThreadTs: isDM ? undefined : threadTs,
            channelId,
            threadTs: isDM ? undefined : threadTs,
            createdBy: userId,
            cronExpr: slash.cronExpr,
            prompt: slash.prompt,
            nextRunAt: nextRun,
          });
          await reply(`:calendar: cron job created (\`${job.id.slice(0, 8)}\`) — next run: <t:${Math.floor(nextRun / 1000)}:R>`);
          return;
        }
      }
    }

    let userText = stripped;
    const skillHit = matchSkillInvocation(stripped, discoverSkills());
    if (skillHit) {
      userText = buildSkillInvocation(skillHit.skill, skillHit.args, session.id);
    }

    // Resolve username and download any file attachments into the session dir.
    const [userName, files] = await Promise.all([
      resolveUserName(client, userId),
      downloadAttachments({
        files: ((event.files ?? []) as SlackFile[]),
        botToken: env.slack.botToken(),
        workingDir: session.working_dir,
        inboundTs: eventTs,
      }),
    ]);
    if (env.metricsPerUser()) {
      metric.userTurnsTotal.inc({ user_id: userId, user_name: userName });
    }

    const attachmentBlock = files.length
      ? "\n" +
        files
          .map(
            (f) =>
              `<attachment name="${escapeAttr(f.name)}" mimetype="${escapeAttr(f.mimetype)}" size="${f.size}" path="${escapeAttr(f.path)}" />`,
          )
          .join("\n") +
        "\n"
      : "";

    // Per-turn channel trust hint so the agent calibrates info exposure:
    //   trusted    — internal team channel, free to show MCP/skills/internals
    //   allowed    — public channel, answer but mind exposure
    //   restricted — DM or unlisted (manager-only by the gate above)
    const trust = (() => {
      const soul = soulData();
      if (channelType !== "im" && soul.trustedChannels.includes(channelId)) return "trusted";
      if (channelType !== "im" && soul.allowedChannels.includes(channelId)) return "allowed";
      return "restricted";
    })();

    // Wrap inbound in a channel envelope so the agent has slack context
    // and a clear directive to reply via the MCP tool — not as plain text.
    const envelope =
      `<channel source="slack" channel_id="${channelId}" thread_ts="${threadTs}" ` +
      `inbound_ts="${eventTs}" user_id="${userId}" user_name="${escapeAttr(userName)}" ` +
      `trust="${trust}">\n` +
      `${userText}${attachmentBlock}\n</channel>\n\n` +
      (files.length
        ? `User attached ${files.length} file(s); paths above are local — Read them directly.\n`
        : "") +
      `Reply to the user by calling the \`mcp__${SLACK_MCP_NAME}__reply\` tool. ` +
      `Plain assistant text is not delivered to Slack — only tool calls reach the user.`;

    // 👀 received
    void reactions.set(session.id, channelId, eventTs, REACT_RECEIVED);
    presence.enter(session.id, STATUS_THINKING);
    void status.set(session.id, channelId, threadTs, "thinking…");
    permissions.bindSession(session.id, channelId, threadTs);

    // First turn for this session → seed the SlackContext + route.
    // Subsequent turns → mutate the existing context so the bound MCP tools
    // keep targeting the right thread / inbound message.
    const existing = routes.get(session.id);
    if (existing) {
      existing.ctx.channel = channelId;
      existing.ctx.threadTs = threadTs;
      existing.ctx.inboundTs = eventTs;
      existing.ctx.userId = userId;
      existing.ctx.reloadSession = () => agent.reload(session.id);
      existing.spoke = false;
    } else {
      const ctx: SlackContext = {
        client: t.client as any,
        channel: channelId,
        threadTs,
        inboundTs: eventTs,
        userId,
        teamId,
      };
      ctx.requestApproval = (req) =>
        approvals.request({
          channel: ctx.channel,
          threadTs: ctx.threadTs,
          ...req,
        });
      ctx.reloadSession = () => agent.reload(session.id);
      routes.set(session.id, { ctx, surface: surfaceFactory(bindingFor(ctx)), spoke: false });
    }

    console.log(`[slaude] sendMessage session=${session.id} cwd=${session.working_dir} model=${session.model}`);
    try {
      await agent.sendMessage(session.id, envelope);
    } catch (e: any) {
      console.error("[slaude] sendMessage threw:", e?.message ?? e, e?.stack);
    }
  }

  function escapeAttr(s: string) {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function shortPath(p: string | undefined): string {
    if (!p) return "";
    const parts = p.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || p;
  }

  function humanizeToolStatus(tool: string, input: any): string {
    const inp = input ?? {};
    switch (tool) {
      case "Read":
        return `reading ${shortPath(inp.file_path) || "file"}`;
      case "Write":
        return `writing ${shortPath(inp.file_path) || "file"}`;
      case "Edit":
      case "MultiEdit":
        return `editing ${shortPath(inp.file_path) || "file"}`;
      case "NotebookEdit":
        return `editing notebook`;
      case "Bash": {
        const cmd: string = (inp.command ?? "").toString().split("\n")[0]!.slice(0, 50);
        return cmd ? `running \`${cmd}\`` : "running command";
      }
      case "Grep":
        return `searching for "${(inp.pattern ?? "").toString().slice(0, 40)}"`;
      case "Glob":
        return `finding files (${(inp.pattern ?? "").toString().slice(0, 40)})`;
      case "LS":
        return `listing ${shortPath(inp.path) || "directory"}`;
      case "TodoWrite":
        return "updating todos";
      case "WebFetch":
        return `fetching ${(inp.url ?? "").toString().slice(0, 50)}`;
      case "WebSearch":
        return `searching web: "${(inp.query ?? "").toString().slice(0, 40)}"`;
      case "Task":
        return `delegating to subagent`;
      case `mcp__${SURFACE_MCP_NAME}__reply`:
      case `mcp__${SLACK_MCP_NAME}__reply`:
        return "replying";
      case `mcp__${SURFACE_MCP_NAME}__edit`:
      case `mcp__${SLACK_MCP_NAME}__edit`:
        return "editing reply";
      case `mcp__${SURFACE_MCP_NAME}__upload`:
      case `mcp__${SLACK_MCP_NAME}__upload`:
        return `uploading ${shortPath(inp.path) || "file"}`;
      case `mcp__${SURFACE_MCP_NAME}__react`:
      case `mcp__${SURFACE_MCP_NAME}__unreact`:
      case `mcp__${SLACK_MCP_NAME}__react`:
        return `reacting :${inp.name ?? "?"}:`;
      case `mcp__${SURFACE_MCP_NAME}__request_approval`:
      case `mcp__${SLACK_MCP_NAME}__request_approval`:
        return "requesting approval";
      case `mcp__${SURFACE_MCP_NAME}__get_history`:
        return `reading conversation history`;
      case `mcp__${SLACK_MCP_NAME}__get_user_profile`:
        return `fetching user profile`;
      case `mcp__${SLACK_MCP_NAME}__get_channel_info`:
        return `fetching channel info`;
      case `mcp__${SLACK_MCP_NAME}__get_thread_history`:
        return `reading thread history`;
      case `mcp__${SLACK_MCP_NAME}__list_users_in_channel`:
        return `listing channel members`;
      case `mcp__${SLACK_MCP_NAME}__search_messages`:
        return `searching messages`;
      default: {
        // Generic mcp tool: mcp__<server>__<tool> → "tool (server)"
        const mm = tool.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
        if (mm) return `running ${mm[2]} (${mm[1]})`;
        return `running ${tool}`;
      }
    }
  }

  // Generic diagnostic — log every event Bolt receives so we can see what's
  // arriving (or *not*) over the Socket Mode WebSocket.
  t.use(async ({ payload, next }) => {
    const ty = (payload as any)?.type ?? "?";
    const st = (payload as any)?.subtype ?? "-";
    const ch = (payload as any)?.channel ?? "-";
    const ts = (payload as any)?.ts ?? "-";
    console.log(`[slack-evt] ${ty}/${st} ch=${ch} ts=${ts}`);
    await next();
  });

  // Per-thread engagement state. Disengaged by default. @mentioning slaude
  // engages the thread (subsequent plain replies handled). @mentioning a
  // different user disengages (the user is now talking to a colleague).
  const engaged = new Set<string>(); // key: `${channel}:${thread_ts}`
  const threadKey = (channel: string, ts: string) => `${channel}:${ts}`;

  let cachedBotId: string | null = null;
  let cachedSelfBotId: string | null = null;
  const getBotId = async () => {
    if (cachedBotId) return cachedBotId;
    const res = await t.client.auth.test();
    cachedBotId = res.user_id as string;
    cachedSelfBotId = (res as any).bot_id as string;
    return cachedBotId;
  };
  const getSelfBotId = async () => {
    if (cachedSelfBotId) return cachedSelfBotId;
    await getBotId();
    return cachedSelfBotId;
  };

  // app_mention is a guaranteed delivery path even if message.channels event
  // subscription isn't enabled. Engage the thread, then defer to handleMessage.
  // (handleMessage's seenEvents dedup prevents double-handling when the same
  //  ts also arrives via the message event.)
  t.event("app_mention", async (args: any) => {
    const e: any = args.event;
    const ts: string = e.thread_ts || e.ts;
    engaged.add(threadKey(e.channel, ts));
    await handleMessage(args);
  });

  // Single message router: every non-bot message goes here so we can manage
  // engagement state consistently. We dispatch to handleMessage when slaude
  // should answer.
  t.event("message", async (args: any) => {
    const e: any = args.event;
    // Drop only self bot-echoes; other bots flow through.
    const selfBotId = await getSelfBotId();
    if (e.bot_id && selfBotId && e.bot_id === selfBotId) return;
    if (!e.user) return;

    const channelId: string = e.channel;
    const ts: string = e.thread_ts || e.ts;
    const key = threadKey(channelId, ts);
    const text: string = (e.text || "").toString();
    const botId = await getBotId();

    // DMs: always handle, no engagement tracking needed.
    if (e.channel_type === "im") {
      engaged.add(key);
      return await handleMessage(args);
    }

    const mentions = Array.from(text.matchAll(/<@([A-Z0-9]+)>/g)).map((m) => m[1]);
    const mentionsBot = mentions.includes(botId);
    const mentionsOther = mentions.some((u) => u && u !== botId);

    if (mentionsBot) {
      engaged.add(key);
      return await handleMessage(args);
    }
    if (mentionsOther) {
      engaged.delete(key);
      console.log(
        `[slack-rx] drop ch=${channelId} ts=${e.ts} user=${e.user} — mention to other user, disengaging thread`,
      );
      metric.slackDropsTotal.inc({ reason: "mention_other" });
      return;
    }
    if (engaged.has(key)) {
      return await handleMessage(args);
    }
    // Restore engagement across restarts: if a session row exists for this
    // thread, the bot was engaged here historically — keep handling plain
    // replies without forcing a re-@mention.
    const teamId: string | undefined = args.context?.teamId ?? e.team;
    if (teamId && Sessions.findByThread({ team_id: teamId, channel_id: channelId, thread_ts: ts })) {
      engaged.add(key);
      return await handleMessage(args);
    }
    console.log(
      `[slack-rx] drop ch=${channelId} ts=${e.ts} user=${e.user} — channel msg, thread not engaged (no @mention)`,
    );
    metric.slackDropsTotal.inc({ reason: "engagement" });
  });

  return {
    start: () => t.start(),
    stop: () => t.stop(),
    __sessionCtx: (sessionId: string) => sessionCtx.get(sessionId),
  };
}
