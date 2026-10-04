import type { WebClient } from "@slack/web-api";

export interface PersonaConfig {
  slackUserId: string;
  name: string;
  userToken?: string;
}

export interface Persona {
  /** Directory name under ~/.slaude/personas/ — used as persona_id in the DB. */
  name: string;
  slackUserId: string;
  /** Set for filesystem personas; soulMd is set for database-backed ones. */
  soulPath?: string;
  /** Set for database-backed personas; soulPath is set for filesystem ones. */
  soulMd?: string;
  config: PersonaConfig;
  /** Set when config.userToken (xoxp) is present — replies/edits/reactions/uploads
   *  for this persona's sessions go out as its own Slack user account instead of
   *  the bot app. Null → this persona posts as the bot, same as Phase 1. */
  outClient: WebClient | null;
  /** Managed (database-backed) personas only: the effective model — the git
   *  value or a runtime override — or null when it sets none. Undefined for
   *  filesystem personas. */
  model?: string | null;
  /** Managed personas only: the effective MCP config (`.mcp.json`-shaped), or
   *  null when it sets none. Undefined for filesystem personas. */
  mcp?: unknown;
  /** Managed personas only: the node label it runs on, or null for `default`
   *  (node labels spec §4.5). Undefined for filesystem personas (`default`). */
  runsOn?: string | null;
}
