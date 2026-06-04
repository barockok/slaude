/** `--real` runs the actual agent SDK (the claude CLI subprocess), which needs a provider
 *  credential. Returns an actionable warning when none is set, or null when good to go. Pure
 *  so it's unit-tested; cli.ts feeds it the resolved env.provider values. */
export function missingCredsWarning(p: { apiKey?: string; authToken?: string; oauthToken?: string }): string | null {
  const has = (v?: string) => !!v && v.trim().length > 0;
  if (has(p.apiKey) || has(p.authToken) || has(p.oauthToken)) return null;
  return [
    "⚠️  real agent selected but no provider credential found.",
    "    Add one to ~/.slaude/.env (or the project ./.env):",
    "      ANTHROPIC_API_KEY=sk-…              # Anthropic or any Anthropic-compatible gateway",
    "      ANTHROPIC_BASE_URL=https://…        # optional — non-Anthropic gateway",
    "      SLAUDE_MODEL=<provider/model-id>    # required for non-Anthropic gateways",
    "    or a Claude subscription token:  CLAUDE_CODE_OAUTH_TOKEN=…  (from `claude setup-token`).",
    "    Without it the turn will fail with a 401. (`--stub` runs fully offline.)",
  ].join("\n");
}
