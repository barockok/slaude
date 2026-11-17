// Decides whether the persona seed may replace $SLAUDE_HOME/agent.yaml. Pure (no imports), so it
// is unit tested on the host (e2e/harness/soul-guard.test.ts) and copied into the gateway pod
// next to seed-persona.ts, which imports it.

export type SoulKind = "absent" | "e2e" | "starter" | "operator";

/**
 * Markers that only the UNEDITED starter agent.yaml carries. They mirror STARTER_AGENT_YAML in
 * src/persona/disk-check.ts, which the gateway writes to a bare home at boot: its modeline-free
 * header comment and the description placeholder. The unit test checks them against that
 * constant, so a change there fails the test instead of silently turning the starter into an
 * "operator" file.
 */
export const STARTER_MARKERS = [
  "# The default persona. Fill in who manages it before going live",
  'description: "<one line, what this agent is for>"',
] as const;

/** What kind of agent.yaml this is; `null` means the file does not exist. */
export function classifySoul(text: string | null): SoulKind {
  if (text === null) return "absent";
  if (/^\s*Persona-ID:/m.test(text)) return "e2e";
  if (STARTER_MARKERS.every((m) => text.includes(m))) return "starter";
  return "operator";
}

/**
 * Why the seed must not run, or null when it may. Checked before anything is written: the seed
 * needs SLAUDE_E2E_SEED=1, and it replaces only an absent file, an e2e file (one it wrote) or the
 * gateway's untouched starter; an operator's file needs SLAUDE_E2E_SEED_FORCE=1 as well.
 */
export function seedRefusal(kind: SoulKind, env: Record<string, string | undefined>, soulPath: string): string | null {
  if (env.SLAUDE_E2E_SEED !== "1") return "refusing to run: set SLAUDE_E2E_SEED=1 (this overwrites agent.yaml)";
  if (kind === "operator" && env.SLAUDE_E2E_SEED_FORCE !== "1") {
    return `refusing to replace ${soulPath}: it is neither an e2e file (no Persona-ID line) nor the untouched starter agent.yaml (SLAUDE_E2E_SEED_FORCE=1 overrides)`;
  }
  return null;
}
