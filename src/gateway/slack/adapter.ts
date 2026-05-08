import { App, LogLevel } from "@slack/bolt";
import type { AgentManager, AgentEvent } from "../../agent/manager";
import { env } from "../../config/env";
import { chunkText, mdToMrkdwn } from "./format";
import {
  discoverSkills,
  matchSkillInvocation,
  buildSkillInvocation,
} from "../../skills/loader";

type Outbox = {
  postMessage: (text: string) => Promise<string | undefined>;
  postEphemeral: (text: string) => Promise<void>;
};

export function createSlackApp(agent: AgentManager) {
  const allowed = new Set(env.slack.allowedUsers());

  const app = new App({
    token: env.slack.botToken(),
    appToken: env.slack.appToken(),
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  // Track which sessionId is "owned" by which (channel, thread) so we can route events back.
  const sessionToOutbox = new Map<string, Outbox>();
  // Dedup events by (channel, ts).
  const seenEvents = new Set<string>();

  agent.on("event", (e: AgentEvent) => {
    const out = sessionToOutbox.get(e.sessionId);
    if (!out) return;
    if (e.type === "assistantText") {
      const mrk = mdToMrkdwn(e.text);
      for (const chunk of chunkText(mrk)) {
        void out.postMessage(chunk);
      }
    } else if (e.type === "toolCall") {
      void out.postMessage(`_calling tool_ \`${e.tool}\``);
    } else if (e.type === "error") {
      void out.postMessage(`:warning: error: \`${e.error}\``);
    } else if (e.type === "done") {
      // Optional: react to message. Skip for now.
    }
  });

  async function handleMessage(args: any) {
    const { event, client, context, say } = args;
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

    if (allowed.size > 0 && !allowed.has(userId)) {
      return; // silently ignore
    }

    // Strip <@BOTID> mention
    const botUserId = (await client.auth.test()).user_id as string;
    const stripped = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
    if (!stripped) return;

    // Thread key: channel msgs require a thread (use parent ts or own ts to start one); DMs use ts.
    const isDM = channelType === "im";
    const threadTs: string = event.thread_ts || (isDM ? eventTs : eventTs);

    const session = agent.ensureSession({
      team_id: teamId,
      channel_id: channelId,
      thread_ts: threadTs,
    });

    // Skill expansion: /skill-name args → expanded skill body
    let userText = stripped;
    const skillHit = matchSkillInvocation(stripped, discoverSkills());
    if (skillHit) {
      userText = buildSkillInvocation(skillHit.skill, skillHit.args, session.id);
    }

    const outbox: Outbox = {
      postMessage: async (t) => {
        const r = await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: t,
          mrkdwn: true,
        });
        return r.ts as string | undefined;
      },
      postEphemeral: async (t) => {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: t,
          thread_ts: threadTs,
        });
      },
    };
    sessionToOutbox.set(session.id, outbox);

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
