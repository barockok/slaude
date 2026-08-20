import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { WASocket } from "@whiskeysockets/baileys";
import { readFileSync } from "node:fs";
import { mdToWhatsApp, chunkText } from "./format";

export type WhatsAppContext = {
  sock: WASocket;
  jid: string;
  msgId: string; // Anchor message ID for reactions
  requestApproval?: (req: {
    summary: string;
    tools?: string[];
    files?: string[];
    risks?: string;
    category?: string;
  }) => Promise<{ approved: boolean; by: string; note?: string }>;
};

export const WHATSAPP_MCP_NAME = "slaude_whatsapp";

export function createWhatsAppMcp(ctx: WhatsAppContext): McpSdkServerConfigWithInstance {
  const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
  const err = (text: string) => ({
    content: [{ type: "text" as const, text }],
    isError: true,
  });

  return createSdkMcpServer({
    name: WHATSAPP_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool(
        "reply",
        "Send a text message to the user in the current WhatsApp chat. This is the primary way to communicate — plain assistant text is NOT delivered. For long messages the tool auto-chunks at WhatsApp's 4096 char limit.",
        {
          text: z.string().describe("Message body. WhatsApp formatting supported (*bold*, _italic_, `code`)."),
        },
        async ({ text }) => {
          try {
            const formatted = mdToWhatsApp(text);
            const chunks = chunkText(formatted);
            for (const chunk of chunks) {
              await ctx.sock.sendMessage(ctx.jid, { text: chunk });
            }
            return ok(`sent ${chunks.length} message(s)`);
          } catch (e: any) {
            return err(`whatsapp reply failed: ${e?.message ?? String(e)}`);
          }
        },
      ),

      tool(
        "react",
        "Add an emoji reaction to a WhatsApp message. Defaults to the user's latest inbound message.",
        {
          emoji: z.string().describe("Emoji character (e.g. '👍', '✅', '❌')."),
          msgId: z.string().optional().describe("Optional message ID; defaults to latest inbound."),
        },
        async ({ emoji, msgId }) => {
          try {
            await ctx.sock.sendMessage(ctx.jid, {
              react: {
                text: emoji,
                key: {
                  remoteJid: ctx.jid,
                  id: msgId || ctx.msgId,
                  fromMe: false,
                },
              },
            });
            return ok(`reacted ${emoji}`);
          } catch (e: any) {
            return err(`whatsapp react failed: ${e?.message ?? String(e)}`);
          }
        },
      ),

      tool(
        "request_approval",
        "Ask the user to approve a high-level plan before executing destructive or far-reaching work. Posts a text summary and waits for the approver to reply 'approve' or 'deny'. Returns {approved: bool, by: <phone>, note?}.",
        {
          summary: z.string().describe("One-paragraph plain-language summary of what you're about to do."),
          tools: z.array(z.string()).optional().describe("List of tool names you intend to call."),
          files: z.array(z.string()).optional().describe("Files you intend to modify."),
          risks: z.string().optional().describe("What could go wrong."),
          category: z.string().optional().describe("Optional area hint for approver routing."),
        },
        async ({ summary, tools, files, risks, category }) => {
          if (!ctx.requestApproval) {
            return err("approval gate not wired (transport bug)");
          }
          try {
            const r = await ctx.requestApproval({ summary, tools, files, risks, category });
            if (r.approved) {
              return ok(`approved by ${r.by}`);
            }
            return ok(`denied by ${r.by}${r.note ? ` (${r.note})` : ""}`);
          } catch (e: any) {
            return err(`approval request failed: ${e?.message ?? String(e)}`);
          }
        },
      ),

      tool(
        "upload",
        "Upload a local file to the current WhatsApp chat. Use absolute paths under the session working dir.",
        {
          path: z.string().describe("Absolute local path to the file."),
          caption: z.string().optional().describe("Optional caption text."),
        },
        async ({ path, caption }) => {
          try {
            const buffer = readFileSync(path);
            const filename = path.split("/").pop() || "file";
            const mimetype = "application/octet-stream"; // WhatsApp infers from content

            await ctx.sock.sendMessage(ctx.jid, {
              document: buffer,
              fileName: filename,
              caption: caption ? mdToWhatsApp(caption) : undefined,
              mimetype,
            });
            return ok(`uploaded ${filename}`);
          } catch (e: any) {
            return err(`whatsapp upload failed: ${e?.message ?? String(e)}`);
          }
        },
      ),
    ],
  });
}
