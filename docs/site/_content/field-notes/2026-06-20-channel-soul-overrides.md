# Channel-specific soul mandate & approvers

**Date:** 2026-06-20
**Status:** shipped on `feat/channel-soul-overrides`

## What

`SOUL.md` previously parsed into a single global `SoulData`; mandate and
approvers were workspace-wide. Agents living in multiple Slack channels now get
**per-channel mandate and approvers**, authored in the soul and resolved at
runtime by the active channel.

## Mechanism

- **Authoring:** a repeatable `## Channel <#Cxxx|name>` H2 block with nested
  `### Mandate` and `### Approvers` subsections. Either subsection may be
  omitted (falls back to global).
- **Schema:** `ChannelOverrideSchema` (`{ channel, mandate?, approvers[] }`)
  added to `SoulData.channelOverrides`. The extraction prompt emits it; the
  grounding check (`assertIdsGroundedInPersona`) now also grounds channel ids
  and per-channel approver ids so the LLM can't invent allowlist entries.
- **Resolution:** `effectiveSoulForChannel(channelId)` starts from `soulData()`
  (runtime overlays preserved) and, on a channel match, **replaces** mandate
  (when set) and **replaces** approvers (when ≥1). No match / no channel /
  any failure → global view, so gates never break.
- **Mandate injection:** `manager.ts#startSession` appends a `<channel-mandate>`
  directive after `soulSystemBlock()` when the channel mandate differs from the
  global. The global mandate stays inside the unedited `<persona>` text, so
  "replace" is realised by a higher-priority instruction rather than rewriting
  the persona.
- **Approver consumption:** `approval-gate#resolveApprovers(req)` uses
  `effectiveSoulForChannel(req.channel)`; admin-auth (`isManagerOrApprover`,
  `/model`) resolves per-channel where a channel id is in scope.

## Key decision: manager is never locked out

Replace semantics could strip a global catchall approver from the approval gate
inside an overridden channel. Per operator decision, `withManagerApprover`
**always injects the manager and backup as catchall approvers** into the
resolved channel approver set (unless already present). A channel block can
therefore only *add* approvers, never remove the operator. manager/backup admin
authority was already a separate check and is unaffected.

## Limitations

- Regex fallback (LLM extraction unavailable) yields global approvers only, no
  channel overrides — consistent with the other LLM-only soul fields.
- Out of scope (YAGNI): per-channel trust level, redact patterns, approval
  timeout, blocked/dm users. Schema is extensible if wanted later.

Spec: `docs/superpowers/specs/2026-06-20-channel-soul-overrides-design.md`.
