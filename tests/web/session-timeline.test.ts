/**
 * The console's session timeline model (TimelineTab buildItems): tool results
 * pair with their call by tool_use id, the agent's reply tools show as its
 * messages with where they went, Slack messages show, and earlier turns map
 * from the history route. Also the header's activity and context meter.
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../src/gateway/panel/api-types";
import {
  buildItems, contextLabel, deliveryOf, historyItems, sessionActivityNow, turnRunning, type StreamEntry, type TimelineItem,
} from "../../src/web/console/pages/session/timeline-model";

const S = "s1";
/** A SessionEvent without its sessionId (distributed over the union). */
type Ev = SessionEvent extends unknown ? (SessionEvent extends infer E ? (E extends unknown ? Omit<E, "sessionId"> : never) : never) : never;
let n = 0;
const entries = (events: Ev[]): StreamEntry[] =>
  events.map((e) => ({ id: `e${++n}`, at: 1000 + n, event: { sessionId: S, ...e } as SessionEvent }));
const build = (events: Ev[]) => buildItems(entries(events), [], [], "scout");
const tools = (items: TimelineItem[]) => items.filter((i): i is Extract<TimelineItem, { kind: "tool" }> => i.kind === "tool");
const texts = (items: TimelineItem[]) => items.filter((i): i is Extract<TimelineItem, { kind: "text" }> => i.kind === "text");

describe("tool call and result pairing", () => {
  test("by tool_use id, whatever order the results come in", () => {
    const items = build([
      { type: "toolCall", tool: "Bash", input: { command: "a" }, toolUseId: "tu_a" },
      { type: "toolCall", tool: "Bash", input: { command: "b" }, toolUseId: "tu_b" },
      { type: "toolResult", tool: "Bash", result: { stdout: "B" }, toolUseId: "tu_b" },
      { type: "toolResult", tool: "Bash", result: { stdout: "A" }, toolUseId: "tu_a" },
    ]);
    const t = tools(items);
    expect(t.map((x) => [(x.input as { command: string }).command, (x.result as { stdout: string }).stdout])).toEqual([["a", "A"], ["b", "B"]]);
    expect(items.some((i) => i.kind === "result")).toBe(false);
  });

  test("older events without ids: the oldest open call (results named no tool)", () => {
    const items = build([
      { type: "toolCall", tool: "Read", input: { file_path: "x" } },
      { type: "toolCall", tool: "Bash", input: { command: "ls" } },
      { type: "toolResult", tool: "", result: "file x" },
      { type: "toolResult", tool: "", result: { stdout: "listing" } },
    ]);
    const t = tools(items);
    expect(t[0]!.result).toBe("file x");
    expect(t[1]!.result).toEqual({ stdout: "listing" });
  });

  test("a result whose call happened before the page opened stays on its own", () => {
    const items = build([{ type: "toolResult", tool: "Bash", result: "late", toolUseId: "tu_gone" }]);
    expect(items.map((i) => i.kind)).toEqual(["result"]);
  });
});

describe("the agent's replies", () => {
  test("a reply tool call is the agent's message, held in the console while an operator drives", () => {
    const items = build([
      { type: "turnStart" },
      { type: "toolCall", tool: "mcp__slaude_surface__reply", input: { text: "Here is the answer." }, toolUseId: "tu_r" },
      { type: "toolResult", tool: "mcp__slaude_surface__reply", result: [{ type: "text", text: "posted ref=panel-suppressed" }], toolUseId: "tu_r" },
      { type: "done" },
    ]);
    const t = texts(items);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ who: "agent", name: "scout", text: "Here is the answer.", delivery: "held" });
    expect(tools(items)).toHaveLength(0); // no raw tool row
  });

  test("sending until the result, then sent to Slack; post_message names its channel; a refused post is not sent", () => {
    const pending = build([{ type: "toolCall", tool: "mcp__slaude_surface__reply", input: { text: "On it." }, toolUseId: "p1" }]);
    expect(texts(pending)[0]!.delivery).toBe("sending");
    const items = build([
      { type: "toolCall", tool: "mcp__slaude_surface__reply", input: { text: "Done." }, toolUseId: "r1" },
      { type: "toolResult", tool: "mcp__slaude_surface__reply", result: [{ type: "text", text: "posted ref=1762500000.000100" }], toolUseId: "r1" },
      { type: "toolCall", tool: "mcp__slaude_slack__post_message", input: { channel: "COPS", text: "Heads up." }, toolUseId: "r2" },
      { type: "toolResult", tool: "mcp__slaude_slack__post_message", result: "posted", toolUseId: "r2" },
      { type: "toolCall", tool: "mcp__slaude_runtime__proactive_post", input: { text: "Nightly summary." }, toolUseId: "r3" },
      { type: "toolResult", tool: "mcp__slaude_runtime__proactive_post", result: [{ type: "text", text: '{"refused":true,"rule":"quiet-hours"}' }], toolUseId: "r3" },
    ]);
    expect(texts(items).map((t) => [t.text, t.delivery, t.target])).toEqual([
      ["Done.", "slack", undefined],
      ["Heads up.", "slack", "COPS"],
      ["Nightly summary.", "failed", undefined],
    ]);
    expect(deliveryOf({ is_error: true, content: "boom" })).toBe("failed");
  });

  test("a Slack message delivered to the session shows as the sender's", () => {
    const items = build([{ type: "userMessage", userId: "UALICE", userName: "alice", text: "is the deploy done?", at: 5 }]);
    expect(texts(items)[0]).toMatchObject({ who: "user", name: "alice", text: "is the deploy done?" });
    const anon = build([{ type: "userMessage", userId: "UBOB", text: "hi", at: 5 }]);
    expect(texts(anon)[0]!.name).toBe("UBOB");
  });
});

describe("earlier turns, activity and the context meter", () => {
  test("history lines become earlier messages", () => {
    const items = historyItems([{ at: 1, who: "user", name: "alice", text: "q" }, { at: 1, who: "agent", text: "a" }], "scout");
    expect(items.map((i) => [i.who, i.name, i.text, i.earlier])).toEqual([["user", "alice", "q", true], ["agent", "scout", "a", true]]);
  });

  test("the live tail's newest turn boundary decides working", () => {
    expect(turnRunning(entries([{ type: "turnStart" }, { type: "toolCall", tool: "Bash", input: {} }]))).toBe(true);
    expect(turnRunning(entries([{ type: "turnStart" }, { type: "done" }, { type: "done", autoEvolve: true }]))).toBe(false);
    expect(turnRunning(entries([]))).toBeUndefined();
    const detail = (activity: "working" | "warm" | "idle") => ({ activity });
    expect(sessionActivityNow(detail("warm"), true)).toBe("working");
    expect(sessionActivityNow(detail("working"), false)).toBe("warm");
    expect(sessionActivityNow(detail("idle"), undefined)).toBe("idle");
    expect(sessionActivityNow(undefined, undefined)).toBe("idle");
  });

  test("the meter stops at 100% and shows the token count", () => {
    expect(contextLabel({ pctUsed: 2.38, totalInput: 476_000 })).toBe("Context 100% used (476,000 tokens)");
    expect(contextLabel({ pctUsed: 0.354, totalInput: 70_800 })).toBe("Context 35% used (70,800 tokens)");
  });
});
