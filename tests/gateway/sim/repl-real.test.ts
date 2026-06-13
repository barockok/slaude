import { describe, it, expect, afterEach } from "bun:test";
import { ReplController } from "../../../src/gateway/sim/repl";
import { AgentManager } from "../../../src/agent/manager";
import { SimTransport } from "../../../src/gateway/sim/transport";
import { db } from "../../../src/db/schema";

// Real-agent mode wires ReplController's live render path (#renderEvent/#renderCard) to the
// AgentManager event stream. No LLM is called: we capture the manager + transport instances
// created inside startDefault() via temporary prototype hooks, then emit synthetic events.

let r: ReplController | undefined;
afterEach(async () => { await r?.dispose(); r = undefined; });

async function startReal(repl: ReplController): Promise<{ mgr: AgentManager; transport: SimTransport }> {
  const hadOwnOn = Object.getOwnPropertyDescriptor(AgentManager.prototype, "on");
  const protoOn = (AgentManager.prototype as any).on;
  const protoOnCard = SimTransport.prototype.onCard;
  let mgr: AgentManager | undefined;
  let transport: SimTransport | undefined;
  (AgentManager.prototype as any).on = function (...a: unknown[]) { mgr ??= this; return protoOn.apply(this, a); };
  SimTransport.prototype.onCard = function (cb) { transport ??= this; return protoOnCard.call(this, cb); };
  try {
    await repl.startDefault();
  } finally {
    if (hadOwnOn) (AgentManager.prototype as any).on = protoOn;
    else delete (AgentManager.prototype as any).on;
    SimTransport.prototype.onCard = protoOnCard;
  }
  if (!mgr || !transport) throw new Error("failed to capture real-agent internals");
  return { mgr, transport };
}

describe("REPL controller — real-agent live render", () => {
  it("renders agent events claude-code style and serves /budget /memory /sessions + abort", async () => {
    r = new ReplController("real");
    const out: string[] = [];
    const statuses: Array<string | null> = [];
    r.onOutput((l) => out.push(l));
    r.onStatus((s) => statuses.push(s));
    const { mgr, transport } = await startReal(r);
    const sid = "S1";
    const emit = (e: Record<string, unknown>) => mgr.emit("event", e);

    // assistant text → ⏺ bullet + "Writing…" status
    emit({ type: "assistantText", sessionId: sid, text: "  hello world  " });
    expect(out.at(-1)).toBe("⏺ hello world");
    expect(statuses.at(-1)).toBe("Writing…");

    // thinking → dim ✻ line; whitespace-only thinking is skipped
    emit({ type: "thinking", sessionId: sid, text: " deep   thought " });
    expect(out.at(-1)).toContain("✻ deep thought");
    const len1 = out.length;
    emit({ type: "thinking", sessionId: sid, text: "   " });
    expect(out.length).toBe(len1);

    // tool call → ⏺ Tool(arg) + tool status; result → ⎿ first line with elapsed
    emit({ type: "toolCall", sessionId: sid, tool: "Bash", input: { command: "ls -la" } });
    expect(out.at(-1)).toBe("⏺ Bash(ls -la)");
    expect(statuses.at(-1)).toBe("Bash…");        // no token snapshot yet → undecorated
    emit({ type: "toolResult", sessionId: sid, tool: "Bash", result: "file1\nfile2" });
    expect(out.at(-1)).toContain("⎿ file1");
    expect(out.at(-1)).toContain("s)");           // elapsed suffix from the FIFO start time
    // a result with no recorded start → no elapsed suffix
    emit({ type: "toolResult", sessionId: sid, tool: "Grep", result: { ok: true } });
    expect(out.at(-1)).toContain("⎿ {\"ok\":true}");
    expect(out.at(-1)).not.toContain("s)");

    // reply tool dedups against the last assistant text; empty reply input is skipped
    emit({ type: "assistantText", sessionId: sid, text: "same text" });
    const len2 = out.length;
    emit({ type: "toolCall", sessionId: sid, tool: "mcp__slaude_surface__reply", input: { text: "same text" } });
    expect(out.length).toBe(len2);                // deduped
    emit({ type: "toolCall", sessionId: sid, tool: "mcp__slaude_surface__reply", input: {} });
    expect(out.length).toBe(len2);                // empty text skipped
    emit({ type: "toolCall", sessionId: sid, tool: "mcp__slaude_surface__reply", input: { text: "fresh reply" } });
    expect(out.at(-1)).toBe("⏺ fresh reply");
    const len3 = out.length;
    emit({ type: "toolResult", sessionId: sid, tool: "mcp__slaude_surface__reply", result: "ok" });
    expect(out.length).toBe(len3);                // reply-tool results are not echoed

    // done without a token snapshot → no usage line; error → ⚠ line
    emit({ type: "done", sessionId: sid });
    expect(out.length).toBe(len3);
    emit({ type: "error", sessionId: sid, error: "kaboom" });
    expect(out.at(-1)).toBe("⚠ kaboom");

    // with a token snapshot: statuses decorate with % ctx, done prints the usage line
    (mgr as any).getTokenSnapshot = () => ({
      inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 10, cacheCreationInputTokens: 5,
      totalInput: 16000, contextWindow: 200000, pctUsed: 0.08, remaining: 184000,
    });
    emit({ type: "toolCall", sessionId: sid, tool: "Read", input: { file_path: "/tmp/x" } });
    expect(statuses.at(-1)).toBe("Read… · 8% ctx");
    emit({ type: "done", sessionId: sid });
    expect(out.at(-1)).toContain("% ctx");

    // /budget renders the full budget view from the live snapshot
    out.length = 0;
    await r.handle("/budget");
    expect(out.join("\n")).toContain("context:");
    expect(out.join("\n")).toContain("tokens:");

    // /sessions includes the current session id; /memory hits the provider (empty here)
    out.length = 0;
    await r.handle("/sessions");
    expect(out.join("\n")).toContain(`current ${sid}`);
    // prefetch() surfaces process-wide global facts (scope='global') plus this
    // session's turns. Other suites in the same bun process leave global facts in
    // the shared store, so clear them to make the empty-memory branch deterministic.
    db.run("DELETE FROM memory_facts");
    db.run("DELETE FROM memory_turns WHERE session_id = ?", [sid]);
    out.length = 0;
    await r.handle("/memory");
    expect(out.join("\n")).toContain("no memory stored");

    // Esc-driven abort routes to the agent with the live session id
    const aborted: string[] = [];
    (mgr as any).abort = (id: string) => { aborted.push(id); };
    r.abort();
    expect(aborted).toEqual([sid]);

    // an unresolved permission card prints as a gate box and pauses the spinner;
    // a plain message card is skipped (already covered by the event stream)
    await (transport.client as any).chat.postMessage({
      channel: "D0SIM",
      text: "Permission needed: `Bash`",
      blocks: [{ type: "actions", elements: [
        { action_id: "slaude_perm:allow:x" }, { action_id: "slaude_perm:always:x" }, { action_id: "slaude_perm:deny:x" },
      ] }],
    });
    const gateOut = out.join("\n");
    expect(gateOut).toContain("Permission needed");
    expect(gateOut).toContain("╭");
    expect(statuses.at(-1)).toBeNull();
    const len4 = out.length;
    await (transport.client as any).chat.postMessage({ channel: "D0SIM", text: "plain message" });
    expect(out.length).toBe(len4);
  });
});
