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
import { PermissionGate } from "./permission-gate";
import { parseSlashCommand, helpText, humanModeName, MODE_LABELS } from "./commands";
import { createSlackMcp, SLACK_MCP_NAME, type SlackContext } from "./mcp-tools";
import { resolveUserName } from "./users";
import { downloadAttachments, type SlackFile } from "./attachments";

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
  const allowed = new Set(env.slack.allowedUsers());

  const app = new App({
    token: env.slack.botToken(),
    appToken: env.slack.appToken(),
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  const reactions = new ReactionTracker(app.client);
  const presence = new Presence(app.client);
  const permissions = new PermissionGate(app);
  agent.setPermissionResolver(permissions.resolver);

  // Per-session route + slack context. Mutated on each new inbound user message.
  const routes = new Map<string, SessionRoute>();
  // Dedup events by (channel, ts).
  const seenEvents = new Set<string>();

  // MCP resolver — first-call-per-session wires the slack MCP server bound to
  // the session's SlackContext object. We mutate fields on the same context
  // object across turns so the SDK MCP server stays valid for the session.
  agent.setMcpResolver((sessionId) => {
    const route = routes.get(sessionId);
    if (!route) return undefined;
    return { [SLACK_MCP_NAME]: createSlackMcp(route.ctx) };
  });

  agent.on("event", (e: AgentEvent) => {
    const route = routes.get(e.sessionId);
    if (!route) return;

    switch (e.type) {
      case "toolCall": {
        // Slack output happens when the agent calls mcp__slaude_slack__reply.
        // Treat that as "spoke" so we know to mark the turn as answered.
        if (e.tool === `mcp__${SLACK_MCP_NAME}__reply`) {
          route.spoke = true;
          void reactions.set(e.sessionId, route.ctx.channel, route.ctx.inboundTs, REACT_WORKING);
        }
        break;
      }
      case "done": {
        void (async () => {
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

    if (!teamId || !userId) return;
    if (event.bot_id || event.subtype === "bot_message") return;

    // Dedup
    const dedupKey = `${channelId}:${eventTs}`;
    if (seenEvents.has(dedupKey)) return;
    seenEvents.add(dedupKey);

    if (allowed.size > 0 && !allowed.has(userId)) return;

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
      routes.set(session.id, {
        ctx: {
          client: app.client,
          channel: channelId,
          threadTs,
          inboundTs: eventTs,
        },
        spoke: false,
      });
    }

    await agent.sendMessage(session.id, envelope);
  }

  function escapeAttr(s: string) {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  app.event("app_mention", handleMessage);
  app.event("message", async (args: any) => {
    const e: any = args.event;
    if (e.channel_type !== "im") return;
    await handleMessage(args);
  });

  return app;
}
