/**
 * The agent id whose brain slice (`agent-<id>`) a persona's turns use: a
 * named persona's own Slack user, else the process agent identity (the
 * default persona, or an unmanaged registry that does not know the name).
 * One resolver for the writer (the brain gate, src/gateway/core/gateway.ts)
 * and the readers (the console's session history), so both land on the same
 * slice. A managed persona that is not live throws PersonaNotLiveError: the
 * gate refuses rather than touching the default agent's private slice.
 */
import { agentIdSync } from "../knowledge/agent-identity";
import { livePersona } from "./registry";

export function personaAgentId(personaId: string | null | undefined): string {
  const name = personaId && personaId !== "default" ? personaId : null;
  return name ? (livePersona(name)?.slackUserId ?? agentIdSync()) : agentIdSync();
}
