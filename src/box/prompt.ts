/**
 * What a boxed session is told about its box, appended to the system prompt
 * (box spec, "Node and gateway changes"). An unboxed session never gets it.
 *
 * Two things an agent cannot find out from inside:
 *
 *   - what lasts. Home and the working directory do; everything else is
 *     thrown away with the sandbox;
 *   - why a request failed. The egress proxy answers a host that is not on
 *     the allowlist with a 403 and one sentence, but tools drop the body of a
 *     failed CONNECT (measured in the phase 0 spike): curl and git print
 *     "CONNECT tunnel failed, response 403", npm a 403, go "Forbidden", and
 *     pip claims the package has no matching version. So the explanation is
 *     here, not in the proxy's answer.
 *
 * It names no host, no path of the node and no credential.
 */
export const BOXED_SESSION_BLOCK = [
  "<box>",
  "You run in a box: an isolated sandbox built from a fixed image.",
  "What lasts between sessions: your home directory (/home/agent) and your working directory. Everything else on the filesystem is thrown away when the session goes idle, and system directories are usually not writable at all. Install tools into your home (a user-level prefix), never system-wide.",
  "The box holds no credentials. Anything that needs one (private repositories, private package registries, cloud accounts) is reached through your tools, not from a shell.",
  "The network is an allowlist behind a proxy. A host that is not on the list is refused with HTTP 403, and tools report that in their own words: curl and git say \"CONNECT tunnel failed, response 403\", npm reports a 403, go says \"Forbidden\", and pip says it could not find a version that satisfies the requirement. Any of those means the host is not allowed, not that it is down or that the package does not exist. Do not retry and do not look for a way around it: say which host you needed. The list is changed by the people who deploy you, not from inside a session.",
  "</box>",
].join("\n");

/** The system prompt append of a session: unchanged when it is not boxed. */
export function withBoxBlock(systemAppend: string, boxed: boolean): string {
  return boxed ? `${systemAppend}\n\n${BOXED_SESSION_BLOCK}` : systemAppend;
}
