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
  soulPath: string;
  config: PersonaConfig;
  /** Set when config.userToken (xoxp) is present — replies/edits/reactions/uploads
   *  for this persona's sessions go out as its own Slack user account instead of
   *  the bot app. Null → this persona posts as the bot, same as Phase 1. */
  outClient: WebClient | null;
}
