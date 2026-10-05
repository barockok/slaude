/**
 * Hardening for the git commands slaude runs itself (KB checkpoint commits,
 * skill and KB pushes, ingest). Some of them run in a repository on the
 * shared, node-writable volume, in the gateway process: a hook, an fsmonitor
 * command or an sshCommand an agent turn planted in that repository's config
 * would otherwise run with the gateway's environment.
 *
 *   - hooks and fsmonitor are switched off on the command line (higher
 *     precedence than any repository config);
 *   - the environment is scrubbed: no gateway-only variable, no provider
 *     credential (the child-scrub list plus the provider-selecting names);
 *   - a purely local command also blanks core.sshCommand and gets a minimal
 *     environment, since it never talks to a remote.
 */
import { scrubChildEnv, withoutKeys } from "../agent/child-env";
import { providerSelectingNames } from "../agent/provider-env";

/** For every git command slaude runs. */
export const GIT_SAFE_ARGS: readonly string[] = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="];
/** For a git command that never contacts a remote. */
export const GIT_LOCAL_ARGS: readonly string[] = [...GIT_SAFE_ARGS, "-c", "core.sshCommand="];
/** `git` plus GIT_SAFE_ARGS, for shell command strings. */
export const SAFE_GIT = `git ${GIT_SAFE_ARGS.join(" ")}`;

/** The environment for a git command that may contact a remote (credential
 *  helpers in HOME, an SSH agent) without the gateway's secrets. */
export function gitEnv(src: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return { ...withoutKeys(scrubChildEnv(src), providerSelectingNames(src)), GIT_TERMINAL_PROMPT: "0" };
}

/** The environment for a purely local git command: just enough to run. */
export function localGitEnv(src: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG"]) if (src[k] !== undefined) out[k] = src[k];
  return out;
}
