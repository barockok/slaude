import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { surfaceContract } from "../../tools/contracts/surface";
import type { Surface } from "./surface";
import { mutateOverride, FIELD_ALIASES, type FieldAlias } from "../../soul/overrides";
import * as SoulOverrides from "../../db/soul-overrides";
import { soulData } from "../../soul/extract";

export const SURFACE_MCP_NAME = surfaceContract.server;

const c = surfaceContract.tools;

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
  /** Manage 1on1 state on the current thread (gateway injects the engine).
   *  action="lock" → private (initiator+manager only); "open" → admit guests with
   *  optional scope description; "off" → fully release. */
  setOneOnOne?: (action: "lock" | "open" | "off", scope?: string) => Promise<string>;
  /** Toggle mention-only mode for the current thread (gateway injects the engine —
   *  surface-mcp stays decoupled from the db). When present, the set_mention_only
   *  tool is mounted. */
  setMentionOnly?: (active: boolean) => Promise<string>;
}

/** Build the agent-facing interaction tools for a Surface. Core tools are always present;
 *  optional tools are mounted only when the matching capability is declared. Exported
 *  separately from createSurfaceMcp so the gating is unit-testable without the SDK server. */
export function surfaceTools(surface: Surface, opts: SurfaceMcpOpts = {}): SurfaceToolDef[] {
  const defs: SurfaceToolDef[] = [
    {
      ...c.reply,
      handler: async ({ text }) => {
        try { const { ref } = await surface.reply({ text }); return ok(`posted ref=${ref}`); }
        catch (e: any) { return fail(`reply failed: ${e?.message ?? String(e)}`); }
      },
    },
    {
      ...c.get_history,
      handler: async ({ limit, include_replies }) => {
        try {
          const { messages, hasMore } = await surface.getHistory({ limit, includeReplies: include_replies });
          return ok(JSON.stringify({ messages, has_more: hasMore }, null, 2));
        } catch (e: any) { return fail(`get_history failed: ${e?.message ?? String(e)}`); }
      },
    },
    {
      ...c.request_approval,
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
      ...c.edit,
      handler: async ({ ref, text }) => {
        try { await surface.edit!({ ref, text }); return ok("edited"); }
        catch (e: any) { return fail(`edit failed: ${e?.message ?? String(e)}`); }
      },
    });
  }

  if (surface.capabilities.has("react") && surface.react) {
    defs.push({
      ...c.react,
      handler: async ({ name, ref }) => {
        try { await surface.react!({ name, ref }); return ok(`reacted :${name}:`); }
        catch (e: any) { return fail(`react failed: ${e?.message ?? String(e)}`); }
      },
    });
    defs.push({
      ...c.unreact,
      handler: async ({ name, ref }) => {
        try { await surface.unreact!({ name, ref }); return ok(`unreacted :${name}:`); }
        catch (e: any) { return fail(`unreact failed: ${e?.message ?? String(e)}`); }
      },
    });
  }

  if (surface.capabilities.has("upload") && surface.upload) {
    defs.push({
      ...c.upload,
      handler: async ({ path, title, initial_comment, alt_text }) => {
        try { await surface.upload!({ path, title, comment: initial_comment, altText: alt_text }); return ok("uploaded"); }
        catch (e: any) { return fail(`upload failed: ${e?.message ?? String(e)}`); }
      },
    });
  }

  if (surface.capabilities.has("typing") && surface.typing) {
    defs.push({
      ...c.typing,
      handler: async ({ on }) => {
        try { await surface.typing!({ on }); return ok(`typing ${on ? "on" : "off"}`); }
        catch (e: any) { return fail(`typing failed: ${e?.message ?? String(e)}`); }
      },
    });
  }

  if (opts.setOneOnOne) {
    const setOneOnOne = opts.setOneOnOne;
    defs.push({
      ...c.set_one_on_one,
      handler: async ({ action, scope }) => {
        try { return ok(await setOneOnOne(action, scope)); }
        catch (e: any) { return fail(`set_one_on_one failed: ${e?.message ?? String(e)}`); }
      },
    });
  }

  if (opts.setMentionOnly) {
    const setMentionOnly = opts.setMentionOnly;
    defs.push({
      ...c.set_mention_only,
      handler: async ({ active }) => {
        try { return ok(await setMentionOnly(active)); }
        catch (e: any) { return fail(`set_mention_only failed: ${e?.message ?? String(e)}`); }
      },
    });
  }

  if (opts.initiator) {
    const initiator = opts.initiator;
    defs.push({
      ...c.soul_override,
      handler: async ({ field, action, value }) => {
        const soul = soulData();
        const who = initiator();
        // Primary manager only (owner: "only Manager") — checked against the
        // signed inbound Slack user id, not the model's intent.
        if (!soul.manager.userId || who !== soul.manager.userId) {
          return fail("soul_override is manager-only: this turn was not initiated by the manager.");
        }
        if (action === "list") {
          return ok(JSON.stringify(await SoulOverrides.list(), null, 2));
        }
        if (action === "clear") {
          await SoulOverrides.clear(FIELD_ALIASES[field as FieldAlias]);
          return ok(`cleared runtime overrides for ${field}`);
        }
        if (!value) return fail("value is required for add/remove");
        const res = await mutateOverride({ field: field as FieldAlias, action, value, by: who }, { managerId: soul.manager.userId });
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
