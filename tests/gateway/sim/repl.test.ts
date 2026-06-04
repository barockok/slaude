import { describe, it, expect, afterEach } from "bun:test";
import { ReplController } from "../../../src/gateway/sim/repl";
import { AGENT_COMMANDS } from "../../../src/gateway/slack/commands";

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

  it("forwards an agent slash command (/1on1) to the gateway as a message", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 3");      // member-trusted channel (C0TEAM)
    await r.handle("/thread T1");
    await r.handle("/1on1");
    expect(out.join("\n")).toContain("1on1 mode");
  });

  it("/thread pins a thread so a thread-scoped lock survives across turns", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 3");
    await r.handle("/thread T1");
    await r.handle("/1on1");            // U0ALICE locks thread T1
    out.length = 0;
    await r.handle("/1on1 off");        // same actor + same thread → release
    expect(out.join("\n").toLowerCase()).toContain("released");
  });

  it("/help auto-derives the agent command list from commands.ts", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 1");
    out.length = 0;
    await r.handle("/help");
    const o = out.join("\n");
    for (const c of AGENT_COMMANDS) expect(o).toContain(c.usage);
  });

  it("rejects a genuine unknown slash (not an agent command)", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 1");
    await r.handle("/notacommand");
    expect(out.join("\n")).toContain("unknown command");
  });

  it("/as <role> resolves a role name to the soul's user id", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 3");      // WORLD soul: manager U0MGR, approver U0APP
    await r.handle("/as manager");
    out.length = 0;
    await r.handle("/state");
    expect(out.join("\n")).toContain("U0MGR");
    await r.handle("/as approver");
    out.length = 0;
    await r.handle("/state");
    expect(out.join("\n")).toContain("U0APP");
  });

  it("/as <role> <text> sends one message as that role, preserving the actor", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 3");      // actor U0ALICE
    await r.handle("/as outsider barging in");
    out.length = 0;
    await r.handle("/state");
    expect(out.join("\n")).toContain("U0ALICE");   // actor unchanged
  });

  it("/layer switches the channel zone", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 3");
    await r.handle("/layer allowed");
    out.length = 0;
    await r.handle("/state");
    const o = out.join("\n");
    expect(o).toContain("C0PUB");
    expect(o).toContain("dm=false");
  });

  it("/layer dm flips to a DM", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 3");
    await r.handle("/layer dm");
    out.length = 0;
    await r.handle("/state");
    expect(out.join("\n")).toContain("dm=true");
  });

  it("/budget on a stub session reports no usage (real-agent only)", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 1");
    out.length = 0;
    await r.handle("/budget");
    expect(out.join("\n").toLowerCase()).toMatch(/no .*usage|real.agent|stub/);
  });

  it("/sessions reports the live session count", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 1");
    out.length = 0;
    await r.handle("/sessions");
    expect(out.join("\n").toLowerCase()).toContain("session");
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
