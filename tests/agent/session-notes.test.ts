import { describe, expect, test } from "bun:test";
import { formatSessionNotes, makeSessionNotesHook } from "../../src/agent/session-notes";

const submit = { hook_event_name: "UserPromptSubmit" } as any;

describe("formatSessionNotes", () => {
  test("empty → null", () => {
    expect(formatSessionNotes([])).toBeNull();
  });
  test("wraps notes in a <session-events> block", () => {
    const b = formatSessionNotes(["Connected MCP server `workbench`.", "Model changed to `opus`."]);
    expect(b).toContain("<session-events>");
    expect(b).toContain("- Connected MCP server `workbench`.");
    expect(b).toContain("- Model changed to `opus`.");
    expect(b).toContain("</session-events>");
  });
});

describe("makeSessionNotesHook", () => {
  test("non-UserPromptSubmit events pass through", async () => {
    const hook = makeSessionNotesHook(() => ["x"]);
    const r = await hook({ hook_event_name: "Stop" } as any, "t", { signal: new AbortController().signal });
    expect(r).toEqual({ continue: true });
  });

  test("drains queued notes into additionalContext, then nothing", async () => {
    let q = ["Connected MCP server `workbench`."];
    const take = () => { const n = q; q = []; return n; };
    const hook = makeSessionNotesHook(take);
    const first: any = await hook(submit, "t", { signal: new AbortController().signal });
    expect(first.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(first.hookSpecificOutput.additionalContext).toContain("Connected MCP server `workbench`.");
    // second turn: queue drained → plain continue
    const second: any = await hook(submit, "t", { signal: new AbortController().signal });
    expect(second).toEqual({ continue: true });
  });
});
