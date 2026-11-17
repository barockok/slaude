/**
 * The heartbeat round's triage tools (heartbeat round spec §4), mounted on the
 * locked-down `slaude_pass` server for the triage pass. Triage reads the
 * watched sources, routes what it found and drafts a journal; it never writes
 * the brain or posts. Everything it produces lands in a {@link TriageState}
 * the round reads afterwards, and the round's code writes the journal page.
 */
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { redactSecrets } from "../gateway/core/status-text";
import type { BrainOpCall } from "../knowledge/memory-trail";
import type { PassTool } from "../background/runner";
import { parseLevel, type Level } from "./levels";
import { JOURNAL_MAX_CHARS } from "./rules";
import type { SourceReader, SourceTool } from "./source-reader";
import type { WatchedSource } from "./sources";

export const TRIAGE_MAX_READS = 20;
export const TRIAGE_MAX_BYTES_PER_SOURCE = 65536;
export const TRIAGE_MAX_ITEMS = 30;

export interface RoutedItem {
  source: string;
  itemId: string;
  kind: string;
  /** A channel id, a user id, or "none". */
  destination: string;
  proposedLevel: Level;
  ruleSlug?: string;
  summary: string;
  evidence: string;
}

export interface TriageState {
  items: RoutedItem[];
  readCalls: number;
  bytes: Record<string, number>;
  needsAuth: Set<string>;
  failed: Set<string>;
  journal: string | null;
}

export interface TriageToolArgs {
  personaId: string;
  agentId: string;
  sources: Array<WatchedSource & { tools: SourceTool[] }>;
  reader: SourceReader;
  /** Per server: epoch ms of the last round that read it, or null. */
  since: Record<string, number | null>;
  /** Kept for the round's wiring; no triage tool writes through it. */
  call: BrainOpCall;
  now: () => Date;
  signal?: AbortSignal;
}

const DESTINATION = /^[CG][A-Z0-9]+$|^[UW][A-Z0-9]+$|^none$/;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text: redactSecrets(text) }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text: redactSecrets(text) }], isError: true });

/** Once per message per process: a clash is boot-time config, not per-round news. */
const warned = new Set<string>();
const warnOnce = (m: string): void => {
  if (warned.has(m)) return;
  warned.add(m);
  console.warn(m);
};

/** MCP tool names allow [A-Za-z0-9_-]; any other character in a server name becomes `_`. */
const toolNameFor = (server: string): string => "read_" + server.replace(/[^A-Za-z0-9_-]/g, "_");

/** Per read tool, at most this much of its description and of its input schema (JSON) goes into `read_<server>`'s description. */
const TOOL_DESC_MAX = 400;
const TOOL_SCHEMA_MAX = 1200;
/** The whole `read_<server>` description. */
const READ_DESC_MAX = 3600;
const cap = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1) + "…" : s);

/** One line per read tool: its upstream description and input schema, redacted and capped (both are upstream text). */
function toolLines(tools: TriageToolArgs["sources"][number]["tools"], allowed: readonly string[]): string {
  return allowed
    .map((name) => {
      const t = tools.find((x) => x.name === name);
      const desc = t?.description ? cap(redactSecrets(t.description.replace(/\s+/g, " ").trim()), TOOL_DESC_MAX) : "";
      let schema = "";
      try {
        schema = t?.inputSchema !== undefined ? cap(redactSecrets(JSON.stringify(t.inputSchema)), TOOL_SCHEMA_MAX) : "";
      } catch {
        schema = "";
      }
      return `- ${name}${desc ? `: ${desc}` : ""}${schema ? `\n  input schema: ${schema}` : ""}`;
    })
    .join("\n");
}

function readTool(a: TriageToolArgs, state: TriageState, src: TriageToolArgs["sources"][number]): PassTool {
  const since = a.since[src.server];
  const sinceText = since == null ? "the last 24 hours" : new Date(since).toISOString();
  const allowed = src.readTools.filter((t) => src.tools.some((x) => x.name === t));
  const head = `Read "${src.server}" (read-only). Look for items since ${sinceText}. Pass the tool's name as \`tool\` and its arguments, matching its input schema, as \`args\`. Tools:\n`;
  return tool(
    toolNameFor(src.server),
    cap(head + toolLines(src.tools, allowed), READ_DESC_MAX),
    { tool: z.enum(allowed as [string, ...string[]]), args: z.record(z.string(), z.unknown()) },
    async (x: { tool: string; args: Record<string, unknown> }) => {
      if (state.readCalls >= TRIAGE_MAX_READS) return err(`Read limit reached (${TRIAGE_MAX_READS}). Route what you have.`);
      const used = state.bytes[src.server] ?? 0;
      if (used >= TRIAGE_MAX_BYTES_PER_SOURCE) return err(`Read budget for ${src.server} is used up. Route what you have.`);
      state.readCalls++;
      const r = await a.reader.read(a.personaId, src.server, x.tool, x.args, a.signal);
      if (r.kind === "needs-auth") {
        state.needsAuth.add(src.server);
        return ok(`${src.server} is not connected right now; skip it this round.`);
      }
      if (r.kind === "error") {
        state.failed.add(src.server);
        return err(`${src.server} read failed: ${r.text}`);
      }
      // The source answered; this call failed (most often its arguments). The source is not failed.
      if (r.kind === "tool-error") return err(`${x.tool} failed: ${r.text}. Check the tool's arguments against its input schema.`);
      // Re-read after the await: parallel reads in one turn all passed the check above.
      const now = state.bytes[src.server] ?? 0;
      const room = TRIAGE_MAX_BYTES_PER_SOURCE - now;
      if (room <= 0) return err(`Read budget for ${src.server} is used up. Route what you have.`);
      const cut = r.text.length > room;
      state.bytes[src.server] = now + Math.min(r.text.length, room);
      return ok(cut ? r.text.slice(0, room) + `\n[truncated: ${src.server} read budget reached]` : r.text);
    },
  ) as unknown as PassTool;
}

/** The triage pass's tools: one `read_<server>` per source that has tools, `route_item`, `write_journal`. */
export function triageTools(a: TriageToolArgs, state: TriageState): PassTool[] {
  const watched = new Set(a.sources.map((s) => s.server));
  // Two servers whose names sanitise alike would mount two tools of one name,
  // which the pass's MCP server refuses: the first keeps it, the second is skipped.
  const names = new Map<string, string>();
  const reads: PassTool[] = [];
  for (const s of a.sources.filter((s) => s.readTools.some((t) => s.tools.some((x) => x.name === t)))) {
    const name = toolNameFor(s.server);
    const first = names.get(name);
    if (first !== undefined) {
      warnOnce(`[proactive] watch "${s.server}": its read tool would be ${name}, which "${first}" already has; skipped (rename one of the servers)`);
      continue;
    }
    names.set(name, s.server);
    reads.push(readTool(a, state, s));
  }

  const route = tool(
    "route_item",
    "Route one item you found: where it belongs and how far to take it. Routing again with the same source and itemId replaces the earlier entry.",
    {
      source: z.string().describe('A watched server name, or "memory".'),
      itemId: z.string(),
      kind: z.string().describe("A few words: what sort of item this is."),
      destination: z.string().describe('A channel id, a user id, or "none".'),
      proposedLevel: z.enum(["ignore", "inform", "ask", "act"]),
      ruleSlug: z.string().optional().describe("The rule page this follows, if any."),
      summary: z.string(),
      evidence: z.string().describe("The page slug or link the item rests on."),
    },
    async (x: Omit<RoutedItem, "proposedLevel"> & { proposedLevel: string }) => {
      if (!DESTINATION.test(x.destination)) return err('destination must be a channel id, a user id, or "none".');
      if (x.source !== "memory" && !watched.has(x.source)) return err(`source must be "memory" or one of: ${[...watched].join(", ")}.`);
      const level = parseLevel(x.proposedLevel);
      if (!level) return err("proposedLevel must be ignore, inform, ask or act.");
      const item: RoutedItem = { ...x, proposedLevel: level };
      const at = state.items.findIndex((i) => i.source === x.source && i.itemId === x.itemId);
      if (at < 0 && state.items.length >= TRIAGE_MAX_ITEMS) return err(`At most ${TRIAGE_MAX_ITEMS} items per round.`);
      if (at >= 0) state.items[at] = item;
      else state.items.push(item);
      return ok(`routed (${state.items.length} so far)`);
    },
  ) as unknown as PassTool;

  const journal = tool(
    "write_journal",
    `Draft this round's journal (at most ${JOURNAL_MAX_CHARS} characters): what you looked at, what you routed, what you skipped. Calling it again replaces the draft.`,
    { body: z.string() },
    async (x: { body: string }) => {
      if (x.body.length > JOURNAL_MAX_CHARS) return err(`Journal is ${x.body.length} characters; the limit is ${JOURNAL_MAX_CHARS}. Shorten it.`);
      state.journal = x.body;
      return ok("journal saved");
    },
  ) as unknown as PassTool;

  return [...reads, route, journal];
}
