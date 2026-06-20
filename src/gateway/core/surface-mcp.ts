import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Surface } from "./surface";
import { mutateOverride, FIELD_ALIASES, type FieldAlias } from "../../soul/overrides";
import * as SoulOverrides from "../../db/soul-overrides";
import { soulData } from "../../soul/extract";

export const SURFACE_MCP_NAME = "slaude_surface";

type ToolResult = { content: Array<{ type: "text"; text: string }> };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true } as ToolResult);

export interface SurfaceToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: any) => Promise<ToolResult>;
}

export interface SurfaceMcpOpts {
  /** Resolves the CURRENT turn's inbound platform user id (live getter — the
   *  gateway mutates ctx per turn). Required to mount manager-gated tools. */
  initiator?: () => string | undefined;
  /** Start (true) / release (false) a /1on1 lock on the current thread (gateway
   *  injects the engine). When present, the set_one_on_one tool is mounted. */
  setOneOnOne?: (active: boolean) => Promise<string>;
}

/** Build the agent-facing interaction tools for a Surface. Core tools are always present;
 *  optional tools are mounted only when the matching capability is declared. Exported
 *  separately from createSurfaceMcp so the gating is unit-testable without the SDK server. */
export function surfaceTools(surface: Surface, opts: SurfaceMcpOpts = {}): SurfaceToolDef[] {
  const defs: SurfaceToolDef[] = [
    {
      name: "reply",
      description:
        "Send a message to the user in the current conversation. This is the primary way to communicate — plain assistant text is NOT shown to them. Returns a `ref` you can pass to edit later.",
      schema: { text: z.string().describe("Message body. Markdown supported.") },
      handler: async ({ text }) => {
        try { const { ref } = await surface.reply({ text }); return ok(`posted ref=${ref}`); }
        catch (e: any) { return fail(`reply failed: ${e?.message ?? String(e)}`); }
      },
    },
    {
      name: "get_history",
      description: "Read recent messages from the current conversation for context.",
      schema: {
        limit: z.number().optional().describe("Max messages to return."),
        include_replies: z.boolean().optional().describe("Include nested replies (default true)."),
      },
      handler: async ({ limit, include_replies }) => {
        try {
          const { messages, hasMore } = await surface.getHistory({ limit, includeReplies: include_replies });
          return ok(JSON.stringify({ messages, has_more: hasMore }, null, 2));
        } catch (e: any) { return fail(`get_history failed: ${e?.message ?? String(e)}`); }
      },
    },
    {
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
      handler: async ({ summary, tools, files, risks, category }) => {
        try {
          const r = await surface.requestApproval({ summary, tools, files, risks, category });
          return ok(r.approved ? `approved by <@${r.by}>` : `denied by <@${r.by}>${r.note ? ` (${r.note})` : ""}`);
        } catch (e: any) { return fail(`approval request failed: ${e?.message ?? String(e)}`); }
      },
    },
  ];

  if (surface.capabilities.has("edit") && surface.edit) {
    defs.push({
      name: "edit",
      description: "Edit a previous reply you posted in this conversation. Pass the `ref` returned by reply.",
      schema: { ref: z.string().describe("ref returned by reply."), text: z.string().describe("Replacement body.") },
      handler: async ({ ref, text }) => {
        try { await surface.edit!({ ref, text }); return ok("edited"); }
        catch (e: any) { return fail(`edit failed: ${e?.message ?? String(e)}`); }
      },
    });
  }

  if (surface.capabilities.has("react") && surface.react) {
    defs.push({
      name: "react",
      description: "Add an emoji reaction. Defaults to the user's latest inbound message.",
      schema: { name: z.string().describe("Emoji name without colons."), ref: z.string().optional().describe("Optional message ref; defaults to the latest inbound message.") },
      handler: async ({ name, ref }) => {
        try { await surface.react!({ name, ref }); return ok(`reacted :${name}:`); }
        catch (e: any) { return fail(`react failed: ${e?.message ?? String(e)}`); }
      },
    });
    defs.push({
      name: "unreact",
      description: "Remove an emoji reaction you previously added.",
      schema: { name: z.string(), ref: z.string().optional() },
      handler: async ({ name, ref }) => {
        try { await surface.unreact!({ name, ref }); return ok(`unreacted :${name}:`); }
        catch (e: any) { return fail(`unreact failed: ${e?.message ?? String(e)}`); }
      },
    });
  }

  if (surface.capabilities.has("upload") && surface.upload) {
    defs.push({
      name: "upload",
      description: "Upload a local file to the current conversation. Use an absolute path under the session working dir.",
      schema: {
        path: z.string().describe("Absolute local path to the file to upload."),
        title: z.string().optional(),
        initial_comment: z.string().optional().describe("Posts above the file as the bot's text."),
        alt_text: z.string().optional(),
      },
      handler: async ({ path, title, initial_comment, alt_text }) => {
        try { await surface.upload!({ path, title, comment: initial_comment, altText: alt_text }); return ok("uploaded"); }
        catch (e: any) { return fail(`upload failed: ${e?.message ?? String(e)}`); }
      },
    });
  }

  if (surface.capabilities.has("typing") && surface.typing) {
    defs.push({
      name: "typing",
      description: "Set the typing/presence indicator on or off.",
      schema: { on: z.boolean().describe("true to show typing, false to clear.") },
      handler: async ({ on }) => {
        try { await surface.typing!({ on }); return ok(`typing ${on ? "on" : "off"}`); }
        catch (e: any) { return fail(`typing failed: ${e?.message ?? String(e)}`); }
      },
    });
  }

  if (opts.setOneOnOne) {
    const setOneOnOne = opts.setOneOnOne;
    defs.push({
      name: "set_one_on_one",
      description:
        "Lock or release 1on1 mode for THIS thread. active=true → private session heard only by the current user + the manager; active=false → reopen it. Use when the user asks to go private / one-on-one, or to end it. Returns a short status to relay.",
      schema: { active: z.boolean().describe("true = start 1on1 (lock to the current user); false = release it.") },
      handler: async ({ active }) => {
        try { return ok(await setOneOnOne(active)); }
        catch (e: any) { return fail(`set_one_on_one failed: ${e?.message ?? String(e)}`); }
      },
    });
  }

  if (opts.initiator) {
    const initiator = opts.initiator;
    defs.push({
      name: "soul_override",
      description:
        "MANAGER-ONLY. Runtime override of soul ACLs: add/remove trusted channels (trust), public channels (allow), DM allowlist (dm), blocked users (block). Takes effect on the next message in every session and shadows SOUL.md. Refused unless the current turn was initiated by the manager's own Slack message.",
      schema: {
        field: z.enum(["trust", "allow", "dm", "block"]).describe("Which ACL to override."),
        action: z.enum(["add", "remove", "list", "clear"]).describe("list shows current overrides; clear drops this field's overrides."),
        value: z.string().optional().describe("Channel (C…/G…/D…) or user (U…/W…) id. Required for add/remove."),
      },
      handler: async ({ field, action, value }) => {
        const soul = soulData();
        const who = initiator();
        // Primary manager only (owner: "only Manager") — checked against the
        // signed inbound Slack user id, not the model's intent.
        if (!soul.manager.userId || who !== soul.manager.userId) {
          return fail("soul_override is manager-only: this turn was not initiated by the manager.");
        }
        if (action === "list") {
          return ok(JSON.stringify(SoulOverrides.list(), null, 2));
        }
        if (action === "clear") {
          SoulOverrides.clear(FIELD_ALIASES[field as FieldAlias]);
          return ok(`cleared runtime overrides for ${field}`);
        }
        if (!value) return fail("value is required for add/remove");
        const res = mutateOverride({ field: field as FieldAlias, action, value, by: who }, { managerId: soul.manager.userId });
        return res.ok
          ? ok(`soul override applied: ${res.field} ${action} ${res.value} — effective immediately`)
          : fail(res.reason);
      },
    });
  }

  return defs;
}

/** Build an SDK MCP server (`slaude_surface`) from a Surface's declared capabilities. */
export function createSurfaceMcp(surface: Surface, opts: SurfaceMcpOpts = {}): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SURFACE_MCP_NAME,
    version: "0.1.0",
    tools: surfaceTools(surface, opts).map((d) => tool(d.name, d.description, d.schema, d.handler)),
  });
}
