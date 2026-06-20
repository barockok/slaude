# Channel-specific soul mandate & approvers

**Date:** 2026-06-20
**Status:** approved (design forks confirmed by operator)

## Problem

`SOUL.md` parses into a **single global `SoulData`**. The `mandate` and
`approvers` are workspace-wide. An agent that lives in several Slack channels
cannot say "in #eng my mandate is X and these people approve" vs "in #product
my mandate is Y and those people approve". We want per-channel mandate &
approvers, defined in the soul, parsed into channel-scoped data, resolved at
runtime by the active channel.

## Authoring (SOUL.md)

New, repeatable H2 block:

```
## Channel <#C0123456789|eng>

### Mandate
- Ship backend fixes fast; defer product calls to #product.

### Approvers
- <@dba-id>: migrations, SQL
- <@sre-id>: deploys, rollbacks
```

- `## Channel <#Cxxx|name>` (or raw `Cxxx`/`Gxxx`/`Dxxx`) opens a block.
- `### Mandate` — free text, same shape as the global `## Mandate`.
- `### Approvers` — same `<id>: scope` line format as the global `## Approvers`.
- Either subsection may be omitted; an omitted one falls back to global.

## Merge semantics (operator-confirmed)

- **Mandate → Replace.** In that channel the channel mandate supersedes the
  global mandate. Absent → global mandate.
- **Approvers → Replace.** In that channel ONLY the channel approver list is
  consulted for approval-gate eligibility and approver-based admin auth.
  Absent / empty → global approvers.

### Safety: no operator lockout

`manager` / `backupManager` authority is a **separate** check from the
approver list everywhere it matters (admin commands, engagement gate), so
Replace never locks the operator out of admin authority. It DOES, however,
remove a global catchall approver from the **approval gate** inside an
overridden channel — so if the operator wants the manager to remain able to
click Approve/Deny there, they must list the manager in that channel's
`### Approvers`. Documented in the SOUL.md section text and STARTER_PERSONA.

## Schema (`src/soul/data.ts`)

```ts
export const ChannelOverrideSchema = z.object({
  channel: z.string().regex(/^[CGD][A-Z0-9]+$/),
  mandate: z.string().optional(),
  approvers: z.array(ApproverEntrySchema).default([]),
});
// SoulDataSchema gains:
channelOverrides: z.array(ChannelOverrideSchema).default([]),
```

`EXTRACTION_PROMPT` extended: emit a `channelOverrides` array, one entry per
`## Channel …` block, with `channel` (id, wrappers stripped), optional
`mandate`, and `approvers` (same rules as global). Skip template-stub blocks.

## Resolution (`src/soul/extract.ts`)

```ts
export function effectiveSoulForChannel(channelId?: string): SoulData
```

- Base = `soulData()` (runtime overlays preserved).
- If `channelId` matches a `channelOverrides[].channel`:
  - `mandate` replaced when the override sets a non-empty mandate.
  - `approvers` replaced when the override has ≥1 approver.
- No match / no channelId → base unchanged.
- Wrapped in try/catch → returns base on any failure (gates never break).

`assertIdsGroundedInPersona` extended to ground channel ids and per-channel
approver ids (an override can't widen the allowlist with invented ids).

## Mandate injection (`src/agent/manager.ts` `#startSession`)

`row.slack_channel_id` is in scope. When `effectiveSoulForChannel(channelId)`
yields a channel mandate that differs from base, append an authoritative
`<channel-mandate>` block after `soulSystemBlock()`:

```
<channel-mandate>
For this channel your mandate is: <text>
This supersedes the Mandate section in your persona for this channel.
</channel-mandate>
```

(The global mandate lives inside the raw `<persona>` text block which we don't
rewrite, so "replace" is realized by an explicit higher-priority directive.)

## Approver consumption

- `approval-gate.ts#resolveApprovers(req)` → `effectiveSoulForChannel(req.channel).approvers`
  (`req.channel` already present).
- Admin auth helpers (`mcp-tools` `isManagerOrApprover`, `ingest-auth`,
  `model-auth`) → channel-scoped approvers where a channel id is in scope;
  manager/backup checks unchanged.

## Fallback

Regex fallback (LLM extraction unavailable) yields global approvers only, no
channel overrides — a documented limitation, consistent with today's behavior
for the other LLM-only fields.

## Testing

- Resolver: replace mandate, replace approvers, empty-override fallback,
  unknown-channel fallback, no-channel fallback.
- Grounding: rejects ungrounded channel id and ungrounded channel approver id.
- Approval gate: per-channel approver selection picks channel list over global.
- Sim `soul-fixture` gains `channelOverrides` support for engine tests.

## Out of scope (YAGNI)

Per-channel overrides for trust level, redact patterns, approval timeout,
blocked/dm users. Goal is mandate & approvers only; schema is extensible if
those are wanted later.
