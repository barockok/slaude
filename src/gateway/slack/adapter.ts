import { App, LogLevel } from "@slack/bolt";
import type { AgentManager, AgentEvent } from "../../agent/manager";
import { env } from "../../config/env";
import {
  discoverSkills,
  matchSkillInvocation,
  buildSkillInvocation,
} from "../../skills/loader";
import { ReactionTracker } from "./reactions";
import { Presence } from "./presence";
import { Status } from "./status";
import { PermissionGate } from "./permission-gate";
import { ApprovalGate } from "./approval-gate";
import { parseSlashCommand, helpText, humanModeName, MODE_LABELS } from "./commands";
import { soulData } from "../../soul/extract";
import { createSlackMcp, SLACK_MCP_NAME, type SlackContext } from "./mcp-tools";
import { createSkillsMcp, SKILLS_MCP_NAME } from "../../skills/mcp-tools";
import { loadExternalMcp } from "../../config/mcp";
import { resolveUserName } from "./users";
import { downloadAttachments, type SlackFile } from "./attachments";
import * as Sessions from "../../db/sessions";

const REACT_RECEIVED = "eyes";
const REACT_WORKING = "gear";
const REACT_DONE = "white_check_mark";
const REACT_ERROR = "x";

const STATUS_THINKING = { text: "thinking", emoji: ":thought_balloon:" };

type SessionRoute = {
  ctx: SlackContext;
  /** Whether the agent has emitted any user-visible Slack output this turn (via mcp__slaude_slack__reply). */
  spoke: boolean;
};

export function createSlackApp(agent: AgentManager) {

  const app = new App({
    token: env.slack.botToken(),
    appToken: env.slack.appToken(),
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  const reactions = new ReactionTracker(app.client);
  const presence = new Presence(app.client);
  const status = new Status(app.client);
  const permissions = new PermissionGate(app);
  const approvals = new ApprovalGate(app, env.slack.approvers());
  agent.setPermissionResolver(permissions.resolver);

  // Diag: dump bot identity + granted scopes once at startup.
  void (async () => {
    try {
      const t = await app.client.auth.test();
      const scopesHeader = (t as any).response_metadata?.scopes ?? (t as any).headers?.["x-oauth-scopes"];
      console.log(`[slack-auth] team=${(t as any).team} user=${(t as any).user} bot_id=${(t as any).bot_id} url=${(t as any).url}`);
      console.log(`[slack-auth] scopes=${scopesHeader ?? "(unknown — check app OAuth page)"}`);
    } catch (e: any) {
      console.error("[slack-auth] auth.test failed:", e?.data?.error ?? e?.message);
    }
  })();

  // Per-session route + slack context. Mutated on each new inbound user message.
  const routes = new Map<string, SessionRoute>();
  // Dedup events by (channel, ts).
  const seenEvents = new Set<string>();

  // External MCP servers (stdio/sse/http) declared in $SLAUDE_HOME/mcp.json.
  // Loaded once at boot — restart slaude after editing mcp.json. Reserved
  // server names (slaude_slack, slaude_skills) are dropped at load time so
  // user config cannot shadow the in-process Slack output server.
  const externalMcp = loadExternalMcp();
  const externalNames = Object.keys(externalMcp);
  if (externalNames.length) {
    console.log(`[mcp] external servers: ${externalNames.join(", ")}`);
  }

  // MCP resolver — first-call-per-session wires the slack MCP server bound to
  // the session's SlackContext object. We mutate fields on the same context
  // object across turns so the SDK MCP server stays valid for the session.
  agent.setMcpResolver((sessionId) => {
    const route = routes.get(sessionId);
    if (!route) return undefined;
    return {
      ...externalMcp,
      [SLACK_MCP_NAME]: createSlackMcp(route.ctx),
      [SKILLS_MCP_NAME]: createSkillsMcp(),
    };
  });

  agent.on("event", (e: AgentEvent) => {
    console.log(`[agent-evt] ${e.type} session=${e.sessionId}${"tool" in e ? ` tool=${e.tool}` : ""}${"error" in e ? ` err=${e.error}` : ""}`);
    const route = routes.get(e.sessionId);
    if (!route) return;

    switch (e.type) {
      case "toolCall": {
        // Any user-visible Slack tool counts as "spoke" — reply, edit, upload
        // all surface content. (react alone doesn't satisfy: an emoji isn't
        // a real answer.)
        const userVisible =
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
          // Auto-evolve turns are internal — silent NO is valid, so skip the
          // "no reply emitted" nudge and don't reset reactions/presence
          // (they were already finalized on the user-visible turn's done).
          if (e.autoEvolve) return;
          if (!route.spoke) {
            // Agent finished without surfacing anything to Slack. Nudge so
            // the user isn't left guessing — and so SOUL.md drift is visible.
            try {
              await app.client.chat.postMessage({
                channel: route.ctx.channel,
                thread_ts: route.ctx.threadTs,
                text: "_(no reply emitted — agent forgot `mcp__slaude_slack__reply`)_",
                mrkdwn: true,
              });
            } catch {}
          }
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
            await app.client.chat.postMessage({
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
    if (event.bot_id || event.subtype === "bot_message") return;

    // Dedup
    const dedupKey = `${channelId}:${eventTs}`;
    if (seenEvents.has(dedupKey)) return;
    seenEvents.add(dedupKey);

    // Channel-mode gate, driven entirely by SOUL.md:
    //   - whitelisted channel → public zone, anyone can address slaude
    //   - non-whitelisted channel OR DM → manager-only (approvers can still
    //     click Approve / Deny on request_approval blocks but cannot chat)
    {
      const soul = soulData();
      const isDM_ = channelType === "im";
      const whitelisted =
        !isDM_ && soul.allowedChannels.length > 0 && soul.allowedChannels.includes(channelId);
      if (!whitelisted) {
        const managerId = soul.manager.userId;
        if (!managerId || userId !== managerId) {
          console.log(
            `[slack-rx] drop ch=${channelId} user=${userId} — non-whitelist/DM accepts manager only` +
              (managerId ? "" : " (no manager set in SOUL.md)"),
          );
          return;
        }
      }
    }

    const botUserId = (await client.auth.test()).user_id as string;
    const stripped = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
    const hasFiles = Array.isArray(event.files) && event.files.length > 0;
    if (!stripped && !hasFiles) return;

    const isDM = channelType === "im";
    const threadTs: string = event.thread_ts || (isDM ? eventTs : eventTs);

    const session = agent.ensureSession({
      team_id: teamId,
      channel_id: channelId,
      thread_ts: threadTs,
    });

    // Slash commands: /mode, /abort, /help. Handled locally; do not forward to model.
    const slash = parseSlashCommand(stripped);
    if (slash) {
      const reply = async (t: string) => {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: t,
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

    // Wrap inbound in a channel envelope so the agent has slack context
    // and a clear directive to reply via the MCP tool — not as plain text.
    const envelope =
      `<channel source="slack" channel_id="${channelId}" thread_ts="${threadTs}" ` +
      `inbound_ts="${eventTs}" user_id="${userId}" user_name="${escapeAttr(userName)}">\n` +
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
      existing.spoke = false;
    } else {
      const ctx: SlackContext = {
        client: app.client,
        channel: channelId,
        threadTs,
        inboundTs: eventTs,
      };
      ctx.requestApproval = (req) =>
        approvals.request({
          channel: ctx.channel,
          threadTs: ctx.threadTs,
          ...req,
        });
      routes.set(session.id, { ctx, spoke: false });
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
      case `mcp__${SLACK_MCP_NAME}__reply`:
        return "replying";
      case `mcp__${SLACK_MCP_NAME}__edit`:
        return "editing reply";
      case `mcp__${SLACK_MCP_NAME}__upload`:
        return `uploading ${shortPath(inp.path) || "file"}`;
      case `mcp__${SLACK_MCP_NAME}__react`:
        return `reacting :${inp.name ?? "?"}:`;
      case `mcp__${SLACK_MCP_NAME}__request_approval`:
        return "requesting approval";
      default: {
        // Generic mcp tool: mcp__<server>__<tool> → "tool (server)"
        const m = tool.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
        if (m) return `running ${m[2]} (${m[1]})`;
        return `running ${tool}`;
      }
    }
  }

  // Generic diagnostic — log every event Bolt receives so we can see what's
  // arriving (or *not*) over the Socket Mode WebSocket.
  app.use(async ({ payload, next }) => {
    const t = (payload as any)?.type ?? "?";
    const st = (payload as any)?.subtype ?? "-";
    const ch = (payload as any)?.channel ?? "-";
    const ts = (payload as any)?.ts ?? "-";
    console.log(`[slack-evt] ${t}/${st} ch=${ch} ts=${ts}`);
    await next();
  });

  // Per-thread engagement state. Disengaged by default. @mentioning slaude
  // engages the thread (subsequent plain replies handled). @mentioning a
  // different user disengages (the user is now talking to a colleague).
  const engaged = new Set<string>(); // key: `${channel}:${thread_ts}`
  const threadKey = (channel: string, ts: string) => `${channel}:${ts}`;

  let cachedBotId: string | null = null;
  const getBotId = async () => {
    if (cachedBotId) return cachedBotId;
    cachedBotId = (await app.client.auth.test()).user_id as string;
    return cachedBotId;
  };

  // app_mention is a guaranteed delivery path even if message.channels event
  // subscription isn't enabled. Engage the thread, then defer to handleMessage.
  // (handleMessage's seenEvents dedup prevents double-handling when the same
  //  ts also arrives via the message event.)
  app.event("app_mention", async (args: any) => {
    const e: any = args.event;
    const ts: string = e.thread_ts || e.ts;
    engaged.add(threadKey(e.channel, ts));
    await handleMessage(args);
  });

  // Single message router: every non-bot message goes here so we can manage
  // engagement state consistently. We dispatch to handleMessage when slaude
  // should answer.
  app.event("message", async (args: any) => {
    const e: any = args.event;
    if (e.bot_id || e.subtype === "bot_message") return;
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
      return; // user redirected to a colleague
    }
    if (engaged.has(key)) {
      return await handleMessage(args);
    }
    // Plain channel chatter, not for us.
  });

  // Disengage when slaude finishes a turn AND no follow-up arrives within the
  // idle window. We piggyback on AgentManager's existing idle teardown by
  // clearing engagement when the SDK loop unwinds (per session).
  // (The SDK doesn't currently surface session shutdown, so this is best-
  //  effort: engagement also clears on @mention to a different user.)

  // Sessions import retained for ensureSession path.
  void Sessions;

  return app;
}
