import { z } from "zod";

/**
 * Structured projection of the operator's SOUL.md. Produced by an ephemeral
 * Claude extraction pass at boot, cached by sha256(SOUL.md). The runtime
 * consumes this in place of regex-scraping the raw markdown.
 *
 * Extraction is best-effort: any field may be missing if the persona is
 * incomplete. Callers fall back to regex parsing for fields they require.
 */
export const ApproverEntrySchema = z.object({
  userId: z.string().regex(/^[UW][A-Z0-9]+$/),
  scope: z.string().min(1),
  catchall: z.boolean(),
});

export const SoulDataSchema = z.object({
  identity: z
    .object({
      name: z.string().optional(),
      role: z.string().optional(),
      voice: z.string().optional(),
    })
    .partial()
    .default({}),
  manager: z
    .object({
      userId: z.string().regex(/^[UW][A-Z0-9]+$/).optional(),
      handle: z.string().optional(),
    })
    .partial()
    .default({}),
  /** Backup manager — same authority as primary for the engagement gate
   *  (DMs and non-public channels accept either). Approvers retain the same
   *  approval authority as before. Optional; falls back to manager-only. */
  backupManager: z
    .object({
      userId: z.string().regex(/^[UW][A-Z0-9]+$/).optional(),
      handle: z.string().optional(),
    })
    .partial()
    .default({}),
  /** Slack channel/group ids treated as public-interaction zones — anyone
   *  in the channel can address slaude. In any channel NOT on this list
   *  (and in DMs) only the manager may engage; approvers can still click
   *  Approve / Deny on `request_approval` blocks but can't chat. */
  /** Public-zone channels — anyone in the channel can address slaude.
   *  Slaude should mind info exposure here (no unsolicited dumps of MCP
   *  servers, skills, internal config — public eyes). */
  allowedChannels: z.array(z.string().regex(/^[CGD][A-Z0-9]+$/)).default([]),
  /** Trusted team channels — slaude operates as part of the team here.
   *  Engagement gate identical to `allowedChannels` (anyone in channel can
   *  chat), but the agent gets a `<channel-trust>trusted</channel-trust>`
   *  hint in the inbound envelope, signaling it can be more open: show MCP
   *  server lists, skills, debug info, internal context. Use for the BU /
   *  team channel where slaude is a member, not a guest. */
  trustedChannels: z.array(z.string().regex(/^[CGD][A-Z0-9]+$/)).default([]),
  /** Slack user ids whose inbound messages are dropped before Claude is
   *  invoked. Hard-blocks at the adapter gate (no logs leaked to the agent,
   *  no token spend). Useful for banning a noisy user inside an otherwise-
   *  trusted/allowed channel without un-trusting the whole channel. */
  blockedUsers: z.array(z.string().regex(/^[UW][A-Z0-9]+$/)).default([]),
  approvers: z.array(ApproverEntrySchema).default([]),
  /** Reply-redaction patterns. Each entry is a JS regex (no flags — applied
   *  as global+case-insensitive). Matched substrings replaced with `[REDACTED]`
   *  in `mcp__slaude_surface__reply` / `edit` / upload `initial_comment` after
   *  markdown→mrkdwn conversion. Defense against accidentally leaking
   *  secrets / PII patterns into Slack. */
  redactPatterns: z.array(z.string()).default([]),
  /** Auto-deny `request_approval` blocks after N seconds with no human
   *  click. 0 = wait indefinitely (current behavior). */
  approvalTimeoutSeconds: z.number().int().nonnegative().default(0),
  mandate: z.string().optional(),
  values: z.array(z.string()).default([]),
});

export type ApproverEntry = z.infer<typeof ApproverEntrySchema>;
export type SoulData = z.infer<typeof SoulDataSchema>;

export const EXTRACTION_PROMPT = `You are a structured-data extractor. Read the persona block above and return a single JSON object matching this TypeScript shape — no prose, no fences, just JSON:

{
  "identity":              { "name"?: string, "role"?: string, "voice"?: string },
  "manager":               { "userId"?: string, "handle"?: string },
  "backupManager":         { "userId"?: string, "handle"?: string },
  "allowedChannels":       string[],
  "trustedChannels":       string[],
  "blockedUsers":          string[],
  "approvers":             Array<{ "userId": string, "scope": string, "catchall": boolean }>,
  "redactPatterns":        string[],
  "approvalTimeoutSeconds": number,
  "mandate"?:              string,
  "values":                string[]
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
- backupManager: optional fallback manager. Look for sections titled "Backup manager", "Secondary manager", "Deputy". Same id-validation rules as manager.
- redactPatterns: array of regex source strings (no /…/ wrappers, no flags) the persona declares for redacting outbound replies. Look for sections titled "Redaction", "Redact", "PII patterns". Empty array if no such section.
- approvalTimeoutSeconds: integer seconds. Look for "Approval timeout" or "Auto-deny after". 0 means wait forever.
- Omit fields you cannot determine. Do not invent ids — every id you return MUST appear verbatim somewhere in the persona text.
- Return ONLY the JSON object. No \`\`\` fence. No explanation.`;
