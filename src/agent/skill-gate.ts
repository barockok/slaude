import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { builtinGoverning, listBuiltinSkills } from "../soul/builtin";
import { isSkillAllowed } from "./skill-allow";

interface GateState {
  /** The boot mounted the built-in plugin; no enforcement otherwise. */
  mounted: boolean;
  /** Qualified built-in names (`slaude:<name>`) loaded since the last boot. */
  loaded: Set<string>;
  /** The agent's skill list as Skill tool names; absent: no list (every skill). */
  allowed?: ReadonlySet<string>;
}

/** A Skill tool response that reports an error: an `is_error` object, or the
 *  CLI's error text ("Error…" or a `<tool_use_error>` wrapper). */
export function isErrorResponse(r: unknown): boolean {
  if (typeof r === "string") return r.startsWith("Error") || r.includes("<tool_use_error>");
  return typeof r === "object" && r !== null && (r as { is_error?: unknown }).is_error === true;
}

/** The skill name as the bundled CLI resolves it: trimmed, then one leading
 *  "/" removed (its Skill tool accepts "/slaude:x" and " slaude:x " as
 *  "slaude:x"). Matching the raw input would miss a load the CLI accepted and
 *  deny the governed tool forever. */
export function normaliseSkillName(raw: string): string {
  const n = raw.trim();
  return n.startsWith("/") ? n.slice(1) : n;
}

/**
 * Blocks a tool a built-in skill governs until the session has loaded that
 * skill (a successful `Skill` call with skill "slaude:<name>"). State is per
 * session id and cleared on every (re)boot, so a fresh CLI process — which has
 * not seen the skill's text — must load it again. `<runtime-check>` turns are
 * not exempt. A session whose boot did not mount the built-in plugin is never
 * enforced: it could not load the skill.
 */
export class SkillGate {
  #state = new Map<string, GateState>();

  reset(sessionId: string): void {
    this.#state.set(sessionId, { mounted: false, loaded: new Set() });
  }

  markMounted(sessionId: string, mounted: boolean): void {
    const s = this.#state.get(sessionId);
    if (s) s.mounted = mounted;
    else this.#state.set(sessionId, { mounted, loaded: new Set() });
  }

  /** Limit a session to these skills (null: no limit). Cleared by reset, so set after it. */
  setAllowedSkills(sessionId: string, names: readonly string[] | null): void {
    const s = this.#state.get(sessionId);
    if (s) s.allowed = names ? new Set(names) : undefined;
  }

  /** Drop a session's state when its live session ends. */
  forget(sessionId: string): void {
    this.#state.delete(sessionId);
  }

  /** Sessions with state (for tests: the map must not grow without bound). */
  get size(): number {
    return this.#state.size;
  }

  isLoaded(sessionId: string, qualified: string): boolean {
    return this.#state.get(sessionId)?.loaded.has(qualified) ?? false;
  }

  pre(sessionId: string): HookCallback {
    return async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const s = this.#state.get(sessionId);
      if (s?.allowed && (input as { tool_name?: string }).tool_name === "Skill") {
        const raw = ((input as { tool_input?: unknown }).tool_input as { skill?: unknown } | null)?.skill;
        const name = typeof raw === "string" ? normaliseSkillName(raw) : "";
        if (!isSkillAllowed(name, s.allowed)) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "deny" as const,
              permissionDecisionReason: `The skill "${name}" is not in this agent's skill list.`,
            },
          };
        }
      }
      if (!s?.mounted) return {};
      const skill = builtinGoverning((input as { tool_name?: string }).tool_name ?? "");
      if (!skill || s.loaded.has(skill.qualified)) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: `Load \`${skill.qualified}\` first (call the Skill tool with skill "${skill.qualified}"), then retry.`,
        },
      };
    };
  }

  post(sessionId: string): HookCallback {
    return async (input) => {
      if (input.hook_event_name !== "PostToolUse") return {};
      const i = input as { tool_name?: string; tool_input?: unknown; tool_response?: unknown };
      if (i.tool_name !== "Skill") return {};
      const raw = (i.tool_input as { skill?: unknown } | null)?.skill;
      if (typeof raw !== "string") return {};
      const name = normaliseSkillName(raw);
      if (!listBuiltinSkills().some((b) => b.qualified === name)) return {};
      if (isErrorResponse(i.tool_response)) return {};
      this.#state.get(sessionId)?.loaded.add(name);
      return {};
    };
  }
}
