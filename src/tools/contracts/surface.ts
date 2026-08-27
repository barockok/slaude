/**
 * Contract for the `slaude_surface` MCP server (agent-facing interaction tools).
 * Names, descriptions and schemas are the single source of truth; the server
 * builder (src/gateway/core/surface-mcp.ts) mounts a subset based on surface
 * capabilities and injected engines.
 */
import { z } from "zod";
import type { ServerContract } from "./types";

export const SURFACE_SERVER = "slaude_surface";

export const surfaceContract = {
  server: SURFACE_SERVER,
  tools: {
    reply: {
      name: "reply",
      description:
        "Send a message to the user in the current conversation. This is the primary way to communicate — plain assistant text is NOT shown to them. Returns a `ref` you can pass to edit later or as `thread_ref` on another reply. For a channel-root summary with threaded details, post the summary first, then pass its returned `ref` as `thread_ref` on each detail reply.",
      schema: {
        text: z.string().describe("Message body. Markdown supported."),
        thread_ref: z.string().optional().describe("Optional parent message ref. Posts this reply in that message's thread instead of the conversation's default destination."),
      },
    },
    get_history: {
      name: "get_history",
      description: "Read recent messages from the current conversation for context.",
      schema: {
        limit: z.number().optional().describe("Max messages to return."),
        include_replies: z.boolean().optional().describe("Include nested replies (default true)."),
      },
    },
    request_approval: {
      name: "request_approval",
      description:
        "Ask the user to approve a high-level plan before destructive or far-reaching work (file writes, mutating Bash, deploys, deletions, migrations, external POSTs). Blocks until an authorized user responds. Returns approved/denied.",
      schema: {
        summary: z.string().describe("One-paragraph plain-language summary of what you're about to do and why."),
        tools: z.array(z.string()).optional().describe("Tool names you intend to call."),
        files: z.array(z.string()).optional().describe("Files you intend to create / modify / delete."),
        risks: z.string().optional().describe("What could go wrong / what's irreversible. Brief."),
        category: z.string().optional().describe("Optional area hint to route to the right approver(s)."),
      },
    },
    edit: {
      name: "edit",
      description: "Edit a previous reply you posted in this conversation. Pass the `ref` returned by reply.",
      schema: {
        ref: z.string().describe("ref returned by reply."),
        text: z.string().describe("Replacement body."),
      },
    },
    react: {
      name: "react",
      description: "Add an emoji reaction. Defaults to the user's latest inbound message.",
      schema: {
        name: z.string().describe("Emoji name without colons."),
        ref: z.string().optional().describe("Optional message ref; defaults to the latest inbound message."),
      },
    },
    unreact: {
      name: "unreact",
      description: "Remove an emoji reaction you previously added.",
      schema: { name: z.string(), ref: z.string().optional() },
    },
    upload: {
      name: "upload",
      description:
        "Upload a local file to the current conversation. Use an absolute path under the session working dir.",
      schema: {
        path: z.string().describe("Absolute local path to the file to upload."),
        title: z.string().optional(),
        initial_comment: z.string().optional().describe("Posts above the file as the bot's text."),
        alt_text: z.string().optional(),
      },
    },
    typing: {
      name: "typing",
      description: "Set the typing/presence indicator on or off.",
      schema: { on: z.boolean().describe("true to show typing, false to clear.") },
    },
    set_one_on_one: {
      name: "set_one_on_one",
      description:
        'Adjust an ALREADY-ACTIVE 1on1 session for THIS thread. Cannot initiate 1on1 — use the /1on1 slash command for that.\n' +
        '• action="open" → admit all participants; use `scope` to describe behavioural constraints for guests (e.g. "read-only, no credentials"). The scope is injected into the session context — interpret and respect it for non-initiator users.\n' +
        '• action="off" → fully release 1on1; thread is public again.\n' +
        'Returns a short status to relay.',
      schema: {
        action: z.enum(["open", "off"]).describe('"open" = admit guests (add scope if needed); "off" = release entirely.'),
        scope: z.string().optional().describe('Guest constraint description for action="open". Free text — you interpret and enforce it for non-initiator users.'),
      },
    },
    set_mention_only: {
      name: "set_mention_only",
      description:
        "Set whether THIS thread is mention-only. active=true → reply ONLY when @-mentioned (ignore plain follow-ups); active=false → follow the thread normally again. Use when the user asks you to pipe down / only respond when tagged, or to undo it. Returns a short status to relay.",
      schema: { active: z.boolean().describe("true = mention-only; false = normal following.") },
    },
    soul_override: {
      name: "soul_override",
      description:
        "MANAGER-ONLY. Runtime override of soul ACLs: add/remove trusted channels (trust), public channels (allow), DM allowlist (dm), blocked users (block). Takes effect on the next message in every session and shadows SOUL.md. Refused unless the current turn was initiated by the manager's own Slack message.",
      schema: {
        field: z.enum(["trust", "allow", "dm", "block"]).describe("Which ACL to override."),
        action: z.enum(["add", "remove", "list", "clear"]).describe("list shows current overrides; clear drops this field's overrides."),
        value: z.string().optional().describe("Channel (C…/G…/D…) or user (U…/W…) id. Required for add/remove."),
      },
    },
  },
} as const satisfies ServerContract;
