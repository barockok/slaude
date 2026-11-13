/** The prompt `personas migrate` gives the model to read an old SOUL.md. */
export const EXTRACTION_PROMPT = `You are a structured-data extractor. Read the persona block above and return a single JSON object matching this TypeScript shape — no prose, no fences, just JSON:

{
  "identity":              { "name"?: string, "role"?: string, "voice"?: string },
  "manager":               { "userId"?: string, "handle"?: string },
  "backupManager":         { "userId"?: string, "handle"?: string },
  "allowedChannels":       string[],
  "trustedChannels":       string[],
  "blockedUsers":          string[],
  "dmAllowedUsers":        string[],
  "approvers":             Array<{ "userId": string, "scope": string, "catchall": boolean }>,
  "redactPatterns":        string[],
  "approvalTimeoutSeconds": number,
  "mandate"?:              string,
  "values":                string[],
  "channelOverrides":      Array<{ "channel": string, "mandate"?: string, "mandateMode"?: "override" | "extend" | "reduce", "approvers": Array<{ "userId": string, "scope": string, "catchall": boolean }> }>,
  "scopeMandates":         Array<{ "scope": "dm" | "public" | "trusted", "mandate": string, "mode"?: "override" | "extend" | "reduce" }>
}

Rules:
- userId is the raw Slack id (U… or W…), strip <@…> wrappers.
- Channel ids start with C (public), G (private group), or D (DM). Strip <#…|name> wrappers — keep only the id.
- scope is the free-text description after the colon, verbatim minus trailing comments.
- catchall=true when scope is "anything" / "any" / "all" / "default" / "*" / "catchall" / "everything".
- Skip placeholder rows (e.g. "<@manager-id>", "<agent display name>", "<C-channel-id>") — those are template stubs, not real values.
- allowedChannels: public-zone channels where slaude may interact but must mind info exposure. Look for sections titled "Allowed channels", "Public channels".
- trustedChannels: internal team channels where slaude operates as a member (can show MCP servers, skills, internals). Look for sections titled "Trusted channels", "Team channel", "Home channel", "BU channel".
- blockedUsers: ids the persona explicitly marks as banned, blocked, ignored, blacklisted, or "do not respond". Look for sections titled "Blocked", "Blacklist", "Ignore", "Banned". Empty array if no such section.
- dmAllowedUsers: ids allowed to DM slaude directly besides the manager. Look for sections titled "DM allowlist", "Allowed DMs", "Direct message allowlist", "Who can DM". Empty array if no such section.
- backupManager: optional fallback manager. Look for sections titled "Backup manager", "Secondary manager", "Deputy". Same id-validation rules as manager.
- redactPatterns: array of regex source strings (no /…/ wrappers, no flags) the persona declares for redacting outbound replies. Look for sections titled "Redaction", "Redact", "PII patterns". Empty array if no such section.
- approvalTimeoutSeconds: integer seconds. Look for "Approval timeout" or "Auto-deny after". 0 means wait forever.
- channelOverrides: one entry per "## Channel <#Cxxx|name>" (or raw Cxxx/Gxxx/Dxxx) section. For each: "channel" = the channel id (strip <#…|name> wrappers, keep only the id); "mandate" = the text under that block's "### Mandate" subsection (omit if absent); "approvers" = the entries under that block's "### Approvers" subsection (same userId/scope/catchall rules as the top-level approvers). Skip template-stub blocks whose channel id is a placeholder like "<#Cxxx|name>" or "C0123456789". Empty array if there are no channel sections.
- mandateMode: when the first line under a "### Mandate" is "Mode: override", "Mode: extend" or "Mode: reduce", set that value (lower case) and leave the line out of the mandate text. A first line "Mode: <one other word>" means "extend", also left out of the text. Omit it when there is no such line.
- scopeMandates: one entry per top-level "## Scope dm", "## Scope public" or "## Scope trusted" section that has a "### Mandate". "scope" = dm, public or trusted; "mandate" = the text under its "### Mandate"; "mode" = the value of a first "Mode:" line, left out of the text, as for mandateMode. Empty array if there are none.
- Omit fields you cannot determine. Do not invent ids — every id you return MUST appear verbatim somewhere in the persona text.
- Return ONLY the JSON object. No \`\`\` fence. No explanation.`;
