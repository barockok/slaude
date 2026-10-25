---
title: "Runtime prompt as built-in skills: procedures out of the always-on core"
date: 2026-10-25
---

# Runtime prompt as built-in skills: procedures out of the always-on core

**Date:** 2026-10-25
**Status:** Shipped on the epic branch, unreleased (agent-loop change, so it goes out as a release candidate first). Not verified against a live CLI.

The runtime prompt had grown into one large TypeScript string, and every turn
paid for procedures that matter only on some turns (how to author a skill, for
instance). Phase R moves that text into files, splits tiers, and lets a
procedure be loaded on demand, without adding a single rule.

## The mechanism

Three tiers:

- **Core** (`src/soul/runtime/core.md`): rules that apply every turn (output
  discipline, reply-or-pass, approval, channel trust, harness overrides, voice
  rules, KB-first). Always in the prompt.
- **State modules** (`src/soul/runtime/modules/*.md`): text for a session state
  (locked, open, remote). Templated files rendered by TypeScript builders. The
  conditional logic stays in the builders; the files only hold prose with named
  variables, and an unknown or unused variable throws, naming file and variable.
- **Built-in skills** (`src/soul/builtin/`): a plugin named `slaude` mounted at
  every boot. Each skill has frontmatter with `name`, `description`, `trigger`,
  `governs` (full tool names) and `version` (a placeholder filled from
  `package.json` at load). The CLI sees the skill as `slaude:<name>`.

The core names the skills through a generated index (one line per skill: name,
trigger), so the model knows a procedure exists without carrying its text.

### The hook pair

A skill may govern tools. A PreToolUse hook denies a governed tool until the
session has loaded the skill; a PostToolUse hook on the `Skill` tool records the
load. Details that matter:

- **Loaded** means a PostToolUse of `Skill` without an error, with the exact
  qualified name (`slaude:<name>`) and nothing looser.
- The deny reuses the shape of the remote deny hook (`permissionDecision`
  `deny` with a reason), and the reason says exactly what to call and to retry.
- The loaded set is per session id and is reset at the single boot choke point,
  so every (re)boot starts clean. Cleanup on teardown is guarded by session
  ownership, so an old process cannot clear a newer boot's state.
- A session whose boot did not mount the plugin is not enforced.
- Runtime-check turns are not exempt.

### Immutability

A built-in cannot be changed at runtime. `write_skill` and `delete_skill` refuse
a slug equal to a built-in's bare name, for the base root and the persona
overlay alike. The refusal lives in the shared skill-ops layer, so no caller
bypasses it. Review found two writers that did not go through that layer: the
manifest installer and the bundled-skill seeder. Both now refuse or skip a
built-in-named skill.

### Shipping

The files live under `src/` and are found with `import.meta.dir`, never the
runtime home or the working directory. They ship because the release tarball and
the Docker image copy `src/` whole; nothing new was added to either.

## What moved

Only the Skill evolution section. For every state the rendered prompt equals the
previous text, with three allowed differences, pinned by golden tests:

1. The section, minus one bullet, moved verbatim into `slaude:skill-authoring`.
2. A skill index takes the section's place in the core.
3. The bullet saying `<runtime-check>` messages come from the runtime and never
   require a reply stays in the core. Review found that moving it with the
   section would regress the no-op auto-evolve path: that turn never loads the
   skill (it has nothing to write), and nodes have no Stop hook to catch a
   forced reply. The bullet is an every-turn rule, so it stays always-on.

## The size budget

A test renders the core with the brain on and asserts its length stays within
5% of the length measured when the section moved. Its message says to move
procedures into a built-in skill instead of growing the core. The number is a
constant in the test, with the commit it was measured at.

## Decisions

- **Templated files, not generated strings.** State modules are plain files with
  named variables; TypeScript keeps the branching. Prose can be reviewed and
  diffed as prose.
- **Deny, not warn.** A prompt rule to load the skill first had been the
  weaker option; the hook makes the order a fact, at the cost of one extra call.

## Not verified

- A live CLI run showing the skill listed as `slaude:skill-authoring`, and the
  hook blocking a real `write_skill` call. The qualified name is derived from
  the plugin manifest and tested against it, not observed.
- The CLI's real `tool_response` shape for `Skill` success and failure. The
  hook treats an absent error as success.
- Whether the CLI ever sends the skill name with a leading slash
  (`/slaude:...`). The hook matches the exact name only, so that form would
  deny-loop.
- A session booted before the upgrade keeps its old prompt and no enforcement
  until its next reboot.
- Minor, left alone: a late PostToolUse from an aborted detached process can
  mark a skill loaded; a pre-existing directory with a built-in's name cannot be
  deleted through `delete_skill`; the installer's check modes count a
  built-in-named manifest entry as unsatisfied.
