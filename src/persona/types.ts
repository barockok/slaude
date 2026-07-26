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
}
