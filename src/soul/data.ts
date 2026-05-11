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
  userId: z.string().regex(/^[UW][A-Z0-9]{6,}$/),
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
      userId: z.string().regex(/^[UW][A-Z0-9]{6,}$/).optional(),
      handle: z.string().optional(),
    })
    .partial()
    .default({}),
  /** Slack channel/group ids treated as public-interaction zones — anyone
   *  in the channel can address slaude. In any channel NOT on this list
   *  (and in DMs) only the manager may engage; approvers can still click
   *  Approve / Deny on `request_approval` blocks but can't chat. */
  allowedChannels: z.array(z.string().regex(/^[CGD][A-Z0-9]{6,}$/)).default([]),
  approvers: z.array(ApproverEntrySchema).default([]),
  mandate: z.string().optional(),
  values: z.array(z.string()).default([]),
});

export type ApproverEntry = z.infer<typeof ApproverEntrySchema>;
export type SoulData = z.infer<typeof SoulDataSchema>;

export const EXTRACTION_PROMPT = `You are a structured-data extractor. Read the persona block above and return a single JSON object matching this TypeScript shape — no prose, no fences, just JSON:

{
  "identity":        { "name"?: string, "role"?: string, "voice"?: string },
  "manager":         { "userId"?: string, "handle"?: string },
  "allowedChannels": string[],
  "approvers":       Array<{ "userId": string, "scope": string, "catchall": boolean }>,
  "mandate"?:        string,
  "values":          string[]
}

Rules:
- userId is the raw Slack id (U… or W…), strip <@…> wrappers.
- Channel ids start with C (public), G (private group), or D (DM). Strip <#…|name> wrappers — keep only the id.
- scope is the free-text description after the colon, verbatim minus trailing comments.
- catchall=true when scope is "anything" / "any" / "all" / "default" / "*" / "catchall" / "everything".
- Skip placeholder rows (e.g. "<@manager-id>", "<agent display name>", "<C-channel-id>") — those are template stubs, not real values.
- Omit fields you cannot determine. Do not invent ids — every id you return MUST appear verbatim somewhere in the persona text.
- Return ONLY the JSON object. No \`\`\` fence. No explanation.`;
