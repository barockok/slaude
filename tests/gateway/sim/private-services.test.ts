import { describe, it, expect, afterEach } from "bun:test";
import { SimSession } from "../../../src/gateway/sim/engine";

let s: SimSession | undefined;
afterEach(async () => { await s?.dispose(); s = undefined; });

describe("/1on1 reloads the session so the resolver re-evaluates privacy", () => {
  it("calls agent.reload on lock and on release", async () => {
    s = await SimSession.create({ agent: "stub", layer: "trusted", as: "member" });
    s.thread = "T1";                       // pin to one thread so the lock applies
    const calls: string[] = [];
    const orig = s.agent.reload.bind(s.agent);
    s.agent.reload = (id: string) => { calls.push(id); return orig(id); };

    await s.send({ text: "/1on1" });        // lock
    await s.send({ as: "U0MGR", text: "/1on1 off", thread: "T1" }); // manager releases

    // Exactly two: one reboot on lock, one on release. No other reload path fires
    // during these slash-only sends (the agent never runs), so this is precise.
    expect(calls.length).toBe(2);
  });
});
