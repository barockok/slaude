/**
 * The heartbeat round's reads of the agent's own MCP sources (heartbeat round
 * spec §4, step 2). Every call goes through the gateway's MCP bridge with
 * {@link backgroundClaims}: runAs the agent, no /1on1 lock, no thread and no
 * person, so the bridge chooses the agent's shared credential for the persona
 * and never a person's. Only the source's declared `readTools` are offered or
 * called; anything else is refused before the bridge is touched.
 *
 * The bridge this reader is built on has no `onNeedsAuth`, so a source that
 * needs connecting or re-authorising posts no card: the reader answers
 * `needs-auth` and the round decides what to tell whom.
 */
import type { JobClaims } from "../gateway/api/auth";
import { oauthHttpServers, type ExternalMcp } from "../gateway/core/external-mcp";
import { connectText, reauthText, type CallToolResult, type McpBridge } from "../gateway/core/mcp-bridge";
import { redactSecrets } from "../gateway/core/status-text";
import type { WatchedSource } from "./sources";

export type ReadOutcome = { kind: "ok"; text: string } | { kind: "needs-auth" } | { kind: "error"; text: string };

export interface SourceReader {
  tools(personaId: string, src: WatchedSource): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  read(personaId: string, server: string, tool: string, args: unknown, signal?: AbortSignal): Promise<ReadOutcome>;
}

/** Claims for a background read: the agent itself, outside any thread.
 *  `lock: null` makes the bridge's card scope "global" (the manager's). */
export function backgroundClaims(personaId: string, agentId: string): JobClaims {
  return {
    tenant: "default",
    persona: personaId,
    session: "background:" + agentId,
    team: "",
    channel: "",
    thread: "",
    initiator: "",
    scope: "",
    runAs: "agent",
    lock: null,
    // Never signed into a token: the bridge does not read `exp`, and 0 reads
    // as already expired anywhere that would.
    exp: 0,
  };
}

/** The text parts of a tool result, joined; structured content when there is no text. */
function resultText(r: CallToolResult): string {
  const parts = (Array.isArray(r.content) ? r.content : [])
    .filter((c): c is { type: "text"; text: string } => !!c && (c as any).type === "text" && typeof (c as any).text === "string")
    .map((c) => c.text);
  if (parts.length) return parts.join("\n");
  return r.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : "";
}

/** A reader over `bridge`. A tool is callable only once `tools()` offered the
 *  source for that persona (the round lists before it reads), so `read()`
 *  checks against that source's `readTools`. Background reads key their
 *  pooled upstream session per persona (`background:<personaId>`). */
export function createSourceReader(
  bridge: Pick<McpBridge, "list" | "call">,
  warn: (msg: string) => void = (m) => console.warn(m),
): SourceReader {
  const warned = new Set<string>();
  /** The readTools of the last listing per (persona, server): what read() may call. */
  const allowed = new Map<string, Set<string>>();
  const key = (personaId: string, server: string) => `${personaId}\u0000${server}`;

  return {
    async tools(personaId, src) {
      allowed.set(key(personaId, src.server), new Set(src.readTools));
      const listed = await bridge.list(backgroundClaims(personaId, personaId), src.server);
      if (listed.unavailable) return [];
      const byName = new Map<string, { name: string; description?: string; inputSchema?: unknown }>();
      for (const t of listed.tools) {
        const name = (t as { name?: unknown })?.name;
        if (typeof name !== "string") continue;
        const { description, inputSchema } = t as { description?: unknown; inputSchema?: unknown };
        byName.set(name, { name, ...(typeof description === "string" ? { description } : {}), ...(inputSchema !== undefined ? { inputSchema } : {}) });
      }
      const out: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
      for (const name of src.readTools) {
        const tool = byName.get(name);
        if (tool) {
          out.push(tool);
          continue;
        }
        const w = `${key(personaId, src.server)}\u0000${name}`;
        if (warned.has(w)) continue;
        warned.add(w);
        warn(`[proactive] watch "${src.server}": readTools names "${name}", which the server does not list — skipped`);
      }
      return out;
    },

    async read(personaId, server, tool, args, signal) {
      if (!allowed.get(key(personaId, server))?.has(tool)) {
        return { kind: "error", text: `${tool} is not a read tool of ${server}` };
      }
      const r = await bridge.call(backgroundClaims(personaId, personaId), server, tool, args, signal);
      const text = resultText(r);
      if (text === reauthText(server) || text === connectText(server)) return { kind: "needs-auth" };
      if (r.isError) return { kind: "error", text: redactSecrets(text) };
      return { kind: "ok", text: redactSecrets(text) };
    },
  };
}

/** Watched names a session would mount but the bridge does not serve (in mono
 *  a file-configured server is bridged only with the operator's opt-in). */
export function unservedWatches(watch: readonly string[], session: ExternalMcp, bridged: ExternalMcp): string[] {
  const served = oauthHttpServers(bridged.servers);
  return [...new Set(watch)].filter((n) => Object.hasOwn(session.servers, n) && !Object.hasOwn(served, n));
}
