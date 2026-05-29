/**
 * Strip secrets that must never reach the SDK child or any subprocess it spawns.
 * Kept in its own module so it can be unit-tested without loading the whole
 * AgentManager (which would otherwise drag untested manager code into coverage).
 */
export function scrubChildEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const { SLAUDE_ENCRYPTION_KEY, ...rest } = env;
  return rest;
}
