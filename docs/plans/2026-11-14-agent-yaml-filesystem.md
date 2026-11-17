# agent.yaml for filesystem personas (rc.16) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A persona that lives on disk (the default persona and `personas/<name>/`) can be defined by an `agent.yaml`, read with no model call, so rc.17 can delete the soul-text extraction.

**Architecture:** A database-managed persona already carries `soulMd` (prose plus generated blocks), `soulJson` (the compiled structure) and `definition` in the registry snapshot, and every reader asks `definition` first. The filesystem loader compiles `agent.yaml` with the same `parseAgentYaml` and fills the same fields, so those readers need no change. The default persona is installed as the same soul pair the managed default row installs. A persona without `agent.yaml` is read exactly as before.

**Tech Stack:** Bun, TypeScript, Zod (`AgentSchema`), the existing `yaml` package.

---

## Scope (rc.16)

In: loader for `$SLAUDE_HOME/agent.yaml` and `personas/<n>/agent.yaml`; the global `proactive:` key; the node bundle for a filesystem agent.yaml persona; `slaude personas migrate`; migrating `sam` and the default persona on the box.

Out (later): `model`, `mcp`, `runsOn`, `kbSources`, `background`, `provider`, `userToken` in a filesystem agent.yaml. They keep coming from `config.json`, `mcp.json` and the environment, and the loader refuses them with a message saying so. Refusing structure left in `SOUL.md` is rc.17.

## Rules the loader follows

1. `agent.yaml` beside `SOUL.md` or `persona.yaml` is refused (same rule as the repo layout). `config.json` and `mcp.json` may sit beside it.
2. A malformed `agent.yaml` stops the process at boot with the persona name and key. It never skips the persona: an unlisted name on a filesystem registry falls back to the default persona, which would hand sam's channel to Trev's identity.
3. `slackUserId`: the file's value, else `config.json`'s. The token only ever comes from `config.json`.
4. The persona's access is exactly what its file says; nothing is inherited from the default (existing `exactAccess`). Migration therefore writes inherited access out.

## Tasks

### Task 1: global `proactive:` key

Files: `src/persona/agent-schema.ts`, `src/persona/agent-def.ts`, `docs/site/schemas/agent.schema.json` (regenerate), `tests/persona/agent-def.test.ts`, `tests/persona/agent-schema.test.ts`.

Keys: `proactive: { read: [channel refs], watch: [names], quietHours: "HH:MM-HH:MM", maxPerDay: int, enabled: bool }`. Compiled into a `## Proactive` block appended to the soul text, the form `parseProactive` already reads. Refuse an authored `## Proactive` section in `soul` that the key also sets (one place). Test: compiled soul text parses with `parseProactive` to the same values.

### Task 2: file agent reader

Files: create `src/persona/file-agent.ts`; test `tests/persona/file-agent.test.ts`.

`readFileAgent(dir, name)` returns null when there is no `agent.yaml`, else `{ soulMd, soulJson, definition, slackUserId, warnings }`, or throws `PayloadError`. It refuses `model`, `mcp`, `runsOn`, `kbSources`, `background`, `provider`, `userToken` (message names the key and where it lives instead) and legacy files beside it.

### Task 3: registry loads it

Files: `src/persona/registry.ts`, `src/persona/types.ts` (comment), `src/persona/soul-source.ts`; test `tests/persona/registry-file-agent.test.ts`.

`loadPersonas()` builds a `Persona` from the reader (no `SOUL.md` needed). The snapshot gains `defaultPersona()` for a file default (`model: null`, `mcp: null`, `definition`, `soulJson`) while `isManaged()` stays false. `loadPersonaState` returns the file default beside the registry; `refreshPersonaState` installs its soul pair (`setManagedDefaultSoul`, `setSoulData`), and switching away reloads the disk pair as it does for a managed row. `managedPersonaDefinition` stops requiring `isManaged()`.

### Task 4: node bundle

Files: `src/gateway/api/tenants.ts`; test `tests/gateway/api/tenants-file-agent.test.ts`.

Tier 2 ships `soulMd`, `soulJson` and `definition` for a persona that has `definition`. Tier 3 already ships `soulData()`; it also ships the default's `definition` when there is one.

### Task 5: `slaude personas migrate <name|default>`

Files: `src/cli/personas.ts`, `src/persona/migrate.ts`; tests `tests/persona/migrate.test.ts`.

Writes `agent.yaml` into the persona's directory (`$SLAUDE_HOME` for default), leaving `SOUL.md` in place until the operator removes it (the loader refuses both together, so migrate says so and offers `--remove-soul`, which moves `SOUL.md` to `SOUL.md.pre-agent-yaml`). Structure comes from the strict extraction (cache first), with the inherited access materialised: `soulDataFor(name)` is what is written, so the migrated persona admits exactly what the old one did. Secrets are never written; a persona with a `config.json` token keeps it there. Equality test: for a fixture persona with inherited access, the structure read back from the written file equals `soulDataFor` before.

### Task 6: docs, field note, release notes

`docs/site/_content/guides/deploy/personas-as-code.md` (filesystem section), a field note, `docs/site/_content/releases/v0.46.0.md` (rc.16 section), CLAUDE.md Findings Log line.

### Task 7: ship

Leak scan, full CI shards, PR, review, squash merge, tag `v0.46.0-rc.16`, wait for the release.

### Task 8: migrate and deploy the box (vps-hardening)

`sudo /usr/local/sbin/slaude-backup` first. Bump `SLAUDE_VERSION`. Run `personas migrate` against the repo copies of the default and sam souls, review the diff, commit `agent.yaml` (and move `SOUL.md` away), update `scripts/81-slaude.sh` and `scripts/verify.sh` to expect `agent.yaml`, `apply.sh sumopod 81-slaude`, verify 0 FAIL, Slack smoke test in #barock-x-sam (sam session, mandate, channel session and wake still work).
