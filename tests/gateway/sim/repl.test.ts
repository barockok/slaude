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

  it("renders an approval gate as a bordered, numbered box", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 5");      // approval-flow (request_approval)
    await r.handle("please ship it");
    const o = out.join("\n");
    expect(o).toContain("╭");           // box border
    expect(o.toLowerCase()).toContain("approval");
    expect(o).toMatch(/1\.\s/);         // numbered option
  });

  it("/as <U> <text> sends a one-shot message as another user, preserving the actor", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 3");      // member-trusted, actor U0ALICE in C0TEAM
    await r.handle("/as U0BOB hey team");   // one-shot as Bob — actor must stay U0ALICE
    out.length = 0;
    await r.handle("/state");
    expect(out.join("\n")).toContain("U0ALICE");
  });

  it("/as <U> (no text) permanently switches the actor", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 3");
    await r.handle("/as U0BOB");
    out.length = 0;
    await r.handle("/state");
    expect(out.join("\n")).toContain("U0BOB");
  });

  it("onStatus hook is wired and clears (null) after a turn", async () => {
    r = new ReplController();
    const labels: Array<string | null> = [];
    r.onOutput(() => {});
    r.onStatus((l) => labels.push(l));
    await r.handle("/scenario 1");
    await r.handle("hello");
    // stub turns are synchronous; the last status must be a clear so the prompt returns clean.
    expect(labels[labels.length - 1] ?? null).toBeNull();
  });
});
