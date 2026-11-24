/**
 * boxd holds nothing. It refuses to start when its environment carries any
 * credential a node or a gateway uses, so a manifest that gives the privileged
 * container the node's `envFrom` or a Secret fails loudly at boot instead of
 * quietly putting secrets next to every sandbox.
 *
 * Checked by NAME, and only names are ever reported:
 *   - everything the agent's child may not hold (src/agent/child-env.ts): the
 *     gateway's secrets, the node token, the Redis URL, the registry pull
 *     credential, embedding keys;
 *   - every provider-selecting name and family (src/agent/provider-env.ts):
 *     ANTHROPIC_*, the CLAUDE_CODE_* provider families, AWS_*;
 *   - the object store's settings (SLAUDE_S3_*).
 */
import { isChildScrubbedEnv } from "../../agent/child-env";
import { PROVIDER_ENV_KEYS, PROVIDER_SELECTING_ENV_NAMES, PROVIDER_SELECTING_ENV_PREFIXES } from "../../agent/provider-env";

const EXTRA_PREFIXES: readonly string[] = ["SLAUDE_S3_"];

/** Whether boxd may not start with this name set. */
export function isBoxdRefusedEnv(name: string): boolean {
  if (isChildScrubbedEnv(name)) return true;
  if ((PROVIDER_ENV_KEYS as readonly string[]).includes(name) || PROVIDER_SELECTING_ENV_NAMES.includes(name)) return true;
  if (PROVIDER_SELECTING_ENV_PREFIXES.some((p) => name.startsWith(p))) return true;
  return EXTRA_PREFIXES.some((p) => name.startsWith(p));
}

/** The refused names set (non-empty) in `env`, sorted. Never a value. */
export function boxdRefusedEnv(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((k) => isBoxdRefusedEnv(k) && (env[k] ?? "") !== "")
    .sort();
}
