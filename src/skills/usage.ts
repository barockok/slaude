/**
 * Skill usage keys and best-effort recording (spec §9.1). A use is a
 * successful `Skill` tool call (counted by the agent manager's PostToolUse
 * hook) or a `/<slug>` invocation in Slack (counted by the gateway). Mono and
 * the gateway write the database directly; a node posts to
 * /v1/background/skill-usage. Never on a turn's critical path: a failure is
 * logged, never thrown.
 */
import { paths } from "../config/home";
import * as SkillUsage from "../db/skill-usage";
import { cliPluginName, cliSkillName } from "../soul/builtin";
import { normaliseSkillName } from "../agent/skill-gate";
import { redactSecrets } from "../gateway/core/status-text";
import type { Skill } from "./loader";

/** Longest usage key accepted (a plugin name, ":", a skill name). */
export const SKILL_KEY_MAX = 200;
const KEY_RE = /^[^\s\u0000-\u001f\u007f]+$/;

/**
 * The usage key for a skill name as the Skill tool received it: trimmed, one
 * leading "/" removed (as the CLI resolves it), and the $SLAUDE_HOME plugin's
 * `<name>:` prefix dropped, so an agent skill is keyed by its bare name.
 * Other plugins' prefixes (built-in `slaude:` among them) stay. Null for a
 * name that is empty, too long or carries whitespace or control characters.
 */
export function skillUsageKey(raw: string, homePlugin: string = cliPluginName(paths.home)): string | null {
  let n = normaliseSkillName(raw);
  if (homePlugin && n.startsWith(`${homePlugin}:`)) n = n.slice(homePlugin.length + 1);
  if (!n || n.length > SKILL_KEY_MAX || !KEY_RE.test(n)) return null;
  return n;
}

/** The usage keys a skill in a skills root answers to: its slug and its CLI name. */
export function usageKeysOf(skill: Pick<Skill, "slug" | "name">): string[] {
  return [...new Set([skill.slug, cliSkillName(skill.name)])];
}

/** Record one use; logged on failure, never thrown. */
export async function recordSkillUse(agentId: string, key: string, at: number = Date.now()): Promise<void> {
  try {
    await SkillUsage.record(agentId, key, at);
  } catch (e) {
    console.error(`[skills] could not record a use of ${key} for agent=${agentId}: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
  }
}
