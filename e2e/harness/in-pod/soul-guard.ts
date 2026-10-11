// Decides whether the persona seed may replace $SLAUDE_HOME/SOUL.md. Pure (no imports), so it
// is unit tested on the host (e2e/harness/soul-guard.test.ts) and copied into the gateway pod
// next to seed-persona.ts, which imports it.

export type SoulKind = "absent" | "e2e" | "starter" | "operator";

/**
 * Markers that only the UNEDITED starter persona carries. They mirror STARTER_PERSONA in
 * src/soul/loader.ts (private there), which the gateway writes to an absent SOUL.md at boot:
 * its title line, the identity placeholder, and two approver placeholders. The unit test reads
 * that constant out of the loader source, so a change there fails the test instead of silently
 * turning the starter into an "operator" soul.
 */
export const STARTER_MARKERS = [
  "- Name: <agent display name>",
  "- <@security-id>:",
  "- <@channel-lead-id>:",
] as const;

/** What kind of SOUL.md this is; `null` means the file does not exist. */
export function classifySoul(text: string | null): SoulKind {
  if (text === null) return "absent";
  if (/^Persona-ID:/m.test(text)) return "e2e";
  if (text.startsWith("# Persona\n") && STARTER_MARKERS.every((m) => text.includes(m))) return "starter";
  return "operator";
}

/**
 * Why the seed must not run, or null when it may. Checked before anything is written: the seed
 * needs SLAUDE_E2E_SEED=1, and it replaces only an absent file, an e2e soul (one it wrote) or the
 * gateway's untouched starter; an operator's soul needs SLAUDE_E2E_SEED_FORCE=1 as well.
 */
export function seedRefusal(kind: SoulKind, env: Record<string, string | undefined>, soulPath: string): string | null {
  if (env.SLAUDE_E2E_SEED !== "1") return "refusing to run: set SLAUDE_E2E_SEED=1 (this overwrites SOUL.md)";
  if (kind === "operator" && env.SLAUDE_E2E_SEED_FORCE !== "1") {
    return `refusing to replace ${soulPath}: it is neither an e2e soul (no Persona-ID line) nor the untouched starter persona (SLAUDE_E2E_SEED_FORCE=1 overrides)`;
  }
  return null;
}
