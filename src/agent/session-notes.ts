import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

/**
 * Out-of-band session events (gate commands the gateway runs without the model:
 * `/mcp connect`, `/mcp disconnect`, `/model`) that the cloud session would
 * otherwise never see. They're queued per session and delivered once, as
 * `additionalContext` on the next real user turn, so they land in the timeline
 * without a synthetic model run. "If it hasn't yet" = drained exactly once.
 */
export function formatSessionNotes(notes: string[]): string | null {
  if (notes.length === 0) return null;
  return ["<session-events>", ...notes.map((n) => `- ${n}`), "</session-events>"].join("\n");
}

/** UserPromptSubmit hook that drains queued notes into the turn's context. `take`
 *  returns the pending notes AND clears them (so they deliver exactly once). */
export function makeSessionNotesHook(take: () => string[]): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "UserPromptSubmit") return { continue: true };
    const block = formatSessionNotes(take());
    if (!block) return { continue: true };
    return {
      continue: true,
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block },
    };
  };
}
