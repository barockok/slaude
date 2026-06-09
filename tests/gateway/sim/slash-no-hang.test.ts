import { describe, it, expect, afterEach } from "bun:test";
import { SimSession } from "../../../src/gateway/sim/engine";

// Regression: in the real-agent sim, send() armed a turn promise that resolved
// only on a done/error AgentEvent, a gate card, or a 180s timeout fallback.
// Gateway slash commands (/1on1, /mode, /ignore, …) are handled inline and never
// run the agent, so none of those events fire — send() blocked the full 180s.
let s: SimSession | undefined;
afterEach(async () => { await s?.dispose(); s = undefined; });

describe("real-agent sim: gateway slash commands don't wait on the agent-turn timeout", () => {
  it("/1on1 resolves promptly (no LLM turn, so no done event)", async () => {
    s = await SimSession.create({ agent: "real", layer: "trusted", as: "member" });
    s.thread = "T1"; // pin so the thread-scoped lock applies

    const start = performance.now();
    await s.send({ text: "/1on1" }); // slash → gateway locks + replies; agent never runs
    const ms = performance.now() - start;

    expect(ms).toBeLessThan(5000); // bug: ~180_000ms
    expect(s.cards().some((c) => /1on1/i.test(c.text ?? ""))).toBe(true);
  }, 15000);
});
