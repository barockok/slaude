import { describe, it, expect } from "bun:test";
import { disengagedHookDecision, makeDisengageSuppressHook, makeUserPromptHook } from "../../src/agent/manager";
import { db } from "../../src/db/schema";
import * as Sessions from "../../src/db/sessions";
import { metrics } from "../../src/metrics";

// The UserPromptSubmit hook keeps a disengaged thread's transcript populated
// without running the model. `continue:false` (NOT `decision:"block"`) is the
// load-bearing choice: verified against the pinned SDK, block discards the
// prompt before it persists, whereas continue:false persists then halts.
describe("disengagedHookDecision", () => {
  it("suppresses (continue:false) when the thread is disengaged", () => {
    const d = disengagedHookDecision({ engaged: 0 });
    expect(d.continue).toBe(false);
    expect(d.suppressOutput).toBe(true);
    expect(d.stopReason).toContain("disengaged");
  });

  it("passes through (continue:true) when the thread is engaged", () => {
    const d = disengagedHookDecision({ engaged: 1 });
    expect(d.continue).toBe(true);
    expect(d.suppressOutput).toBeUndefined();
  });

  it("passes through when there is no session row", () => {
    expect(disengagedHookDecision(null).continue).toBe(true);
  });

  it("never uses decision:block (would discard the prompt pre-persist)", () => {
    const d = disengagedHookDecision({ engaged: 0 }) as Record<string, unknown>;
    expect(d.decision).toBeUndefined();
  });
});

// The live hook reads engagement via Sessions.findById each turn (not closed
// over), so a re-@mention takes effect on the very next message, and bumps the
// suppression metric when it halts.
describe("makeDisengageSuppressHook (live hook)", () => {
  let seq = 0;
  const mkSession = (engaged: number) => {
    const row = Sessions.createForThread({
      thread: { team_id: "T", channel_id: "C", thread_ts: `hk.${seq++}` },
      model: "",
      working_dir: "/tmp",
    });
    Sessions.setEngaged(row.id, engaged === 1);
    return row.id;
  };
  const suppressedCount = () => {
    const line = metrics
      .render()
      .split("\n")
      .find((l) => l.startsWith("slaude_disengaged_suppressed_total ") || l.startsWith("slaude_disengaged_suppressed_total{"));
    return line ? Number(line.trim().split(/\s+/).pop()) : 0;
  };

  it("disengaged session → continue:false and bumps the suppressed metric", async () => {
    db.run("DELETE FROM sessions");
    const id = mkSession(0);
    const before = suppressedCount();
    const d = (await makeDisengageSuppressHook(id)({ hook_event_name: "UserPromptSubmit" } as any, undefined as any, {} as any)) as { continue: boolean };
    expect(d.continue).toBe(false);
    expect(suppressedCount()).toBe(before + 1);
  });

  it("engaged session → continue:true, metric unchanged", async () => {
    const id = mkSession(1);
    const before = suppressedCount();
    const d = (await makeDisengageSuppressHook(id)({ hook_event_name: "UserPromptSubmit" } as any, undefined as any, {} as any)) as { continue: boolean };
    expect(d.continue).toBe(true);
    expect(suppressedCount()).toBe(before);
  });

  it("non-UserPromptSubmit event passes through untouched", async () => {
    const id = mkSession(0); // disengaged, but the event isn't a prompt submit
    const d = (await makeDisengageSuppressHook(id)({ hook_event_name: "PreCompact" } as any, undefined as any, {} as any)) as { continue: boolean };
    expect(d.continue).toBe(true);
  });
});

describe("makeUserPromptHook (disengage + drain queued notes)", () => {
  let seq = 0;
  const mkSession = (engaged: number) => {
    const row = Sessions.createForThread({
      thread: { team_id: "T", channel_id: "C", thread_ts: `up.${seq++}` },
      model: "",
      working_dir: "/tmp",
    });
    Sessions.setEngaged(row.id, engaged === 1);
    return row.id;
  };
  const submit = { hook_event_name: "UserPromptSubmit" } as any;
  const run = (id: string, notes: Map<string, string[]>) =>
    makeUserPromptHook(id, notes)(submit, undefined as any, {} as any);

  it("non-UserPromptSubmit event passes through", async () => {
    const r = (await makeUserPromptHook("x", new Map())({ hook_event_name: "Stop" } as any, undefined as any, {} as any)) as any;
    expect(r).toEqual({ continue: true });
  });

  it("disengaged → continue:false, notes left queued (not drained)", async () => {
    const id = mkSession(0);
    const notes = new Map([[id, ["Model changed to `x`."]]]);
    const r = (await run(id, notes)) as { continue: boolean };
    expect(r.continue).toBe(false);
    expect(notes.get(id)).toEqual(["Model changed to `x`."]); // preserved
  });

  it("engaged with queued notes → drains once into additionalContext", async () => {
    const id = mkSession(1);
    const notes = new Map([[id, ["Connected MCP server `wb`."]]]);
    const r1 = (await run(id, notes)) as any;
    expect(r1.hookSpecificOutput.additionalContext).toContain("Connected MCP server `wb`.");
    expect(notes.get(id)).toEqual([]); // drained
    const r2 = (await run(id, notes)) as any; // nothing left
    expect(r2).toEqual({ continue: true });
  });

  it("engaged, no notes → plain continue", async () => {
    const id = mkSession(1);
    const r = (await run(id, new Map())) as any;
    expect(r).toEqual({ continue: true });
  });
});
