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
        "Send a message to the user in the current conversation. This is the primary way to communicate — plain assistant text is NOT shown to them. Returns a `ref` you can pass to edit later.",
      schema: { text: z.string().describe("Message body. Markdown supported.") },
    },
    pass: {
      name: "pass",
      description:
        "End this turn deliberately WITHOUT replying, when the message isn't for you or needs nothing from you. Optionally react (e.g. `eyes`). Logged. Never use it to dodge a question addressed to you.",
      schema: {
        reason: z.string().describe("Why you are not replying (logged, never shown)."),
        react: z.string().optional().describe("Optional emoji name (without colons) to react with on the inbound message."),
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
        "Upload a local file to the current conversation. Use an absolute path to a regular file under the session working directory or under $TMPDIR (your per-session scratch directory). If the file is anywhere else, copy it into one of those first. The tool does the transfer itself: do not curl or post the file by other means.",
      schema: {
        path: z.string().describe("Absolute local path to the file to upload."),
        title: z.string().optional(),
        initial_comment: z.string().optional().describe("Posts above the file as the bot's text."),
        alt_text: z.string().optional(),
      },
    },
    upload_begin: {
      name: "upload_begin",
      description:
        "REST-only (never mounted for the model): the first half of a direct upload. A node asks the gateway for Slack's presigned upload URL for one file it holds (name and declared size), then sends the bytes to Slack itself. Returns {uploadUrl, fileId, handle}: the URL and the handle are credentials for that one file and are never shown to the model.",
      restOnly: true,
      schema: {
        filename: z.string().min(1).max(1024).describe("File name as the node knows it. The gateway keeps the base name, strips control characters and caps its length."),
        size: z.number().int().min(1).describe("Exact size in bytes of the file the node will send. Slack stores at most this many bytes."),
        alt_text: z.string().max(4000).optional().describe("Alt text for an image."),
      },
    },
    upload_complete: {
      name: "upload_complete",
      description:
        "REST-only (never mounted for the model): the second half of a direct upload. After the node has sent the bytes to Slack and checked Slack's answer, it asks the gateway to finish the upload with the handle from upload_begin. The destination comes from the handle, never from this body. The caption goes through the owner's reply rules and may be held for approval.",
      restOnly: true,
      schema: {
        handle: z.string().min(1).max(4096).describe("The handle upload_begin returned."),
        title: z.string().max(1024).optional(),
        initial_comment: z.string().optional().describe("Posts above the file as the bot's text."),
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
