import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { isErrorResponse } from "./skill-gate";

/** The surface's pass tool, as the CLI names it. */
export const PASS_TOOL = "mcp__slaude_surface__pass";

/**
 * PostToolUse: a successful `pass` ends the turn. The tool's result already
 * says so, but a live model read it as one more step: it kept calling tools
 * after passing, and in one turn posted a reminder minutes before the cron
 * job it had just scheduled. `continue: false` stops the agent loop in the
 * CLI, so passing is the end of the turn whatever the model does next.
 */
export function passEndsTurnHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    const i = input as { tool_name?: string; tool_response?: unknown };
    if (i.tool_name !== PASS_TOOL || isErrorResponse(i.tool_response)) return {};
    return { continue: false, stopReason: "passed" };
  };
}
