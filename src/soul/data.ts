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

/** How a sub-mandate combines with the global mandate. See `mandate-scope.ts`. */
export const MandateModeSchema = z.enum(["override", "extend", "reduce"]);
export type MandateMode = z.infer<typeof MandateModeSchema>;

/** Lower-cased. An unknown value reads as `extend`: it keeps the global mandate
 *  rather than replacing it, and does not fail the extraction. Absent stays absent. */
const lenientMode = z.preprocess((v) => {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return MandateModeSchema.safeParse(s).success ? s : "extend";
}, MandateModeSchema.optional());

/**
 * Per-channel override of the global mandate / approvers. Sourced from a
 * `## Channel <#Cxxx|name>` block in SOUL.md. Both inner fields are optional:
 *   - mandate present → applies in that channel per its mode (`Mode:` line;
 *     none means it replaces the global mandate).
 *   - approvers non-empty → replaces the global approver set in that channel.
 * An absent field falls back to the global value. See
 * {@link SoulDataSchema.channelOverrides} and `effectiveSoulForChannel`.
 */
export const ChannelOverrideSchema = z.object({
  channel: z.string().regex(/^[CGD][A-Z0-9]+$/),
  mandate: z.string().optional(),
  /** How `mandate` combines with the global one; absent means `override`. */
  mandateMode: lenientMode,
  approvers: z.array(ApproverEntrySchema).default([]),
});

/** A sub-mandate for a kind of place, from a `## Scope dm|public|trusted` block. */
export const ScopeMandateSchema = z.object({
  scope: z.enum(["dm", "public", "trusted"]),
  mandate: z.string(),
  mode: lenientMode,
});

/**
 * One Slack reference from agent.yaml access, kept with what the legacy arrays
 * drop: its workspace (absent for a bare id or a short `slack:` form) and how
 * it grants. The arrays stay authoritative for legacy decisions; entries feed
 * the internal-id path (slice C). Only Slack references exist in this release.
 */
export const AccessEntrySchema = z.object({
  field: z.enum(["manager", "backupManager", "approvers", "blocked", "dm", "channels.public", "channels.trusted"]),
  kind: z.enum(["user", "channel"]),
  id: z.string().regex(/^[UWCGD][A-Z0-9]+$/),
  workspace: z.string().regex(/^T[A-Z0-9]+$/).optional(),
  role: z.enum(["manager", "approver", "member"]),
  deny: z.boolean().default(false),
  dmOnly: z.boolean().default(false),
  /** An approver scoped to one channel. */
  channel: z.string().regex(/^[CGD][A-Z0-9]+$/).optional(),
});
export type AccessEntry = z.infer<typeof AccessEntrySchema>;

/**
 * One `email:` or `user:` reference from agent.yaml access (slice C task 22,
 * only compiled while `SLAUDE_ACCESS_SOURCE=internal`). Kept apart from the
 * legacy arrays on purpose: those carry Slack ids that older readers compare as
 * strings, and a name that is not a Slack id must never reach them. A binary
 * that does not know this key drops it, so the entry is inert there.
 */
export const AccessRefSchema = z.object({
  field: z.enum(["manager", "backupManager", "approvers", "blocked", "dm"]),
  ref: z.discriminatedUnion("service", [
    z.object({ service: z.literal("email"), address: z.string().min(3).max(254) }),
    z.object({ service: z.literal("user"), userId: z.string().min(1).max(64) }),
  ]),
  role: z.enum(["manager", "approver", "member"]),
  deny: z.boolean().default(false),
  dmOnly: z.boolean().default(false),
  /** An approver scoped to one channel. */
  channel: z.string().regex(/^[CGD][A-Z0-9]+$/).optional(),
});
export type AccessRef = z.infer<typeof AccessRefSchema>;

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
  /** Slack user ids allowed to DM slaude directly (1:1), in addition to the
   *  manager/backup. Without this, a DM from anyone but manager/backup is
   *  dropped at the engagement gate. Grants DM engagement only — it does NOT
   *  confer manager authority over admin commands (cron / ignore / ingest),
   *  which still require manager/backup or approver. */
  dmAllowedUsers: z.array(z.string().regex(/^[UW][A-Z0-9]+$/)).default([]),
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
  /** Per-channel overrides of mandate / approvers. Empty = global only.
   *  Resolved at runtime by `effectiveSoulForChannel(channelId)`. */
  channelOverrides: z.array(ChannelOverrideSchema).default([]),
  /** Sub-mandates for direct messages and the two channel classes. */
  scopeMandates: z.array(ScopeMandateSchema).default([]),
  /** Typed Slack references behind the access arrays above (agent.yaml only; a soul extracted from prose has none). */
  accessEntries: z.array(AccessEntrySchema).default([]),
  /** The `email:` and `user:` references of agent.yaml access (internal source only); never in the arrays above. */
  accessRefs: z.array(AccessRefSchema).default([]),
});

export type ApproverEntry = z.infer<typeof ApproverEntrySchema>;
export type ChannelOverride = z.infer<typeof ChannelOverrideSchema>;
export type ScopeMandate = z.infer<typeof ScopeMandateSchema>;
export type SoulData = z.infer<typeof SoulDataSchema>;
