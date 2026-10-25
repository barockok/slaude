import { describe, expect, it } from "bun:test";
import { denySyntheticProfileWrite, KB_MEMOIZE_TOOL, SYNTHETIC_PROFILE_DENIAL } from "../../src/agent/profile-write-guard";

const call = (hook: ReturnType<typeof denySyntheticProfileWrite>, input: Record<string, unknown>) =>
  hook({ hook_event_name: "PreToolUse", session_id: "s", transcript_path: "/t", cwd: "/w", ...input } as any, "tu", { signal: new AbortController().signal });

describe("denySyntheticProfileWrite", () => {
  it("names the tool the model sees", () => {
    expect(KB_MEMOIZE_TOOL).toBe("mcp__slaude_kb__kb_memoize");
  });

  it("denies a profile write on a synthetic turn", async () => {
    const out = await call(denySyntheticProfileWrite(() => true), { tool_name: KB_MEMOIZE_TOOL, tool_input: { target: "profile" } });
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: SYNTHETIC_PROFILE_DENIAL } });
  });

  it("passes a delivered turn, other targets, other tools and other events", async () => {
    expect(await call(denySyntheticProfileWrite(() => false), { tool_name: KB_MEMOIZE_TOOL, tool_input: { target: "profile" } })).toEqual({});
    const synthetic = denySyntheticProfileWrite(() => true);
    for (const tool_input of [{ target: "mine" }, { target: "shared" }, {}, null]) {
      expect(await call(synthetic, { tool_name: KB_MEMOIZE_TOOL, tool_input })).toEqual({});
    }
    expect(await call(synthetic, { tool_name: "mcp__slaude_kb__kb_delete_page", tool_input: { target: "profile" } })).toEqual({});
    expect(await synthetic({ hook_event_name: "PostToolUse", tool_name: KB_MEMOIZE_TOOL, tool_input: { target: "profile" } } as any, "tu", { signal: new AbortController().signal })).toEqual({});
  });
});
