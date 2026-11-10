---
title: "A node builds a persona's channel mandate from the bundle, not from a database"
date: 2026-11-11
---

# A node builds a persona's channel mandate from the bundle

**Date:** 2026-11-11
**Status:** branch `fix/node-soul-db`, on top of `v0.46.0-rc.14`.

## What was seen

The first boot of a SOUL.md persona on a worker, right after the worker was recreated, logged the node guard refusing a database open, with a stack through `soulData`, `personaMandateText` and `channelMandateBlock`.

## Cause

Two separate things.

1. `soulData()` always layered the runtime `soul_overrides` rows over the base soul. That read goes through `SoulOverrides.listSync`, which on sqlite opens the database. On a node the guard refuses, and `soulData()` swallows the error and returns the base soul. So the refusal was logged (once per process) but never reached `personaMandateText`'s own catch. Every node-side `soulData()` caller (`soulDataFor`, `redactPatternsFor`, `approvalTimeoutFor`) did the same.
2. A filesystem persona's runtime bundle carries `soulJson: null` (always, not only before extraction), so `channelMandateBlock` fell to `personaMandateText(persona)`, which reads the soul text from the node's own registry and disk (`personaSoulText`), not from the bundle. A node has no persona directory, so that resolves to the default SOUL.md or to nothing. The persona's channel block was not found, the effective mandate equalled the global one, and no `<channel-mandate>` block was written. It was silent: the system prompt for the booted process lacked the block for its whole life, with no log other than the guard line.

## Impact

Every turn of a process booted with this prompt, in a channel whose override differs from the global mandate: person turns in that channel's threads, the channel session, and wakes in it. The compiled-mandate block only covers agent.yaml personas, so a SOUL.md persona got no other copy. The persona text still contains the whole `## Channel` section, so the model saw the override as prose, but not as the superseding directive.

## Fix

- `soulData()` skips the overlay on a node. The default soul reaches a node through the bundle, overrides already applied by the gateway.
- `channelMandateBlock` on a node (a soul resolver is installed) parses the bundle's own soul text with the deterministic `parseScopedMandates` (`mandateTextFromSoulText`) when the bundle has no structured soul. The smallest change: no new bundle field, no wait, no fetch, and the text is the text the gateway sent. Gateway and mono keep `personaMandateText` unchanged.
- `guardNode` is untouched.

## Known limit

Trust-class scope mandates (`## Scope trusted|public`) need the gateway's channel lists, which a null `soulJson` does not carry, so on a node they do not apply for a SOUL.md persona. Channel blocks and the global mandate do. Sending the classes with the bundle would close it.
