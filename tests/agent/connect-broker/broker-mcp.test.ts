import { describe, it, expect } from "bun:test";
import { brokerHandlers, type BrokerToolCtx } from "../../../src/agent/connect-broker/broker-mcp";

function ctx(over: Partial<BrokerToolCtx> = {}): BrokerToolCtx {
  return {
    runCall: async () => ({ kind: "ok", result: { hits: 3 } }),
    listConnections: () => [{ service: "jira", owner: "U1", mine: true, expiresInMs: 3600_000 }],
    startConnect: async () => ({ url: "https://live/abc", expiresInMs: 600_000 }),
    revoke: () => ({ revoked: 1 }),
    describe: async () => ({ tools: [{ name: "jira_search" }] }),
    callerUserId: "U1",
    ...over,
  } as BrokerToolCtx;
}

describe("brokerHandlers", () => {
  it("mcp_call returns the child result as JSON on ok", async () => {
    const res = await brokerHandlers.mcp_call(ctx(), { service: "jira", tool: "jira_search", args: { jql: "x" }, on_behalf_of: "U1" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("hits");
  });

  it("mcp_call surfaces a needs_connect hint", async () => {
    const res = await brokerHandlers.mcp_call(ctx({ runCall: async () => ({ kind: "needs_connect" }) }), { service: "jira", tool: "jira_search", args: {}, on_behalf_of: "U1" });
    expect(res.content[0]!.text.toLowerCase()).toContain("connect");
  });

  it("mcp_call denies when on_behalf_of != the turn's caller", async () => {
    const res = await brokerHandlers.mcp_call(ctx({ callerUserId: "U1" }), { service: "jira", tool: "jira_search", args: {}, on_behalf_of: "U2" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/on_behalf_of/i);
  });

  it("connections_list renders the caller's connections", async () => {
    const res = await brokerHandlers.connections_list(ctx(), {});
    expect(res.content[0]!.text).toContain("jira");
  });

  it("connect renders the one-time login URL", async () => {
    const res = await brokerHandlers.connect(ctx(), { service: "jira" });
    expect(res.content[0]!.text).toContain("https://live/abc");
  });
});
