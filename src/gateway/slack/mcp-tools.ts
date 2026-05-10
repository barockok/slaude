import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { WebClient } from "@slack/web-api";
import { mdToMrkdwn } from "./format";

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
};

export const SLACK_MCP_NAME = "slaude_slack";

/** Build an SDK MCP server bound to a session's SlackContext. */
export function createSlackMcp(ctx: SlackContext): McpSdkServerConfigWithInstance {
  const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
  const err = (text: string) => ({
    content: [{ type: "text" as const, text }],
    isError: true,
  });

  return createSdkMcpServer({
    name: SLACK_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool(
        "reply",
        "Send a message to the user in the current Slack thread. This is the primary way to communicate with the user — plain assistant text is NOT shown to them. Returns the ts of the posted message so you can edit it later.",
        {
          text: z.string().describe("Message body. Slack mrkdwn supported (*bold*, _ital_, `code`, ```block```, <@U…>)."),
        },
        async ({ text }) => {
          try {
            const r = await ctx.client.chat.postMessage({
              channel: ctx.channel,
              thread_ts: ctx.threadTs,
              text: mdToMrkdwn(text),
              mrkdwn: true,
            });
            return ok(`posted ts=${r.ts}`);
          } catch (e: any) {
            return err(`slack reply failed: ${e?.message ?? String(e)}`);
          }
        },
      ),

      tool(
        "edit",
        "Edit a previous reply you posted in this thread. Pass the ts returned by reply.",
        {
          ts: z.string().describe("Slack message ts to edit."),
          text: z.string().describe("Replacement body."),
        },
        async ({ ts, text }) => {
          try {
            await ctx.client.chat.update({
              channel: ctx.channel,
              ts,
              text: mdToMrkdwn(text),
            });
            return ok("edited");
          } catch (e: any) {
            return err(`slack edit failed: ${e?.message ?? String(e)}`);
          }
        },
      ),

      tool(
        "react",
        "Add an emoji reaction to a Slack message. Defaults to the user's latest inbound message in this thread.",
        {
          name: z.string().describe("Emoji name without colons (e.g. 'eyes', 'white_check_mark')."),
          ts: z
            .string()
            .optional()
            .describe("Optional message ts; defaults to the user's latest inbound message."),
        },
        async ({ name, ts }) => {
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
      ),

      tool(
        "unreact",
        "Remove an emoji reaction you previously added.",
        {
          name: z.string(),
          ts: z.string().optional(),
        },
        async ({ name, ts }) => {
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
      ),
    ],
  });
}
