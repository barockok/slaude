import { describe, it, expect, afterEach } from "bun:test";
import { SimSession } from "../../../src/gateway/sim/engine";
import { StubAgent } from "../../../src/gateway/sim/stub-agent";

const FLAG = "SLAUDE_ENABLE_CONNECT_BROKER";
let s: SimSession | undefined;
afterEach(async () => { await s?.dispose(); s = undefined; delete process.env[FLAG]; });

describe("connect-broker feature flag", () => {
  it("OFF → slaude_connect is not mounted (connect_borrow finds no broker ctx)", async () => {
    // Set the flag off BEFORE create; the engine's `??=` keeps this explicit value.
    process.env[FLAG] = "0";
    s = await SimSession.create({ layer: "trusted", as: "outsider", behavior: "connect_borrow", agent: "stub" });
    await s.send({ as: "U0BOB", channel: "C0TEAM", thread: "T1", text: "list my jira" });
    // Broker disabled → resolver never builds a connect ctx → the connect_borrow
    // behavior throws "no broker ctx", captured by StubAgent.
    const err = (s.agent as StubAgent).lastError?.();
    expect(err).toContain("no broker ctx");
  });

  it("ON → slaude_connect is mounted (connect_borrow reaches the broker, replies)", async () => {
    process.env[FLAG] = "1";
    s = await SimSession.create({ layer: "trusted", as: "outsider", behavior: "connect_borrow", agent: "stub" });
    await s.send({ as: "U0BOB", channel: "C0TEAM", thread: "T1", text: "list my jira" });
    // Broker enabled → mcp_call runs → needs-connect hint mentioning the service.
    expect(s.cards().some((c) => (c.text ?? "").includes("jira"))).toBe(true);
  });
});
