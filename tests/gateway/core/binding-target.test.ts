import { describe, expect, test } from "bun:test";
import { bindingFor } from "../../../src/gateway/core/gateway";
import type { SlackContext } from "../../../src/gateway/slack/mcp-tools";

function ctx(overrides: Partial<SlackContext>): SlackContext {
  return {
    client: {} as any,
    channel: "C123",
    threadTs: "T-THREAD",
    inboundTs: "I-INBOUND",
    userId: "U999",
    ...overrides,
  } as SlackContext;
}

describe("bindingFor postTarget", () => {
  test("channel target drops threadRef so replies post to channel root", () => {
    const b = bindingFor(ctx({ postTarget: "channel", threadTs: "T-THREAD" }));
    expect(b.threadRef).toBeUndefined();
  });

  test("thread target keeps threadRef so replies stay in-thread", () => {
    const b = bindingFor(ctx({ postTarget: "thread", threadTs: "T-THREAD" }));
    expect(b.threadRef).toBe("T-THREAD");
  });

  test("unset target (normal inbound) keeps threadRef", () => {
    const b = bindingFor(ctx({ postTarget: undefined, threadTs: "T-THREAD" }));
    expect(b.threadRef).toBe("T-THREAD");
  });
});
