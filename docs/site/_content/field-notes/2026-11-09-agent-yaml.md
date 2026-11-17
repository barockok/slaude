---
title: "One agent.yaml: a definition that compiles instead of being extracted"
date: 2026-11-09
---

# One agent.yaml: a definition that compiles instead of being extracted

**Date:** 2026-11-09
**Status:** branch `feat/agent-yaml`, on `feat/scoped-mandates`.

## Problem

An agent was three files plus a parse: `persona.yaml`, `SOUL.md`, `mcp.json`, with access settings written as prose in the soul and read back by a model. The agent page showed the parse, and the prose was the only place to change a manager or a channel list.

## Mechanism

- `personas/<name>/agent.yaml` compiles to the existing sync payload (`src/persona/agent-def.ts`). `soul` is prose only; `mandate` and `access` build the structured soul deterministically. A persona directory uses one form or the other; both files together are a sync error, and a directory without the new file is unchanged.
- Payload version 6 adds a persona `definition` (compiled structure, description, skill list, guardrail list). The structure lands in `soul_json` as usual; the rest in `personas.definition` (migration 0036). A non-null `definition` is the marker that this soul is compiled.
- **Extraction is bypassed at every entry point.** Sync never extracts a definition, and a dry run does not either. A console soul edit keeps the compiled structure. Readers that went through the extraction cache or a text parse for a named persona (`personaMandateText`, the scheduler's manager lookup, the mono voice host, the mono prompt) ask `compiledSoulFor` first. A definition's global mandate reaches the prompt as its own block, because its soul text no longer holds one.
- Sync compares a definition's structure with the stored one, so changing only access counts as a change. Extracted souls keep the old rule (they follow their text, extraction is not deterministic).
- **Skill list.** Enforced where a skill is loaded: the Skill tool (the gate, per session), `/slug` invocation, and the skill MCP tools. The SDK's `skills` option hides the rest from the model's listing; that option is the listing only, the gate is the enforcement. Built-in `slaude:` skills and other plugins' skills are outside the list.
- **Attached guardrails.** A definition's guardrail list adds that agent to `scope: agents` guardrails at read time (`withAgentAttachments`). The stored documents and their signatures are not touched, and it can only add coverage; a disabled guardrail stays off.
- **Nodes.** A definition rides in the runtime bundle. A node that ignored it would run the agent without its skill list, attached guardrails and compiled mandate, so a new capability (`agent-definition/1`) gates both dispatch and the bundle for every agent.yaml persona, the same way `guardrails/1` does.

## Decisions

- **An agent.yaml persona inherits no access.** `withAclFallback` lets a SOUL.md persona borrow the default's managers, channels and approvers, which is right for prose that may be partial. A file with `dm: []` is a statement, so `soulDataFor` returns exactly the file; only the default persona's blocked users union in. The same rule covers approvers (`approversFor`), the trust class used by KB scope, the envelope and the decision gate, and the default persona's own approver chain, which stops at its file and never reads the on-disk SOUL.md or the env list.
- **A skill list is read per Skill call**, from the registry in mono and the ETag-cached bundle on a node, so a sync reaches a warm session. A failed read serves the last list known. The SDK listing is fixed at boot, so a newly allowed skill is listed from the next boot.
- **Unknown and duplicate keys fail the sync.** A typo in `access` must not silently unset a list, and a bare `skills:` must not widen to every skill.

- **Scoped mandates compile to the shapes the resolver already reads**, so override, extend, reduce, the absent-mode and unknown-mode rules are shared rather than reimplemented. An unknown mode warns at sync and reads as `extend`; a typo must not replace the global mandate or fail a deploy.
- **Two access keys beyond the first draft:** `approvers[].channel` and `approvalTimeoutSeconds`. The structured soul already had both, and a migration that dropped them would silently change who can approve and how long a request waits.
- **Export strips, conservatively.** `personas export --format agent-yaml` removes only the soul sections moved into their own keys, by heading, and keeps everything it does not recognise, so a migration cannot drop prose.
- **The Definition view is built field by field** rather than masking a dump. A blanket secret filter over the finished document mangles YAML keys like `userToken:`, so it runs over free text only and the rest is references, hosts and placeholders.
