/**
 * env:// backend: a PERSONA_* variable from the gateway's own environment.
 * The name rule is checked again here so a caller that skipped parseRef can
 * still never read the gateway's own secrets (master key, tokens, provider keys).
 */
import { SecretResolutionError } from "./errors";
import { PERSONA_VAR_RE } from "./persona-var";

export function createEnvBackend(env: Record<string, string | undefined>) {
  return {
    read(name: string): string {
      if (!PERSONA_VAR_RE.test(name)) {
        throw new SecretResolutionError("env_missing", "env:// names must start with PERSONA_");
      }
      const v = env[name];
      // Empty counts as missing: an empty credential is a silent outage.
      if (v === undefined || v === "") {
        throw new SecretResolutionError("env_missing", "env:// variable is unset or empty");
      }
      return v;
    },
  };
}
