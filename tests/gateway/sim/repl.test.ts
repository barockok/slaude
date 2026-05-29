import { describe, it, expect, afterEach } from "bun:test";
import { ReplController } from "../../../src/gateway/sim/repl";

let r: ReplController | undefined;
afterEach(async () => { await r?.dispose(); r = undefined; });

describe("REPL controller", () => {
  it("loads a scenario and reports state", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 5");
    expect(out.join("\n")).toContain("approval-flow");
    await r.handle("/state");
    expect(out.join("\n")).toContain("U0ALICE");
  });
  it("bare text sends and shows a card", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 1");      // manager-dm (DM, reply behavior)
    await r.handle("hello");
    await r.handle("/cards");
    expect(out.join("\n")).toContain("ack");
  });
});
