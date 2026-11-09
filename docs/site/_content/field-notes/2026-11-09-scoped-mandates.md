---
title: "Scoped mandates: one resolver for override, extend and reduce"
date: 2026-11-09
---

# Scoped mandates: one resolver for override, extend and reduce

**Date:** 2026-11-09
**Status:** branch `feat/scoped-mandates`.

## Problem

A channel's `### Mandate` could only replace the global mandate, and channel lists were the only boundary. Asking for "the global mandate, but narrower in public channels" meant copying the whole global text into every public channel block. Each consumer also read a channel's mandate on its own: the turn's system prompt, the scheduler, the voice host and the console each had a variant of "the channel block, else global".

## Mechanism

- A sub-mandate is `{ boundary, mode, text }`. Boundaries: `channel:<id>`, `trust:public`, `trust:trusted`, `dm`. Modes: `override` (replaces the global text), `extend` (global text plus an addition), `reduce` (global text plus a limit that wins inside the boundary).
- `resolveMandate(global, subMandates, context)` in `src/soul/mandate-scope.ts` is pure. It picks the single most specific match (channel, then trust class, then dm) and returns the effective text and which sub-mandate applied. There is no stacking: a channel block in a public channel ignores `## Scope public`.
- SOUL.md syntax stays markdown: a `Mode:` line first inside `### Mandate`, and top-level `## Scope dm|public|trusted` blocks. A `Mode:` line that is not first, or has an unknown value, stays mandate text.
- Consumers: `effectiveSoulForChannel` and `effectiveSoulForChannelFor`, the `<channel-mandate>` system prompt block, the mono and node voice hosts, the scheduler (`personaMandates`, which feeds the heartbeat and wake prompts) and the console read model all resolve here.

## Decisions

- **No `Mode:` line means `override`.** Absence is the old behaviour, and the resolver returns the same strings as before for such a soul. A regression test compares against the frozen old logic.
- **The cache key changes only for souls that use the syntax.** `soulCachePath` hashes `scoped-mandates/1` plus the text when the text has a `Mode:` line or a `## Scope` block, so no extraction made before the syntax is trusted for them. Other souls keep their key: a global bump would make every boot of an unchanged soul depend on the model again, and a failed extraction falls back to approvers only.
- **`Mode` values from the model are lenient.** They are lower-cased and an unknown value reads as `override`. A bad mode must not fail the extraction and cost the soul its ACLs.
- **Trust classes are the ones that admit the agent.** A named persona can inherit channel lists from the default soul (`withAclFallback`), so its context reads those lists. A node has only the bundle, so a soul with scope mandates ships in the bundle with the lists it is admitted by; other souls ship as stored.
- **A limit is never cut.** The triage prompt cuts a mandate at a fixed length. The resolver returns the global text and the labelled addition as separate parts, and only the global part is cut; nothing re-parses rendered text. `validate-soul` warns on an extend or reduce over that length.
