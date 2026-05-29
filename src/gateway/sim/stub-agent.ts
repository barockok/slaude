import { AgentManager, type McpResolver, type AgentEvent } from "../../agent/manager";
import type { GatewayHandle, SessionMcpCtx } from "../core/gateway";
import { slackHandlers } from "../slack/mcp-tools";
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
    emit({ type: "toolCall", sessionId, tool: "mcp__slaude_slack__reply", input: {} });
    await slackHandlers.reply(ctx.slack, { text: "ack: done" });
  },
  async request_approval({ ctx, emit, sessionId }) {
    if (!ctx) throw new Error("request_approval behavior: no session ctx");
    emit({ type: "toolCall", sessionId, tool: "mcp__slaude_slack__request_approval", input: {} });
    const res = await slackHandlers.request_approval(ctx.slack, { summary: "deploy prod", risks: "irreversible" });
    await slackHandlers.reply(ctx.slack, { text: res.content[0]!.text });
  },
  async connect_borrow({ ctx, emit, sessionId, envelope }) {
    if (!ctx?.connect) throw new Error("connect_borrow behavior: no broker ctx (SLAUDE_ENCRYPTION_KEY unset?)");
    const onBehalf = userIdFromEnvelope(envelope);
    emit({ type: "toolCall", sessionId, tool: "mcp__slaude_connect__mcp_call", input: {} });
    const res = await brokerHandlers.mcp_call(ctx.connect, { service: "jira", tool: "jira_search", args: { jql: "assignee=currentUser()" }, on_behalf_of: onBehalf });
    await slackHandlers.reply(ctx.slack, { text: res.content[0]!.text });
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

  async drain(): Promise<void> {
    await this.#running;
    await new Promise((r) => setTimeout(r, 0));
  }
}
