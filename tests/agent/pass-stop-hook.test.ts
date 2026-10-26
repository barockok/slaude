import { describe, expect, test } from "bun:test";
import { PASS_TOOL, passEndsTurnHook } from "../../src/agent/pass-stop-hook";

const run = (input: Record<string, unknown>) =>
  passEndsTurnHook()({ hook_event_name: "PostToolUse", ...input } as never, undefined, { signal: new AbortController().signal });

describe("pass ends the turn", () => {
  test("a successful pass stops the agent loop", async () => {
    expect(await run({ tool_name: PASS_TOOL, tool_response: [{ type: "text", text: "passed." }] })).toEqual({ continue: false, stopReason: "passed" });
  });

  test("a failed pass, another tool or another event leaves the turn running", async () => {
    expect(await run({ tool_name: PASS_TOOL, tool_response: { is_error: true } })).toEqual({});
    expect(await run({ tool_name: "mcp__slaude_surface__reply", tool_response: "posted" })).toEqual({});
    expect(await passEndsTurnHook()({ hook_event_name: "PreToolUse", tool_name: PASS_TOOL } as never, undefined, { signal: new AbortController().signal })).toEqual({});
  });
});
