export interface MockContentPart {
  type: string;
  text?: string;
}

/** The subset of aimock's normalized chat message the scenarios read. */
export interface MockMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | MockContentPart[] | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface MockRequest {
  messages: MockMessage[];
  /** Tools the client offers (aimock's normalized OpenAI shape). */
  tools?: Array<{ type?: string; function?: { name?: string } }>;
}

export interface Tag {
  name: string;
  params: Record<string, string>;
}

export interface ToolCallSpec {
  /** Deterministic id, derived from the request, never from server state. */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type MockReply =
  | { kind: "text"; content: string; reasoning?: string }
  | { kind: "tools"; calls: ToolCallSpec[] };

/** What a scenario may learn from the conversation so far. */
export interface HistoryView {
  /** Text of each tool result since the current turn's tagged user message. */
  toolResults: string[];
  /** Value of the `Persona-ID:` line in the system prompt, if any. */
  persona: string | null;
  /** Names of the tools the request offers. */
  tools: string[];
}

export interface ScenarioCtx {
  tag: Tag;
  view: HistoryView;
  /** The tagged user message with every tag removed. */
  userText: string;
}

export interface Scenario {
  name: string;
  reply(ctx: ScenarioCtx): MockReply;
}
