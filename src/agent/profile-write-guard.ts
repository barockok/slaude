import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { KB_SERVER, kbContract } from "../tools/contracts/kb";

/** kb_memoize as the CLI names it. */
export const KB_MEMOIZE_TOOL = `mcp__${KB_SERVER}__${kbContract.tools.kb_memoize.name}`;

export const SYNTHETIC_PROFILE_DENIAL = "A profile is written only on that person's own turn.";

/**
 * PreToolUse deny for a profile write during a turn the runtime injected (the
 * auto-evolve check, a continuation, a reload prompt): such a turn is not the
 * person's own words, although the job's origin still reads interactive
 * (invariant 2). Runs in the worker (mono and nodes alike), where the
 * synthetic flag lives; the gateway's gate checks the origin.
 */
export function denySyntheticProfileWrite(isSynthetic: () => boolean): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const i = input as { tool_name?: string; tool_input?: unknown };
    if (i.tool_name !== KB_MEMOIZE_TOOL) return {};
    if ((i.tool_input as { target?: unknown } | null)?.target !== "profile") return {};
    if (!isSynthetic()) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: SYNTHETIC_PROFILE_DENIAL,
      },
    };
  };
}
