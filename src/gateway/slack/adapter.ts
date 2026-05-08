import { App, LogLevel } from "@slack/bolt";
import type { AgentManager, AgentEvent } from "../../agent/manager";
import { env } from "../../config/env";
import {
  discoverSkills,
  matchSkillInvocation,
  buildSkillInvocation,
} from "../../skills/loader";
import { Streamer } from "./streamer";
import { ReactionTracker } from "./reactions";
import { Presence } from "./presence";
import { PermissionGate } from "./permission-gate";

const REACT_RECEIVED = "eyes";
const REACT_WORKING = "gear";
const REACT_DONE = "white_check_mark";
const REACT_ERROR = "x";

const STATUS_THINKING = { text: "thinking", emoji: ":thought_balloon:" };
const STATUS_WORKING = { text: "on a task", emoji: ":hammer_and_wrench:" };

type SessionRoute = {
  channel: string;
  threadTs: string;
  inboundTs: string;
  streamer: Streamer;
  hasAssistantText: boolean;
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

  // sessionId → routing/streamer state for active turn.
  const routes = new Map<string, SessionRoute>();
  // Dedup events by (channel, ts).
  const seenEvents = new Set<string>();

  agent.on("event", (e: AgentEvent) => {
    const route = routes.get(e.sessionId);
    if (!route) return;

    switch (e.type) {
      case "assistantText": {
        if (!route.hasAssistantText) {
          route.hasAssistantText = true;
          // First token = swap 👀 → ⚙️ and update presence.
          void reactions.set(e.sessionId, route.channel, route.inboundTs, REACT_WORKING);
          presence.enter(e.sessionId, STATUS_WORKING);
        }
        route.streamer.append(e.text);
        break;
      }
      case "toolCall": {
        // Optional inline notice; keeps users informed without spamming.
        route.streamer.append(`\n_calling tool_ \`${e.tool}\`\n`);
        break;
      }
      case "thinking": {
        // We don't render thinking content (it's reasoning), but we ensure the
        // 👀 → 🤔 status transition happens on first thinking event too.
        if (!route.hasAssistantText) {
          presence.enter(e.sessionId, STATUS_THINKING);
        }
        break;
      }
      case "done": {
        void (async () => {
          await route.streamer.flush();
          await reactions.set(e.sessionId, route.channel, route.inboundTs, REACT_DONE);
          reactions.forget(e.sessionId);
          presence.exit(e.sessionId);
          routes.delete(e.sessionId);
        })();
        break;
      }
      case "error": {
        void (async () => {
          route.streamer.append(`\n:warning: error: \`${e.error}\``);
          await route.streamer.flush();
          await reactions.set(e.sessionId, route.channel, route.inboundTs, REACT_ERROR);
          reactions.forget(e.sessionId);
          presence.exit(e.sessionId);
          routes.delete(e.sessionId);
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
    if (!stripped) return;

    const isDM = channelType === "im";
    const threadTs: string = event.thread_ts || (isDM ? eventTs : eventTs);

    const session = agent.ensureSession({
      team_id: teamId,
      channel_id: channelId,
      thread_ts: threadTs,
    });

    let userText = stripped;
    const skillHit = matchSkillInvocation(stripped, discoverSkills());
    if (skillHit) {
      userText = buildSkillInvocation(skillHit.skill, skillHit.args, session.id);
    }

    // 👀 received
    void reactions.set(session.id, channelId, eventTs, REACT_RECEIVED);
    presence.enter(session.id, STATUS_THINKING);
    permissions.bindSession(session.id, channelId, threadTs);

    // Bind a fresh streamer for this turn.
    routes.set(session.id, {
      channel: channelId,
      threadTs,
      inboundTs: eventTs,
      streamer: new Streamer(client, channelId, threadTs),
      hasAssistantText: false,
    });

    await agent.sendMessage(session.id, userText);
  }

  app.event("app_mention", handleMessage);
  app.event("message", async (args: any) => {
    const e: any = args.event;
    if (e.channel_type !== "im") return;
    await handleMessage(args);
  });

  return app;
}
