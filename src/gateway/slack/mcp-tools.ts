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
  /** Optional approval gate — set by the adapter so request_approval works. */
  requestApproval?: (req: {
    summary: string;
    tools?: string[];
    files?: string[];
    risks?: string;
    category?: string;
  }) => Promise<{ approved: boolean; by: string; note?: string }>;
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
        "request_approval",
        "Ask the user to approve a high-level plan before executing destructive or far-reaching work (file writes, mutating Bash, deploys, deletions, migrations, external POSTs, etc.). Posts a Block Kit message with the plan summary and Approve/Deny buttons; blocks until an authorized user clicks. Returns {approved: bool, by: <user_id>, note?}. If approved=false, do NOT proceed — reply explaining you need a different plan. Read-only ops (Read/Grep/Glob/LS/git status) do not need approval. Provide `category` when the persona's <approvers> block defines per-area allowlists (e.g. 'database', 'deploy', 'code') so the right people are gated; otherwise the default approvers apply.",
        {
          summary: z
            .string()
            .describe("One-paragraph plain-language summary of what you're about to do and why."),
          tools: z
            .array(z.string())
            .optional()
            .describe("List of tool names you intend to call (e.g. ['Bash','Edit','mcp__slaude_slack__upload'])."),
          files: z
            .array(z.string())
            .optional()
            .describe("Files you intend to create / modify / delete."),
          risks: z
            .string()
            .optional()
            .describe("What could go wrong / what's irreversible. Brief."),
          category: z
            .string()
            .optional()
            .describe("Optional short area hint to help the runtime route the plan to the right approver(s) — e.g. 'database', 'deploy', 'code', 'comms'. The runtime keyword-matches `summary` (and this hint when given) against the persona's <approvers> scope descriptions; you do NOT decide who approves. If you have no idea, omit it."),
        },
        async ({ summary, tools, files, risks, category }) => {
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
      ),

      tool(
        "upload",
        "Upload a local file to the current Slack thread. Use absolute paths under the session working dir (e.g. files you've Written or downloaded). Optional initial_comment posts above the file as the bot's text; omit to upload silently. Requires the bot's `files:write` scope.",
        {
          path: z.string().describe("Absolute local path to the file to upload."),
          title: z.string().optional().describe("Display title (defaults to filename)."),
          initial_comment: z
            .string()
            .optional()
            .describe("Optional message body posted with the file. Markdown supported (converted to Slack mrkdwn)."),
          alt_text: z
            .string()
            .optional()
            .describe("Accessibility alt text for images."),
        },
        async ({ path, title, initial_comment, alt_text }) => {
          try {
            statSync(path); // throws if missing
            const filename = basename(path);
            const r = await ctx.client.files.uploadV2({
              channel_id: ctx.channel,
              thread_ts: ctx.threadTs,
              file: createReadStream(path),
              filename,
              title: title ?? filename,
              ...(initial_comment ? { initial_comment: mdToMrkdwn(initial_comment) } : {}),
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
