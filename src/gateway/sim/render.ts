import type { AgentEvent } from "../../agent/manager";
import type { OutboundCard } from "./transport";

/** Pure string formatters for the claude-code-style sim REPL. No I/O, no state — given an
 *  event/card/text, return the line(s) to show. term.ts owns where they land on screen. */

// claude-code-ish pulsing spinner frames.
export const SPINNER_FRAMES = ["·", "✢", "✳", "∗", "✻", "✽"];

export function shortTool(tool: string): string {
  const i = tool.lastIndexOf("__");
  return i >= 0 ? tool.slice(i + 2) : tool;
}

export function isReplyTool(tool: string): boolean {
  return tool.endsWith("__reply") || tool === "reply";
}

function summarizeInput(input: unknown): string {
  const o = (input ?? {}) as Record<string, any>;
  const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.query ?? o.url ?? o.prompt ?? o.text;
  const s = pick !== undefined ? String(pick) : JSON.stringify(o);
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

/** `⏺ Bash(ls -la)` — tool call with a one-glance arg summary. */
export function toolLine(tool: string, input: unknown): string {
  return `⏺ ${shortTool(tool)}(${summarizeInput(input)})`;
}

/** `  ⎿ first line…` — the tool result, indented under its call, first line only. */
export function resultLine(result: unknown): string {
  let s = typeof result === "string" ? result : JSON.stringify(result);
  if (!s) return "  ⎿ (empty)";
  s = s.split("\n")[0]!.trim();
  if (!s) return "  ⎿ (empty)";
  return `  ⎿ ${s.length > 100 ? s.slice(0, 97) + "…" : s}`;
}

/** `⏺ <reply text>` — assistant reply, claude-code bullet. */
export function replyLine(text: string): string {
  return `⏺ ${text.trim()}`;
}

export function errorLine(err: string): string {
  return `⚠ ${err}`;
}

/** Live status label for the bottom spinner region, or null when an event needs no label. */
export function statusLabel(e: AgentEvent): string | null {
  switch (e.type) {
    case "thinking": return "Thinking…";
    case "assistantText": return "Writing…";
    case "toolCall": return isReplyTool(e.tool) ? "Writing…" : `${shortTool(e.tool)}…`;
    default: return null;   // toolResult / done / error
  }
}

/** A bordered, numbered approval/permission box — claude-code-style gate prompt. */
export function gateBox(card: OutboundCard): string {
  const verbs = card.actionIds.map((a) => a.split(":")[1]).filter(Boolean) as string[];
  const title = card.kind === "approval" ? "Approval needed" : "Permission needed";
  // Permission cards name the tool in backticks; approval cards carry a plan/ask in their
  // text — strip Slack emoji + the redundant "Approval needed:" prefix to get the subject.
  const subject = card.text?.match(/`([^`]+)`/)?.[1]
    ?? card.text?.replace(/:[a-z_]+:/g, "").replace(/^\s*\**(approval|permission)\s+needed:?\**\s*/i, "").trim();
  const tool = subject && subject.length ? subject : (card.kind === "approval" ? "this action" : "tool");
  const keyFor = (v: string) => (/always/.test(v) ? "A" : /allow|approve|yes/.test(v) ? "a" : /deny|reject|no/.test(v) ? "d" : v[0] ?? "?");
  const opts = verbs.map((v, i) => `   ${i + 1}. ${v}  (${keyFor(v)})`);
  const head = `${title}: ${shortTool(tool)}`;
  const width = Math.max(head.length, ...opts.map((o) => o.length)) + 2;
  const bar = "─".repeat(width);
  const pad = (s: string) => `│ ${s}${" ".repeat(Math.max(0, width - s.length - 1))}│`;
  return [`╭${bar}╮`, pad(head), pad(""), ...opts.map(pad), `╰${bar}╯`].join("\n");
}
