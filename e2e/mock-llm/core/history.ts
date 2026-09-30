import { messageText } from "./tag";
import type { HistoryView, MockRequest } from "./types";

const PERSONA_RE = /Persona-ID:\s*([A-Za-z0-9_-]+)/;

/**
 * Derive everything a scenario may know about the conversation from the request
 * alone. Tool results count only when they follow the current turn's tagged
 * user message, so a resumed thread starts each turn at phase zero.
 */
export function viewHistory(req: MockRequest, tagIndex: number): HistoryView {
  const toolResults: string[] = [];
  for (const m of req.messages.slice(tagIndex + 1)) {
    if (m.role === "tool") {
      toolResults.push(messageText(m));
    } else if (m.role === "user" && Array.isArray(m.content)) {
      for (const part of m.content) if (part.type === "tool_result") toolResults.push(part.text ?? "");
    }
  }
  const system = req.messages.filter((m) => m.role === "system").map(messageText).join("\n");
  return { toolResults, persona: PERSONA_RE.exec(system)?.[1] ?? null };
}
