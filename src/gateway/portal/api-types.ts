/**
 * Response shapes of the portal JSON API under `/portal/api/*` that the new
 * web app consumes. Self-contained (no imports) so the web build can import it
 * without server modules.
 */

export type AgentRole = "manager" | "approver" | "member";

/**
 * The chat surface an identity lives on (`slack` today; WhatsApp, Discord and
 * Telegram come later). The web app labels it from its surface registry.
 * The id fields below keep their Slack-era names (`teamId`, `slackUserId`):
 * they are the surface's workspace and user ids.
 */
export type PortalSurfaceId = string;

/** One agent the signed-in person holds a user-level role on, per linked chat identity. */
export interface MyAgentView {
  /** Persona name; `default` is the deployment's default agent. */
  persona: string;
  /** Where the identity holding the role lives. */
  surface: PortalSurfaceId;
  teamId: string;
  slackUserId: string;
  /** The workspace's and the user's names, when the gateway could resolve them. */
  teamName?: string;
  userName?: string;
  role: AgentRole;
}

/** GET /portal/api/my-agents */
export interface MyAgentsResponse {
  agents: MyAgentView[];
}

/** One chat identity (a user in a workspace on a surface) bound to the signed-in account. */
export interface PortalSlackIdentityView {
  /** Where the identity lives. */
  surface: PortalSurfaceId;
  teamId: string;
  slackUserId: string;
  /** Epoch ms. */
  linkedAt: number;
  /** How the binding was made, e.g. `signed-link` (the link `/link` sends). */
  linkedVia: string;
  /** The workspace's and the user's names, when the gateway could resolve them. */
  teamName?: string;
  userName?: string;
}

/** GET /portal/api/me */
export interface PortalMeResponse {
  email: string;
  accountId: string;
  /** The sign-in provider's issuer URL: the account is keyed on (issuer, subject). */
  issuer: string;
  /** Every linked chat identity (the name predates other surfaces). */
  slackIdentities: PortalSlackIdentityView[];
}

/** DELETE /portal/api/link body: unlink one of your own chat identities. */
export interface UnlinkRequest {
  teamId: string;
  slackUserId: string;
}

/** A plain success answer (unlink). */
export interface PortalOkResponse {
  ok: true;
}

/** One connectable MCP server and whether the signed-in account holds a credential for it. */
export interface IntegrationView {
  /** What the page and the API call it (the server name, or a credential key when names collide). */
  id: string;
  /** The name the agents know it by. */
  name: string;
  /** Host only. */
  host: string;
  connected: boolean;
  /** Epoch ms the stored access token expires (renewed on use when refreshable), or null when not connected. */
  expiresAt: number | null;
  /** Personas that mount it, sorted. */
  usedBy: string[];
}

/** GET /portal/api/integrations */
export interface IntegrationsResponse {
  integrations: IntegrationView[];
}

/** POST /portal/api/integrations/:id/connect: send the browser to `authorizeUrl`. */
export interface ConnectIntegrationResponse {
  authorizeUrl: string;
}

/** DELETE /portal/api/integrations/:id */
export interface DisconnectIntegrationResponse {
  ok: true;
  /** False when there was nothing to remove. */
  removed: boolean;
}

/**
 * `?connect=` on the redirect /portal/oauth/callback sends back to `/portal`:
 * `connected`, `expired` (the flow cookie was missing or stale), `failed` (no
 * code), or one of the three finish failures: `no-flow` (the flow was already
 * used or has expired), `state-mismatch` (the provider's state did not match
 * the request) or `exchange-failed` (the provider refused the code exchange).
 */
export type ConnectResult = "connected" | "expired" | "failed" | "no-flow" | "state-mismatch" | "exchange-failed";
