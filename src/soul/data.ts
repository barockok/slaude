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
  allowedUsers: z.array(z.string().regex(/^[UW][A-Z0-9]{6,}$/)).default([]),
  approvers: z.array(ApproverEntrySchema).default([]),
  mandate: z.string().optional(),
  values: z.array(z.string()).default([]),
});

export type ApproverEntry = z.infer<typeof ApproverEntrySchema>;
export type SoulData = z.infer<typeof SoulDataSchema>;

export const EXTRACTION_PROMPT = `You are a structured-data extractor. Read the persona block above and return a single JSON object matching this TypeScript shape — no prose, no fences, just JSON:

{
  "identity":     { "name"?: string, "role"?: string, "voice"?: string },
  "manager":      { "userId"?: string, "handle"?: string },
  "allowedUsers": string[],
  "approvers":    Array<{ "userId": string, "scope": string, "catchall": boolean }>,
  "mandate"?:     string,
  "values":       string[]
}

Rules:
- userId is the raw Slack id (U… or W…), strip <@…> wrappers.
- scope is the free-text description after the colon, verbatim minus trailing comments.
- catchall=true when scope is "anything" / "any" / "all" / "default" / "*" / "catchall" / "everything".
- Skip placeholder rows (e.g. "<@manager-id>", "<agent display name>") — those are template stubs, not real values.
- Omit fields you cannot determine. Do not invent ids.
- Return ONLY the JSON object. No \`\`\` fence. No explanation.`;
