/**
 * Whose MCP credentials a turn uses.
 *
 * Decided once, at dispatch, by the same rule the node uses to pick its config
 * directory (AgentManager.resolveEffectiveIdentity), and signed into the job
 * token as `runAs`. Nothing downstream re-derives it, so the directory a node
 * seeds and the credentials the gateway serves cannot disagree.
 *
 * The agent is keyed on (tenant, persona), matching how the runtime bundle
 * resolves an agent's identity. A person is keyed on their account, so one
 * person in two Slack workspaces has one set of integrations.
 */
export type CredentialOwner =
  | { kind: "agent"; tenant: string; persona: string }
  | { kind: "account"; accountId: string };
