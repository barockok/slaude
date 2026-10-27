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
import type { SourceReader } from "./source-reader";
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
  sources: Array<WatchedSource & { tools: Array<{ name: string; description?: string }> }>;
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

/** MCP tool names allow [A-Za-z0-9_-]; any other character in a server name becomes `_`. */
const toolNameFor = (server: string): string => "read_" + server.replace(/[^A-Za-z0-9_-]/g, "_");

function readTool(a: TriageToolArgs, state: TriageState, src: TriageToolArgs["sources"][number]): PassTool {
  const since = a.since[src.server];
  const sinceText = since == null ? "the last 24 hours" : new Date(since).toISOString();
  const allowed = src.readTools.filter((t) => src.tools.some((x) => x.name === t));
  return tool(
    toolNameFor(src.server),
    `Read "${src.server}" (read-only). Tools: ${allowed.join(", ")}. Look for items since ${sinceText}.`,
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
      const room = TRIAGE_MAX_BYTES_PER_SOURCE - used;
      const cut = r.text.length > room;
      state.bytes[src.server] = used + Math.min(r.text.length, room);
      return ok(cut ? r.text.slice(0, room) + `\n[truncated: ${src.server} read budget reached]` : r.text);
    },
  ) as unknown as PassTool;
}

/** The triage pass's tools: one `read_<server>` per source that has tools, `route_item`, `write_journal`. */
export function triageTools(a: TriageToolArgs, state: TriageState): PassTool[] {
  const watched = new Set(a.sources.map((s) => s.server));
  const reads = a.sources.filter((s) => s.readTools.some((t) => s.tools.some((x) => x.name === t))).map((s) => readTool(a, state, s));

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
