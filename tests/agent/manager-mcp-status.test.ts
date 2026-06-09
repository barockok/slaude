import { describe, it, expect } from "bun:test";
import { AgentManager } from "../../src/agent/manager";

describe("AgentManager.mcpServerStatus", () => {
  it("returns null when the session is not live", async () => {
    const mgr = new AgentManager();
    expect(await mgr.mcpServerStatus("no-such-session")).toBeNull();
  });
});
