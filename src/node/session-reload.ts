import type { PubSub } from "../queue/pubsub";

/** The slice of AgentManager a node uses to reload a session. */
export interface ReloadableAgent {
  reloadAfterTurn(sessionId: string, prompt?: string): boolean;
}

/**
 * For the length of a turn: a reload published for this session closes its query when the turn ends
 * (at once if it is idle), so the next turn boots fresh with newly resolved MCPs, plugins and skills.
 * Servicing it also consumes the durable flag published alongside, or the flag would reload the
 * session's next turn as well. Returns the unsubscribe function.
 */
export function subscribeSessionReload(
  pubsub: Pick<PubSub, "onSessionReload" | "consumeSessionReloadFlag">,
  agent: ReloadableAgent,
  sessionId: string,
): Promise<() => Promise<void>> {
  return pubsub.onSessionReload(sessionId, (prompt) => {
    void pubsub.consumeSessionReloadFlag(sessionId).catch(() => {});
    agent.reloadAfterTurn(sessionId, prompt);
  });
}

/**
 * At job claim: a reload requested while no node held the session waits in a flag (with a TTL). Apply it
 * before the turn runs. The flag's prompt is not injected: this turn brings its own message. A failing
 * read never blocks the turn.
 */
export async function applyPendingSessionReload(
  pubsub: Pick<PubSub, "consumeSessionReloadFlag">,
  agent: ReloadableAgent,
  sessionId: string,
): Promise<boolean> {
  try {
    if ((await pubsub.consumeSessionReloadFlag(sessionId)) === null) return false;
    agent.reloadAfterTurn(sessionId);
    return true;
  } catch (e) {
    console.error(`[node] reload flag read failed session=${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
