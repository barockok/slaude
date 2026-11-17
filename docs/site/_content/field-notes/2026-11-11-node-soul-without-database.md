---
title: "A node builds a persona's channel mandate from the bundle, not from a database"
date: 2026-11-11
---

# A node builds a persona's channel mandate from the bundle

> **Superseded in rc.17:** nodes no longer parse soul text, and the `channelClasses` bundle field is gone; a bundle with no structured soul gets no channel mandate. See [agent.yaml only](2026-11-14-agent-yaml-only.md).

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

- `soulData()` skips the overlay on a node. A node does not apply runtime overrides: the gateway enforces the lists those overrides edit (trusted, allowed, approvers). Only the tier-3 default bundle's `soulJson` is read through `soulData()` on the gateway, so it carries the overrides, and only `channelMandateBlock` reads it on the node.
- `channelMandateBlock` on a node (a soul resolver is installed) parses the bundle's own soul text with the deterministic `parseScopedMandates` (`mandateTextFromSoulText`) when the bundle has no structured soul. The gateway may use a cached LLM extraction of the same text where the node uses the deterministic parse, so the two are equal when no extraction is cached, not exactly always. Gateway and mono keep `personaMandateText` unchanged.
- The bundle gains an optional `channelClasses` (trusted and allowed lists, from `soulDataFor`) whenever `soulJson` is null. It is part of the body, so the ETag changes with the lists (a `/soul trust add`). An older node ignores it; a new node against a gateway that omits it warns once per persona if the soul text has a `## Scope trusted|public` block.
- `guardNode` is untouched.

## Failure direction

Before the classes were sent, a `## Scope public|trusted` mandate was dropped on a node for a SOUL.md persona (the node had no lists to place a channel). A `reduce` restriction disappeared without a trace, so the node was more permissive than the gateway. That is closed by `channelClasses`; with an old gateway it is a loud warning, not a silent drop.
