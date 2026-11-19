/**
 * Reload a session wherever it runs. The gateway's own AgentManager only holds the sessions it booted;
 * with a node queue the live query is in a worker's manager, so a local reload of that session answers
 * false. Then the request is published for the node (it reloads when its turn ends, or at its next claim).
 *
 * Returns true when the session was reloaded here or a reload was requested from its node. A publish that
 * fails is logged and still reported as requested: the caller is synchronous and the reload is best effort.
 */
export function routeReload(
  local: (sessionId: string, prompt?: string) => boolean,
  remote: ((sessionId: string, prompt?: string) => Promise<void>) | null,
  sessionId: string,
  prompt?: string,
): boolean {
  if (local(sessionId, prompt)) return true;
  if (!remote) return false;
  remote(sessionId, prompt).catch((e: unknown) => {
    console.error(`[gateway] reload request for session=${sessionId} was not published: ${e instanceof Error ? e.message : String(e)}`);
  });
  return true;
}
