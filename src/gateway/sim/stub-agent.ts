import { AgentManager, type McpResolver, type AgentEvent } from "../../agent/manager";
import type { GatewayHandle, SessionMcpCtx } from "../core/gateway";
import { brokerHandlers } from "../../agent/connect-broker/broker-mcp";

export interface BehaviorArgs {
  sessionId: string;
  envelope: string;
  ctx?: SessionMcpCtx;
  emit: (e: AgentEvent) => void;
}
export type Behavior = (a: BehaviorArgs) => Promise<void>;

function userIdFromEnvelope(envelope: string): string {
  return envelope.match(/user_id="([^"]+)"/)?.[1] ?? "unknown";
}

export const BEHAVIORS: Record<string, Behavior> = {
  async reply({ ctx, emit, sessionId }) {
    if (!ctx) throw new Error("reply behavior: no session ctx");
    emit({ type: "toolCall", sessionId, tool: "mcp__slaude_surface__reply", input: {} });
    await ctx.surface.reply({ text: "ack: done" });
  },
  async request_approval({ ctx, emit, sessionId }) {
    if (!ctx) throw new Error("request_approval behavior: no session ctx");
    emit({ type: "toolCall", sessionId, tool: "mcp__slaude_surface__request_approval", input: {} });
    const r = await ctx.surface.requestApproval({ summary: "deploy prod", risks: "irreversible" });
    await ctx.surface.reply({ text: r.approved ? `approved by <@${r.by}>` : `denied by <@${r.by}>${r.note ? ` (${r.note})` : ""}` });
  },
  async connect_borrow({ ctx, emit, sessionId, envelope }) {
    if (!ctx?.connect) throw new Error("connect_borrow behavior: no broker ctx (SLAUDE_ENCRYPTION_KEY unset?)");
    const onBehalf = userIdFromEnvelope(envelope);
    emit({ type: "toolCall", sessionId, tool: "mcp__slaude_connect__mcp_call", input: {} });
    const res = await brokerHandlers.mcp_call(ctx.connect, { service: "jira", tool: "jira_search", args: { jql: "assignee=currentUser()" }, on_behalf_of: onBehalf });
    await ctx.surface.reply({ text: res.content[0]!.text });
  },
  // Throws → StubAgent emits an error event → gateway error handler posts a warning.
  async boom() { throw new Error("simulated failure"); },
  // Emits varied tool-call + compacting events (exercises humanizeToolStatus + compacting),
  // then replies so the turn produces a visible card.
  async events({ ctx, emit, sessionId }) {
    if (!ctx) throw new Error("events behavior: no session ctx");
    emit({ type: "toolCall", sessionId, tool: "Bash", input: { command: "ls -la" } });
    emit({ type: "toolCall", sessionId, tool: "Read", input: { file_path: "/tmp/x.txt" } });
    emit({ type: "toolCall", sessionId, tool: "Grep", input: { pattern: "foo" } });
    emit({ type: "compacting", sessionId, trigger: "auto" });
    await ctx.surface.reply({ text: "ack: events done" });
  },
  // Emits additional tool types to exercise more humanizeToolStatus branches.
  async events2({ ctx, emit, sessionId }) {
    if (!ctx) throw new Error("events2 behavior: no session ctx");
    emit({ type: "toolCall", sessionId, tool: "Write", input: { file_path: "/tmp/out.txt" } });
    emit({ type: "toolCall", sessionId, tool: "Edit", input: { file_path: "/tmp/edit.txt" } });
    emit({ type: "toolCall", sessionId, tool: "MultiEdit", input: { file_path: "/tmp/multi.txt" } });
    emit({ type: "toolCall", sessionId, tool: "NotebookEdit", input: {} });
    emit({ type: "toolCall", sessionId, tool: "Glob", input: { pattern: "*.ts" } });
    emit({ type: "toolCall", sessionId, tool: "LS", input: { path: "/tmp" } });
    emit({ type: "toolCall", sessionId, tool: "TodoWrite", input: {} });
    emit({ type: "toolCall", sessionId, tool: "WebFetch", input: { url: "https://example.com" } });
    emit({ type: "toolCall", sessionId, tool: "WebSearch", input: { query: "test query" } });
    emit({ type: "toolCall", sessionId, tool: "Task", input: {} });
    emit({ type: "toolCall", sessionId, tool: `mcp__slaude_surface__edit`, input: {} });
    emit({ type: "toolCall", sessionId, tool: `mcp__slaude_surface__upload`, input: { path: "/tmp/file.txt" } });
    emit({ type: "toolCall", sessionId, tool: `mcp__slaude_surface__react`, input: { name: "thumbsup" } });
    emit({ type: "toolCall", sessionId, tool: `mcp__slaude_surface__request_approval`, input: {} });
    emit({ type: "toolCall", sessionId, tool: `mcp__slaude_surface__get_history`, input: {} });
    emit({ type: "toolCall", sessionId, tool: `mcp__slaude_slack__get_user_profile`, input: {} });
    emit({ type: "toolCall", sessionId, tool: `mcp__slaude_slack__get_channel_info`, input: {} });
    emit({ type: "toolCall", sessionId, tool: `mcp__slaude_slack__list_users_in_channel`, input: {} });
    emit({ type: "toolCall", sessionId, tool: `mcp__slaude_slack__search_messages`, input: {} });
    emit({ type: "toolCall", sessionId, tool: `mcp__some_server__some_tool`, input: {} });
    emit({ type: "toolCall", sessionId, tool: `plain_tool`, input: {} });
    emit({ type: "compacting", sessionId, trigger: "manual" });
    await ctx.surface.reply({ text: "ack: events2 done" });
  },
};

export class StubAgent extends AgentManager {
  #resolverLocal?: McpResolver;
  #behavior = "reply";
  #handle?: GatewayHandle;
  #running?: Promise<void>;
  #errors: string[] = [];

  override setMcpResolver(resolver: McpResolver | undefined) {
    super.setMcpResolver(resolver);
    this.#resolverLocal = resolver;
  }
  setBehavior(name: string) { this.#behavior = name; }
  attachGateway(h: GatewayHandle) { this.#handle = h; }
  lastError(): string | undefined { return this.#errors.at(-1); }

  override async sendMessage(sessionId: string, envelope: string): Promise<void> {
    this.#resolverLocal?.(sessionId);
    const ctx = this.#handle?.__sessionCtx(sessionId);
    const beh = BEHAVIORS[this.#behavior];
    const emit = (e: AgentEvent) => this.emit("event", e);
    this.#running = (async () => {
      try {
        if (!beh) throw new Error(`unknown sim behavior: ${this.#behavior}`);
        await beh({ sessionId, envelope, ctx, emit });
        emit({ type: "done", sessionId });
      } catch (e) {
        this.#errors.push(String(e instanceof Error ? e.message : e));
        emit({ type: "error", sessionId, error: String(e) });
      }
    })();
  }

  /** Let a detached behavior post its initial card(s), then return. Deliberately
   *  does NOT await #running: request_approval / connect_borrow behaviors park on
   *  an approval decision that only resolves on a later feedAction, so awaiting
   *  here would deadlock send(). Errors thrown before the first await are captured
   *  synchronously into #errors; post-await errors surface on the next drain. */
  async drain(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }
}
