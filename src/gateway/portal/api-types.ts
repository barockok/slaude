/**
 * Response shapes of the portal JSON API under `/portal/api/*` that the new
 * web app consumes. Self-contained (no imports) so the web build can import it
 * without server modules.
 */

export type AgentRole = "manager" | "approver" | "member";

/** One agent the signed-in person holds a user-level role on, per linked Slack identity. */
export interface MyAgentView {
  /** Persona name; `default` is the deployment's default agent. */
  persona: string;
  teamId: string;
  slackUserId: string;
  role: AgentRole;
}

/** GET /portal/api/my-agents */
export interface MyAgentsResponse {
  agents: MyAgentView[];
}
