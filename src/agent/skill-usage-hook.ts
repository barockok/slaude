import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { skillUsageKey } from "../skills/usage";
import { isErrorResponse } from "./skill-gate";

/**
 * Records one use of a skill (spec §9.1): mono writes the database, a node
 * posts to the gateway. The persona is the session's; a node's gateway takes
 * it from the job token instead.
 */
export type SkillUsageRecorder = (sessionId: string, personaName: string | undefined, skill: string) => Promise<void>;

/**
 * PostToolUse: count a successful `Skill` call, keyed by the name as the CLI
 * resolved it (skillUsageKey). Fire-and-forget: the hook returns at once and a
 * failed record is logged, so counting never holds up or fails a turn.
 */
export function skillUsageHook(sessionId: string, personaName: string | undefined, recorder: () => SkillUsageRecorder | undefined): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    const i = input as { tool_name?: string; tool_input?: unknown; tool_response?: unknown };
    if (i.tool_name !== "Skill") return {};
    const rec = recorder();
    if (!rec) return {};
    const raw = (i.tool_input as { skill?: unknown } | null)?.skill;
    if (typeof raw !== "string" || isErrorResponse(i.tool_response)) return {};
    const key = skillUsageKey(raw);
    if (!key) return {};
    void rec(sessionId, personaName, key).catch((e) =>
      console.error(`[agent] session=${sessionId}: could not record a use of skill ${key}: ${e instanceof Error ? e.message : String(e)}`),
    );
    return {};
  };
}
