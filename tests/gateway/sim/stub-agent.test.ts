import { describe, it, expect } from "bun:test";
import { StubAgent } from "../../../src/gateway/sim/stub-agent";
import type { SessionMcpCtx } from "../../../src/gateway/core/gateway";

describe("StubAgent", () => {
  it("runs the 'reply' behavior, calling the real slack reply handler via ctx", async () => {
    const posted: any[] = [];
    const ctx: SessionMcpCtx = {
      slack: { client: { chat: { postMessage: async (a: any) => { posted.push(a); return { ts: "1.1" }; } } } as any, channel: "C1", threadTs: "1.0", inboundTs: "1.0", userId: "U1", teamId: "T1" },
    };
    const agent = new StubAgent();
    agent.attachGateway({ start: async () => {}, stop: async () => {}, __sessionCtx: () => ctx });
    agent.setMcpResolver(() => ({}));
    agent.setBehavior("reply");
    const events: any[] = [];
    agent.on("event", (e) => events.push(e));
    await agent.sendMessage("S1", "<channel>hi</channel>");
    await agent.drain();
    expect(posted[0].channel).toBe("C1");
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("captures an unknown behavior as an error", async () => {
    const agent = new StubAgent();
    agent.attachGateway({ start: async () => {}, stop: async () => {}, __sessionCtx: () => undefined });
    agent.setMcpResolver(() => ({}));
    agent.setBehavior("nope");
    await agent.sendMessage("S1", "x");
    await agent.drain();
    expect(agent.lastError()).toContain("unknown sim behavior: nope");
  });
});
