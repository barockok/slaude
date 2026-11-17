# agent.yaml only, no soul extraction (rc.17) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A persona's structure (access, mandates, proactive settings) is read from `agent.yaml` and nowhere else. The model call that read it out of `SOUL.md`, its signed cache and its regex fallback are gone from every runtime path.

**Architecture:** rc.16 made `agent.yaml` a complete definition on disk and in sync. rc.17 removes the other source. A persona with structure only in `SOUL.md` is refused loudly (boot, sync, console edit) with the command that converts it. The extractor survives only inside the offline `personas migrate` and `personas export --format agent-yaml` commands, which exist to read old souls once.

**Tech Stack:** Bun, TypeScript, Zod. No schema change, no new migration.

---

## What the extraction still serves today (survey)

| Path | Where | After rc.17 |
|---|---|---|
| Boot prewarm of the default soul | `src/server.ts:77`, `loadSoulData` | gone |
| Disk default soul pair on a managed-to-disk switch | `src/persona/registry.ts` (`diskSoulDataLoader`) | the file default's pair, or refuse |
| Persona sync of a legacy SOUL.md persona | `src/persona/sync/run.ts` (`extractSoulData`) | refused: payload persona must carry a definition |
| Console edit of a persona's soul | `src/gateway/panel/api.ts` (`SoulExtractionError`) | agent.yaml personas edit prose only (exists); legacy personas refused (409) |
| `slaude validate` | `src/cli/validate.ts` | validates agent.yaml (it never read one) |
| `personas export --format agent-yaml`, `personas migrate` | `src/cli/personas.ts` | keep, CLI only |
| Cache fallbacks | `cachedSoulData` in `scheduler.ts`, `mono-soul.ts`, `persona-mandates.ts`; `soulDataBase` in `gateway.ts` | gone; `compiledSoulFor` and the memo only |
| Node reading soul text | `src/node/worker.ts` (`mandateTextFromSoulText`), bundle `channelClasses` (`tenants.ts`) | gone: every bundle that has structure carries `soulJson` |
| Starter persona | `src/soul/loader.ts` `STARTER_PERSONA`, `install.sh` hint | a starter `agent.yaml` |

`soulData()`, `setSoulData`, `soulForChannel`, `channelMandate`, `withManagerApprover` and the runtime `/soul` overlay stay: they are the default persona's compiled structure and the overrides on it, not extraction.

## Decisions to confirm

1. **Legacy sync layout (SOUL.md + persona.yaml in a git repo) is refused**, not kept behind a flag. The error names `personas export --format agent-yaml`. A persona already stored keeps running on its stored `soul_json`; only a new sync of it is refused. v0.46.0 is still an RC series, and the notes carry a migration section.
2. **The extractor stays, CLI only.** `personas migrate` and `export` still read an old soul with the model (cache first, strict, grounded), because that is the one place a human reviews the result before it is written. The alternative, a deterministic parser for free-form souls, would misread some and is not worth building for a one-time step.
3. **A `SOUL.md` with no `agent.yaml` stops the boot** (default and named personas), naming `personas migrate`. A soul with no structure source would otherwise start with no access list and look healthy.

## Tasks

### Task 1: refuse at boot, starter agent.yaml, validate

Files: `src/persona/registry.ts`, `src/persona/file-agent.ts`, `src/soul/loader.ts`, `src/cli/validate.ts`, `install.sh`, tests under `tests/persona/` and `tests/soul/`.

A persona directory (or `$SLAUDE_HOME`) with `SOUL.md` and no `agent.yaml` throws at load with the persona name. A fresh home seeds a starter `agent.yaml` (soul prose, no manager, placeholder-free) instead of a SOUL.md, with the existing "fill it in" warning. `slaude validate` compiles the agent.yaml and prints the same warnings `personas render` does. Test: boot refusal, starter seeds a file that compiles, `validate` on a good and a bad file.

### Task 2: refuse legacy personas in sync and the console

Files: `src/persona/sync/run.ts`, `src/persona/sync/payload.ts`, `src/cli/personas.ts` (`renderDir`), `src/gateway/panel/api.ts`, tests.

A payload persona without `definition` is refused with the persona name and the export command. `personas render` refuses the three-file layout the same way, so the pull request fails, not the deploy. The console's persona soul edit returns 409 for a persona without a definition. Test: each refusal, and that a stored legacy row still serves.

### Task 3: delete the runtime extraction

Files: `src/soul/extract.ts`, `src/soul/data.ts` (`EXTRACTION_PROMPT`), `src/server.ts`, `src/persona/registry.ts`, `src/background/scheduler.ts`, `src/voice/mono-soul.ts`, `src/soul/persona-mandates.ts`, `src/gateway/core/gateway.ts`, `src/gateway/sim/*`, create `src/cli/legacy-soul-extract.ts`.

Move `extractSoulData`, the grounding check, the cache and `callExtractor` into the CLI module; delete `loadSoulData`, `cachedSoulData`, `regexFallback` and the cache from runtime. `soulDataBase` returns the memo or an empty soul. Remove the cached-soul fallbacks in the readers listed above. Tests: delete `tests/soul-extract.test.ts` and `tests/soul/cache-path.test.ts`, move `extract-strict` to the CLI module, and fix every test that primed the cache (`setSoulData` already covers most).

### Task 4: nodes stop parsing soul text

Files: `src/node/worker.ts`, `src/agent/manager.ts`, `src/soul/persona-mandates.ts`, `src/gateway/api/tenants.ts` (`channelClasses`, `bundleWithChannelClasses`), tests `tests/node/*`.

Delete the text parse path and the `channelClasses` bundle field. A bundle with no structure means a persona that is refused elsewhere; the node treats it as having no mandate. Test: node e2e with a compiled persona and with a null-soulJson bundle.

### Task 5: docs, notes, release

`docs/site/_content/deploy/personas-as-code.md` (SOUL.md section becomes "migrating"), the getting-started and soul guides, `README.md`, a field note, `docs/site/_content/releases/v0.46.0.md` (rc.17: warning block with the three refusals and the migration command), CLAUDE.md Findings Log line.

### Task 6: ship and deploy

Leak scan, CI, review (independent, with the same brief as rc.16: name fallback, access silently empty, boot loops), squash merge, version PR, tag `v0.46.0-rc.17`. Box: `sudo /usr/local/sbin/slaude-backup`, bump `SLAUDE_VERSION`, `apply.sh sumopod 81-slaude`, `verify` at 0 FAIL, Slack smoke in #barock-x-sam. The box already holds agent.yaml only, so no persona change is needed.

## Risks

- **Boot loops.** A refusal at boot with a restart policy loops. The message names the fix, `verify` already fails on both files, and the box has no SOUL.md left. Task 1 includes a test that the refusal throws before any other boot work.
- **A synced tenant with legacy personas** keeps serving from stored rows but cannot sync until migrated. The refusal message is the whole mitigation, so it must name the export command and the persona.
- **Mixed-version cluster.** A new gateway with an old node: the node still parses soul text and ignores the missing `channelClasses`. Upgrade gateway and nodes together, as the RC rule already asks.
