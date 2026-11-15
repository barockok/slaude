# Domain environments, slice E: shared environments as definitions and the `environment:` key

> For Claude: use superpowers:executing-plans, task by task. One task per commit. A release boundary is a hard stop: soak, check the gate, then continue.

Goal: a shared environment (a build box, a team sandbox) is declared once in its own definition file in the deploy repository (or on disk for a filesystem tenant), synced into the gateway, and an agent refers to it with `environment: { default: env:team-sandbox, allow: [env:team-sandbox] }`. A thread may use a shared environment only through an agent that allows it. Per-person environments stay runtime records and behave exactly as today. An agent with no `environment:` key behaves exactly as today, so nothing changes until an agent declares one. Delivered as two releases (rc.22, rc.23): rc.22 ships the format, the sync, the key and the `/env use` check; rc.23 turns on the two behaviours that have a legacy answer (the dispatch-time check and the default environment).

Spec: `docs/superpowers/specs/2026-11-12-domain-model-and-references.md` (sections "Node and environment binding" and slice E). Builds on slice A (`src/refs/parse.ts`, `env:<id>` is already an internal kind) and slice C's flag-and-shadow pattern (`src/access/decide.ts`). Field notes: `docs/site/_content/field-notes/2026-10-19-remote-environments.md`, `2026-10-01-remote-exec.md`.

Not in this slice: provisioners (none is registered; a `provisioned` definition is accepted and refused at use until one registers), slice D, slice F, per-environment node labels (`runsOn` stays one label on the agent), editing shared environments from Slack or the console.

## Findings in the current code (verified, shape the design)

1. `environments` rows are keyed by (team_id, user_id, name) and every use path assumes an owner: `useEnvironment` (`src/gateway/core/env-command.ts`) refuses a row whose `userId`/`teamId` differ from the actor (`env.own_environment`), `handleRemoteEnv` (`src/gateway/api/remote-env.ts`) 409s when `b.env.teamId !== claims.team`, and `userMachineConnectInfo` (`src/remote/env-runtime.ts`) reads the owner's key with `Remote.getKey(env.teamId, env.userId)`. A definition row with a sentinel owner is therefore refused by every existing path until a task changes that path on purpose. That is the safe default this plan builds on.
2. `trustOf` (`src/remote/kinds/index.ts`) returns the kind's class: ssh and tailcat are `user-machine`, which needs a LOCKED 1on1 owned by the env owner (`activeRemoteTarget`, `src/remote/active.ts`). A shared box has no owner, so a definition row needs its own answer (task 9).
3. `/env` commands never see the agent: `RemoteCommandCtx` has no persona, although `remoteCommandCtx` in `src/gateway/core/gateway.ts` (around line 2153) receives `personaId`. The Use button path (`envCtxForOffer`) already carries `session.persona_id`.
4. A binding whose environment row is missing or whose kind is unknown makes `activeRemoteTarget` return null, which means "run locally" (`boundEnv`). Fine for a deleted personal environment, wrong for a shared one that was retired or is no longer allowed: the field note rule is "never a fallback to the server".
5. `definitionSpec` in `src/persona/sync/payload.ts` is `.strict()`, so an older gateway refuses a `definition.environment` key. That is fail safe but the message is poor; `payloadVersionFor` must name it (version 7).
6. Agents on disk (`src/persona/file-agent.ts`) refuse `model`, `mcp`, `runsOn`, `provider`, `kbSources`, `background`, `userToken` ("cannot be set in a file on disk yet"). `environment:` is NOT added to that list: a filesystem tenant defines environments on disk too (task 6).
7. The console page named "Environments" (`src/web/console/pages/EnvironmentsPage.tsx`, `environmentsView` in `src/gateway/panel/console-views.ts`) is about node pools and `runsOn`, plus a read-only list of personal environments (`listAllEnvSummaries`). It has no write route today, so "read only in the console" is a test, not a new guard.
8. Payload sync is Postgres only (`/deploy` returns 409 on sqlite); sqlite and unmanaged Postgres tenants read `$SLAUDE_HOME`. The `environments` table exists in both dialects (0018 and its mirror in `src/db/drivers/sqlite.ts`).

## Definition file format

Location: `environments/<name>.yaml` in the deploy repository, beside `personas/` and `guardrails/`; for a filesystem tenant `$SLAUDE_HOME/environments/<name>.yaml`. `<name>` matches `^[a-z0-9][a-z0-9-]{0,31}$` (no dot or underscore, so ids stay unambiguous) and must equal the `name:` key. The file's name is the reference: `env:<name>`.

```yaml
# yaml-language-server: $schema=https://barockok.github.io/slaude/schemas/environment.schema.json
name: team-sandbox
description: Shared build box for the platform team.
kind: ssh                    # ssh | tailcat | provisioned
defaultDir: /srv/work        # absolute path, or ~/..., same rule as /env use
ssh:                         # present exactly when kind is ssh
  host: build-box.example.com
  user: dev
  port: 22                   # optional
  hostKey: "SHA256:<43 chars>"   # required: no trust on first use for a shared box
```
- `kind: tailcat` takes `tailcat: { addr: <tailcat address> }`. `kind: provisioned` takes `provisioned: { provisioner: <registered kind name>, options: { <key>: <string> }, secretRefs: { <NAME>: env://VAR | vault://path#field } }`.
- Strict keys at every level (Zod `.strict()`); exactly one kind block, matching `kind`. Unknown keys are refused, naming the key and never the value.
- Secrets by reference only. There is no key for a private key, password or token. A key named like one (`key`, `privateKey`, `password`, `token`, `secret`, `apiKey`) gets a dedicated message ("secrets are never written in a definition; slaude generates the ssh key itself, other secrets go in secretRefs"). Every string value is scanned with the same token and PEM shapes `personas export` refuses (`src/cli/personas.ts`, "Token shapes refused"). `secretRefs` values go through `parseRef` (`src/secrets`) and the same allowed-prefix check as `provider` (`checkVaultRefs`); they are stored as references and resolved only when a sandbox is provisioned.
- The ssh or tailcat key pair is generated by the gateway at first sync (`generateSshKeyPair`), stored in `remote_keys` under (team `definition`, user `<name>`), and only the public key is ever shown (console page, `slaude env pubkey <name>`). The operator installs it on the box once, as `/env key` does for a person.
- Per-kind field values are validated by the registered kind's own `parse()` (`sshKind.parse`, `tailcatKind.parse`), so the rules cannot drift from `/env add`. The ssh host's outbound-policy check (`checkSshHost`) runs at connect, as today, not at sync.

Agent key (`agent.yaml`):
```yaml
environment:
  default: env:team-sandbox        # optional; must also be in allow
  allow: [env:team-sandbox]        # required, 1 to 16 entries, no repeats
```
- Strict object; only typed `env:<name>` references (a bare name is refused, this key is new so it starts typed). Any other key, in particular `kind`, `host`, `addr`, `ssh`, `config`, `secrets`, gets the inline-config refusal: "environment configuration cannot be written in agent.yaml: define it in environments/<name>.yaml and refer to it as env:<name>". Key order in the error: first offending key only.
- `default` without `defaultDir` on the target definition is refused at sync (a default must be usable without asking).

## Data model

Migration `0042_environment_definitions.sql` (rc.22, both dialects, mirror in `src/db/drivers/sqlite.ts`, additive):
```
environments  ADD source TEXT NOT NULL DEFAULT 'user'          -- 'user' | 'definition'
              ADD definition_name TEXT NULL
              ADD definition_hash TEXT NULL                    -- sha256 of the canonical definition JSON
              ADD definition_revision TEXT NULL                -- the sync revision that last changed it
              ADD description TEXT NULL
              ADD retired_at BIGINT NULL
UNIQUE INDEX idx_environments_definition ON environments (tenant_id, definition_name) WHERE definition_name IS NOT NULL
```
A definition row: `id = d_<tenant>_<name>` (tenants and names have no underscore, so it is unambiguous and cannot collide with a UUID), `team_id = 'definition'`, `user_id = <name>`, `name = <name>`, `config` the canonical non-secret config, `secrets` NULL (references live in `config.secretRefs`), `default_dir` from the file. Old binaries ignore the new columns and still read the row; they then treat it as a personal environment of nobody, which every existing path refuses (finding 1). No `env_bindings` change: a binding names `env_id`.

Where the agent's key is stored: inside the persona's existing `definition` JSON (`PersonaDefinition.environment = { default?: string; allow: string[] }`, names without the `env:` prefix). No persona column, no persona migration. Payload version 7 (below).

`env:<name>` resolves with `resolveEnvRef(tenant, name)` in `src/remote/definitions/resolve.ts`: the row with that `definition_name`, not retired. `src/refs/resolve.ts` keeps returning `record: null` for `env` kinds (slice A contract); only sync and runtime use the new resolver.

## Ownership rules

- A definition-managed row is written only by the definition sync (`src/remote/definitions/sync.ts`). `updateEnv`, `deleteEnv`, `createEnv` in `src/db/environments.ts` throw `DefinitionManagedError` for `source = 'definition'` (defense in depth under the command checks).
- `/env edit|rm|add` on a shared name answers "`team-sandbox` is defined in the repository; change it there". The Slack add form and `findEnvByName` stay personal-only; a personal name equal to a shared name is allowed (existing rows may already collide) and the bare name resolves to the person's own first. `/env use env:team-sandbox` always means the shared one.
- Removing a file from the repository RETIRES the row (`retired_at` set); it is never deleted. Bindings keep their `env_id`; a retired environment fails closed (task 11). Re-adding the file revives it (clears `retired_at`).
- Per-person environments, keys, bindings, `/remote`, the picker for personal rows, the host-key TOFU pin: unchanged.
- The console shows definition rows read only with a "defined in repository" badge; there is no write route to guard, and a test asserts none is added.

## Enforcement design

Pure function `envAllowed(policy, env)` in `src/remote/definitions/policy.ts`: no policy (agent has no `environment:`) means shared environments are NOT usable by that agent (a shared environment is opt-in per agent) and personal ones are unaffected; with a policy, a shared environment is allowed iff its name is in `allow` and it is not retired. `policyFor(personaId)` reads `definition.environment` from the persona registry (`getPersonaRegistry().lookupByName`, `default` through `defaultPersona`).

Trust class of a definition row: `trustOf` returns `provisioned` (the existing "no lock needed" class) for `source = 'definition'`, whatever the kind's own class. Reasoning: the box is shared infrastructure with no personal data, the agent's allow list is the gate, and the agent's existing approvals still show every Bash, Write and Edit to the approver. It reuses the sandbox path end to end (`activeRemoteTarget` skips the lock rule, `thread-identity.ts` skips run-as, `EnvRef.trust` on the wire is already `provisioned`). `connectInfoForBinding` still picks the key path by the KIND's class, so a shared ssh row connects with the generated key (finding 1) and a real provisioned kind goes through `provision`.

Enforcement points:
1. Bind time (`useEnvironment`): enforced from rc.22, no shadow, because there is no legacy behaviour to protect (shared environments did not exist). Order: kind known, row not retired, agent policy allows it, then directory and pre-flight. Refusals are plain and name the environment, never the host: "This agent is not set up to use `team-sandbox`", "`team-sandbox` has been retired", "`team-sandbox` needs a directory: set defaultDir in its definition".
2. Dispatch time (gateway side, where the remote claim is built, `src/gateway/core/dispatch.ts` near the `sessionConfigFp` call): a bound definition environment that is retired or no longer allowed by the agent (the agent was redefined) is checked on every turn. rc.22 shadow: counted, turn proceeds. rc.23 enforce: the turn is not run; the thread gets one notice ("This thread's environment is no longer available to this agent. `/env off` returns to the default.") and nothing runs locally. The check is on the gateway, before the job token is signed, so no node change.
3. Remote-env API (`handleRemoteEnv`): a definition row passes the `teamId` check by `source`, and is served only while the thread is bound to it with the claimed hash (existing rule) and the dispatch check above would pass.
4. Default: when a thread has no binding and the agent has `environment.default`, the first dispatch binds it with `bindIfAbsent` (insert-only, `ON CONFLICT DO NOTHING`, so it never overwrites a user's `/env use`). rc.22 shadow: counted (`default_would_bind`), nothing bound. rc.23 enforce: bound, dir from `defaultDir`, provisioned kinds start through the existing `ensureProvisioned`.
5. `/env off` on a thread of an agent with a default clears the binding and the next turn binds the default again; the status line says so. Server-side execution is expressed by an agent that has no `environment:` key.
6. `/env use env:other` where `other` is allowed but not the default: allowed. `/env use <personal>` with a policy: allowed (see decision D3).

Failure modes (tests first, task 12): policy lookup throws (registry error): `/env use` of a shared env is refused, an already-bound turn is counted `error` and proceeds in shadow, is refused in enforce; definition row read throws: same; key missing for a shared ssh row: `REMOTE_AUTH_FAILED` with "ask an operator to install the environment's key" and the public key is shown only on the console; unknown provisioner: "environment kind not available on this deployment" (existing text).

Flag `SLAUDE_ENV_POLICY=off|shadow|enforce` (`src/config/env.ts`, read per call, unknown value refuses boot like the other security switches via `securitySwitchViolations`). Default `shadow`. It governs enforcement points 2 and 4 only; point 1 and the format are always on, but inert until a file or an agent key exists. `off` also skips the shadow counters.

Metrics: `slaude_env_policy_total{site,outcome}` (site: `use`, `dispatch`, `default`, `api`; outcome: `allowed`, `refused`, `would_refuse`, `retired`, `error`); `slaude_env_definitions_synced_total{result}`.

## Node and runsOn

`runsOn` is untouched: one label on the agent, a pool. A definition carries no node label; the node that runs the agent's turn opens the connection (split deployment: it fetches the transport and key from the gateway as today). Consequences, documented and not engineered around in this slice: the box must be reachable from every node carrying the agent's label; the ssh host check runs on the gateway and the connection is made from the node. A sync warning is added only for a cheap, certain case: an agent allows a shared environment whose kind is `provisioned` while its provisioner is not registered ("not usable until a provisioner registers"). Nodes older than the environments release (0.45.x) would run an unlocked environment turn locally (field note, "The gap that remains"); the rollout checks every node's version before the first agent declares `environment:`.

## Sync path

Payload version 7 adds a top-level `environments` list (like `guardrails`): absent leaves stored definitions alone; present (even empty) is the whole set, and a definition no longer listed is retired. `PERSONA_FIELD_VERSION` gains `environment: 7` read from `definition.environment`, and `payloadVersionFor` also returns 7 for a non-empty `environments`; `SUPPORTED_PAYLOAD_VERSION = 7`. A payload that sets neither stays at its old version and deploys to any gateway, so rc.22 adds no risk to existing repositories.

In `runSync` (`src/persona/sync/run.ts`), phase one (no transaction): parse and validate the definitions, canonicalise, hash; resolve every agent `environment` reference against payload definitions, else stored non-retired definitions when the payload omits the list; refuse (422) on: unknown environment, default not in allow, default target without `defaultDir`, a definition with unknown kind block, a name that is not the file name, duplicate names. Messages name persona, field and environment, never a value. Phase two: `applySync` writes the definition rows in the SAME transaction as the personas (so an agent and the environment it names land together or not at all): insert, update when the hash changed (`updated_at` moves, so every warm session's fingerprint changes and reboots, exactly like an edit today; an unchanged hash writes nothing and reboots nothing), retire, generate a key pair for a new ssh or tailcat row. Report: `environments: { created, updated, unchanged, retired }` plus `wouldCreate` in a dry run; names only. Audit: `environment.definition_synced` once per changed row (name, kind, revision), through `emitAudit` after commit.

Filesystem tenants: `src/remote/definitions/files.ts` reads `$SLAUDE_HOME/environments/*.yaml` with the same parser and runs the same upsert at boot and on the registry reload signal; a bad file is refused with the file named and the previous rows stay. An agent on disk with `environment:` is resolved against those files when its registry snapshot loads (`readFileAgent`), with the same refusals.

## Tasks

### rc.22: format, sync, key, bind-time check (dispatch check and default in shadow)

1. Migration 0042.
   - Files: `src/db/migrations/0042_environment_definitions.sql`, `src/db/drivers/sqlite.ts`, `tests/db/environment-definitions-schema.test.ts`, `tests/db/schema-drift.test.ts` (no new table; confirm columns).
   - Tests first: upgrade from 0041 with existing personal rows (`source` defaults to `user`, new columns NULL); old insert shape still works; the partial unique index refuses a second `(tenant, name)`; `SLAUDE_DB=pg` too.
2. Definition schema and parser.
   - Files: `src/remote/definitions/schema.ts` (Zod, strict, discriminated by `kind`), `src/remote/definitions/parse.ts` (`parseEnvironmentYaml(name, text)` returning the canonical spec, reusing the kinds' `parse()`), `tests/remote/definitions/schema.test.ts`.
   - Tests first: every kind valid; each unknown key refused with its path and no value; name must equal the file name; a secret-looking key and a token or PEM value refused with the dedicated message and the value absent from the error; `secretRefs` accept `env://` and `vault://`, refuse a plain value; ssh without `hostKey` refused; duplicate YAML keys refused (the `yaml` package already does).
3. JSON Schema for definitions.
   - Files: `scripts/gen-agent-schema.ts` (also emit `docs/site/schemas/environment.schema.json`), `package.json` script `schema:agent` runs both, `docs/site/schemas/environment.schema.json`, `tests/remote/definitions/json-schema.test.ts` (committed file equals generated, like `tests/persona/agent-schema.test.ts`).
4. `environment:` key on agent.yaml.
   - Files: `src/persona/agent-schema.ts` (strict `environment` object, typed refs only, `.describe()` text for hover help, the inline-config refusal through an `errorMap` on `unrecognized_keys`), `src/persona/agent-def.ts` (compile to `spec.definition.environment`, refuse default outside allow and repeats, `AgentDocumentInput.environment` and `agentDocument` emit it), `src/persona/sync/payload.ts` (`definitionSpec` gains `environment`, `PERSONA_FIELD_VERSION.environment = 7`, `SUPPORTED_PAYLOAD_VERSION = 7`, `payloadVersionFor`), `src/persona/types.ts` and `src/persona/registry.ts` (carry it on the persona), `docs/site/schemas/agent.schema.json` regenerated with `bun run schema:agent`, tests in `tests/persona/agent-def-environment.test.ts`, `agent-schema.test.ts`, `payload.test.ts`.
   - Tests first: valid default plus allow; allow only; `environment: env:x` (a bare string) refused; a bare name refused; each of `kind`, `host`, `addr`, `ssh`, `config`, `secrets` under `environment:` gets the inline-config message; `agent:x` or `user:x` references refused as "takes env"; default not in allow; repeat; 17 entries; version stays 6 when no agent sets it, 7 when one does; a gateway at 6 refuses a 7 payload with the upgrade message; every existing agent fixture compiles byte-for-byte as before (golden against `tests/persona/agent-corpus`).
5. Definition sync (database tenants).
   - Files: `src/remote/definitions/sync.ts` (`planDefinitions`, `applyDefinitions(tx, ...)`), `src/remote/definitions/resolve.ts`, `src/persona/sync/payload.ts` (`environments` list, `payloadSchema`), `src/persona/sync/run.ts` (phase one validation and refusals, report), `src/db/personas.ts` (`applySync` takes `environments`, same transaction), `src/audit` event, `tests/persona/run-sync-environments.test.ts`.
   - Tests first: create, no-op resync (nothing written, `updated_at` unchanged), change (`updated_at` moves, hash changes), retire on omission, revive, absent list leaves rows alone, empty list retires all; a failure in the persona half rolls back the definition half and the reverse; an agent naming an unknown, retired or undefined default is a 422 and applies nothing; a dry run writes nothing and reports `wouldCreate`; concurrent syncs serialise on the sync-state row; key pair generated once and kept across updates; the report and every log line contain no host, address or key.
6. Filesystem tenants.
   - Files: `src/remote/definitions/files.ts`, `src/persona/registry.ts` (load definitions with the registry, resolve disk agents' `environment:`), `src/persona/file-agent.ts` (accepts `environment`), `src/persona/boot.ts` and `disk-check.ts` (a bad definition is a boot warning naming the file, previous rows stay), `tests/remote/definitions/files.test.ts`, `tests/persona/registry-file-agent.test.ts`.
   - Tests first: sqlite and pg; a file added, edited, removed (retired); a disk agent referencing a missing file is refused with the key named; a file agent can still not set `runsOn` or `model`.
7. Ownership guard in the data layer.
   - Files: `src/db/environments.ts` (`DefinitionManagedError`; `StoredEnv` gains `source`, `retired`; `toEnv` reads the new columns), `src/remote/kinds/types.ts`, `tests/db/environments-definition-guard.test.ts`.
   - Tests first: `updateEnv`, `deleteEnv` and a name-changing update refuse a definition row; `listEnvs(team, user)` and `listAllEnvSummaries` behaviour for personal rows is byte-identical; `convertLegacy` unaffected.
8. Policy module.
   - Files: `src/remote/definitions/policy.ts` (`policyFor`, `envAllowed`), `tests/remote/definitions/policy.test.ts`.
   - Tests first: no policy means a shared env is not allowed and a personal one is not affected; allow hit and miss; retired; default persona; unknown persona; registry throw returns an error result, never `allowed`.
9. Trust and connect path for definition rows.
   - Files: `src/remote/kinds/index.ts` (`trustOf` returns `provisioned` for `source = 'definition'`), `src/remote/active.ts` (no lock rule for it; a retired row yields no target), `src/remote/env-runtime.ts` (key from `Remote.getKey('definition', name)`), `src/gateway/api/remote-env.ts` (team check by `source`), `tests/remote/environments.test.ts`, `tests/remote/definitions/connect.test.ts`.
   - Tests first: a shared ssh row yields a `provisioned` `EnvRef`, no lock needed, the generated key reaches the helper; a personal row is unchanged (existing tests untouched and green); `handleRemoteEnv` serves a shared row for the bound thread only, 409 after retire, 409 for a hash mismatch; the personal owner check still applies to personal rows; fingerprint (`src/remote/fingerprint.ts`) of every personal and tailcat row is byte-identical to before.
10. `/env use` check, listing, read-only commands.
    - Files: `src/gateway/core/env-command.ts` (`RemoteCommandCtx.personaId`; `useEnvironment` branch for `source = 'definition'`: allow check, no own-environment, no foreign-cron rule, no lock rule, `lockByEnv` false; `list`, `status` and `edit|rm` messages; `env:<name>` parsing of `/env use`), `src/gateway/slack/commands.ts` (parse `env:<name>` as a name form, usage text), `src/gateway/core/gateway.ts` (`remoteCommandCtx` passes `personaId`; picker offers allowed shared rows), the picker blocks file, `tests/gateway/env-command-shared.test.ts`, `tests/commands.test.ts`.
    - Tests first: use of an allowed shared env binds and says which; an agent with no policy refuses with the exact text; a non-allowed one refuses; retired refuses; a missing `defaultDir` with no argument refuses and names the fix; personal flows byte-identical (the existing `tests/remote` and env command tests run unchanged); `edit`, `rm` and `add` over a shared name refuse; the reply never contains host, address, key or hash; the Use button path for a shared row re-checks the allow list (the button can outlive an edit).
11. Dispatch-time check and default binding, shadow only.
    - Files: `src/config/env.ts` (`env.envPolicy.mode()` and boot validation), `src/remote/definitions/gate.ts` (`checkBound`, `defaultFor`), `src/gateway/core/dispatch.ts`, `src/db/environments.ts` (`bindIfAbsent`), `src/metrics.ts`, `tests/gateway/env-policy-shadow.test.ts`.
    - Tests first: shadow counts `would_refuse` and `default_would_bind`, changes no turn and writes no binding; `off` counts nothing; `bindIfAbsent` never overwrites a binding and two racing callers produce one row; an unknown flag value refuses boot.
12. Failure-mode tests (the matrix above) in `tests/gateway/env-policy-failure.test.ts`, written before the enforce code of rc.23 so they pin the shadow answers now.
13. Render, export, migrate.
    - Files: `src/cli/personas.ts` (`renderDir` reads `environments/*.yaml` into the payload, `--check` validates them and reports unresolved agent references offline; `exportHome` and `exportAgentYaml` copy `environments/` after re-validating and refusing unknown keys, and write `environment:` from the stored definition), `src/persona/migrate.ts` (untouched in behaviour: a SOUL.md persona has no environment; add a test that migrate neither adds nor drops the key and that an `environments/` folder beside the home is left alone), `tests/cli/personas-agent-yaml.test.ts`, `tests/cli/personas.test.ts`, `tests/persona/migrate.test.ts`.
    - Tests first: render of a repository with and without `environments/` (payload version 6 without, 7 with); `--check` fails on an agent naming a missing file; export round trip (export, render, equal payload); an `environments/` file holding a token-shaped value stops the export; migrate golden unchanged.
14. Console, read only.
    - Files: `src/gateway/panel/console-views.ts` (`environmentsView` adds `shared: [{ name, kind, description, defaultDir, retired, revision, publicKey, agents: [persona names that allow it], bindings }]`; no config, no host), `src/gateway/panel/api-types.ts`, `src/web/console/pages/EnvironmentsPage.tsx` (a "Shared environments" table with a "defined in repository" badge and the copy-public-key action), `src/web/console/dev/fixtures.ts` and `stub.ts`, `tests/gateway/panel-environments.test.ts`, web tests.
    - Tests first: payload has no host or address; superadmin and operator see the key, viewer does not; a test enumerates the panel routes and fails if one accepts a definition id for a write.
15. CLI helper `slaude env pubkey <name>` and `slaude env list --definitions` (read only, prints names, kind, retired, revision). Files: `src/cli/env.ts` (new), `tests/cli/env.test.ts`.
16. Docs and release rc.22.
    - Files: `docs/site/_content/guides/environments.md` (new section "Shared environments": definition file, trust class, what an agent must declare, node reachability, the gap with pre-0.45 nodes), `docs/site/_content/deploy/personas-as-code.md` (layout, `environment:` key, payload version 7, render and export), `docs/site/_content/field-notes/2026-11-15-domain-environments.md`, `docs/site/_content/releases/v0.46.0-rc.22.md`, `CLAUDE.md` index line, `docs/site/nav.json`, spec slice E marked "implemented in rc.22 and rc.23, what differs".
    - Gate before rc.23 (3 days on a deployment that declares at least one shared environment, or the live smoke below passing twice): `slaude_env_policy_total{outcome="error"}` zero; `would_refuse` explained one by one (each is an agent edited under a live thread); `default_would_bind` volume matches the count of new threads of agents with a default; no `REMOTE_AUTH_FAILED` for a shared row after the public key was installed; every node on a release that knows environments.

### rc.23: enforce the dispatch check, apply the default

17. Enforce.
    - Files: `src/remote/definitions/gate.ts`, `src/gateway/core/dispatch.ts`, `src/gateway/core/env-command.ts` (`/env off` text and behaviour for agents with a default), `src/config/env.ts` (default flips to `enforce`), tests extending `env-policy-shadow.test.ts` into `env-policy-enforce.test.ts`.
    - Tests first: a bound environment the agent no longer allows stops the turn with one notice per thread per hour and nothing runs locally; a retired one same; `/env off` then next turn binds the default; an agent with no default and a disallowed binding gets the notice and `/env off` returns to the server; default bound with `defaultDir` for a ssh row and starts a sandbox for a fake provisioned kind (`tests/remote/mono-env.test.ts` style); a user's own `/env use` in the same instant is never overwritten; reverse shadow counts `legacy_would_run` for what the old behaviour would have done.
18. Console additions: per environment, the threads currently bound (counts only), agents that default to it; the agent detail page shows `environment` (default and allow, with a link to the definition row). Files: `console-views.ts`, `AgentDetailPage.tsx`, `definition-view.ts` (`fields.environment`), tests.
19. rc.23 release: release note, field note update, spec update, docs; the flag default `enforce` documented with `SLAUDE_ENV_POLICY=shadow` as the rollback.

## Test strategy

- Unit: schema, parser, policy, resolver, canonical hash (key order and whitespace do not change the hash).
- Golden: every existing agent and environment fixture produces the identical compiled output, fingerprint and job claim as before; a test builds the claim for a personal environment before and after and compares.
- Integration: sync (pg), filesystem load (sqlite and pg), `/env` flows through the existing command test harness, remote-env API, dispatch with a fake kind (`tests/remote/mono-env.test.ts`), render and export round trip.
- Security: no secret, host, address or key in any error, report, log, audit event, console payload or thread reply (a shared helper greps outputs for a planted host and token); a shared row cannot be edited or deleted through any path; an agent without the key cannot use a shared environment through the picker, `/env use`, a stale Use button or a `/remote` alias; a definition cannot smuggle a secret through any key or value.
- Failure injection: registry throws, database throws mid sync, key generation fails (sync fails whole), provisioner missing.
- Commands: `bun test`, `SLAUDE_DB=pg bun test`, `bun run typecheck`, `bun run test:web`, `bun run schema:agent` then `git diff --exit-code docs/site/schemas`.

## Rollout

Per RC: backup before the version bump (`sudo /usr/local/sbin/slaude-backup`), deploy through the usual path, `verify` 0 FAIL, then the smoke below.

| RC | Changes | Behaviour change | Rollback |
|---|---|---|---|
| rc.22 | 0042, definition format, sync, `environment:` key, `/env use` check, console view, shadow dispatch check and default | none until a repository adds `environments/` and an agent declares `environment:`; then `/env use env:<name>` works for that agent only | remove the agent key and resync (agent loses the environment, bindings fail closed once enforcing, in shadow they keep running); or redeploy rc.21 (the new columns are ignored, shared rows are unusable there, personal rows untouched) |
| rc.23 | enforce dispatch check, default environment | a thread bound to a no-longer-allowed shared environment stops with a notice; new threads of an agent with a default start in it | `SLAUDE_ENV_POLICY=shadow` (or `off`), or rc.22 |

Rollback of data: nothing to undo. Definition rows are inert without an agent key; retiring is the only removal and a revive is one resync. Do not drop the 0042 columns.

Stable promotion waits 7 days on rc.23 with no unexplained `would_refuse` or `error` (`scripts/promote-rc.sh`). The shadow flag stays one stable release, then the `shadow` value is removed.

## Live smoke test (placeholders only; run after rc.22, repeat after rc.23)

1. On a test box `<box>` create a user and install nothing yet. In a scratch deploy repo add `environments/team-sandbox.yaml` (ssh, `host: <box-host>`, pinned `hostKey`, `defaultDir: ~/work`) and give a test agent `agent-a` `environment: { default: env:team-sandbox, allow: [env:team-sandbox] }`.
2. `slaude personas render <repo> --check` passes; remove the `hostKey` and see it fail naming the key; put a fake token in `description` and see the refusal without the value; put `host:` under `environment:` and see the inline-config message. Restore.
3. Dry-run, then sync (`/deploy?dryRun=1`, then real). Report lists one environment created and no host. Resync: `unchanged`, no session reboot. Console Environments page shows `team-sandbox` read only with its public key.
4. Install the public key on `<box>`. In a thread with `agent-a`: `/env` lists `team-sandbox` under Shared; `/env use env:team-sandbox`; ask the agent to run `hostname`; the answer is the box's, the thread is not locked, the approval card appears as usual. `/env edit team-sandbox` refuses. `/env off` returns to the server (rc.22).
5. In a thread with an agent with no `environment:` key: `/env use env:team-sandbox` refuses with the exact text; personal `/env use <mine>` still works and still locks the thread (regression check).
6. Edit `agent-a` to drop the allow, resync, send a message in the still-bound thread: rc.22 runs (shadow counter `would_refuse` rises); rc.23 stops with the notice and nothing runs on the server. Restore.
7. rc.23: start a new thread with `agent-a`; the first turn runs on the box with no `/env use`; `/env off` then another message binds the default again.
8. Remove the file, resync: the row is retired, the bound thread stops (rc.23), `/env list` no longer offers it; re-add and resync revives it.
9. Check `/metrics` for `slaude_env_policy_total` and the audit page for `environment.definition_synced`; grep gateway logs for `<box-host>` and the key: zero hits.

## Decisions needed from the owner (recommended default first)

- D1 Trust class of a shared ssh or tailcat box: unlocked threads, gated by the agent's allow list and the normal approvals (recommended; reuses the sandbox path). Alternative: require a locked 1on1 owned by the person who bound it (needs a `bound_by` column and a change to `RemoteTarget.userId`; strictly safer, much less useful for a team box).
- D2 Who holds the ssh key: slaude generates one per definition, the operator installs the public key (recommended, no secret ever in git). Alternative: an optional `keyRef: env://... | vault://...` to a key the operator manages.
- D3 Per-person environments for an agent that declares `environment:`: unaffected (recommended; the agent still cannot reach anything the person cannot). Alternative: an optional `personal: deny` key so an agent can forbid them.
- D4 `/env off` for an agent with a default: returns to the default (recommended); server execution is expressed by omitting the key. Alternative: allow `env:local` in `allow`.
- D5 Agent with no `environment:` key and a shared environment: not usable (recommended, opt-in per agent). Alternative: usable by every agent (not recommended).
- D6 Removing a file retires the row and fails bound threads closed (recommended). Alternative: delete the row and let bound threads run on the server (violates the "never fall back" rule).
- D7 `provisioned` definitions are accepted now but unusable until a provisioner registers (recommended, keeps the format stable). Alternative: refuse the kind until one exists.
- D8 ssh `hostKey` required in a definition (recommended; no trust on first use for shared infrastructure). Alternative: allow empty and pin on first pre-flight.
- D9 Name in the reference is the file name (`env:team-sandbox`), not the hidden internal id (recommended, because operators write it). The internal id `d_<tenant>_<name>` appears only in audit and the console.
- D10 Two RCs with the dispatch check and default in shadow first (recommended). Alternative: one RC enforcing everything.

## Risks

- A shared box used by many threads: one noisy or hostile thread affects the others. Mitigation: it is the operator's explicit choice per agent; approvals still apply; the console shows binding counts; D1 alternative exists.
- Pre-0.45 nodes run an unlocked environment turn locally. Mitigation: node version check before the first agent declares the key, noted in docs; no new exposure for nodes already on environments.
- Connection is made from the node, the host check from the gateway (existing split). A box reachable from the gateway but not from a node fails with `REMOTE_UNREACHABLE`; documented, `runsOn` unchanged by decision.
- A redefinition reboots warm sessions of every thread bound to the row (fingerprint). Mitigation: no-op syncs write nothing (hash compare).
- Name overload: the console page "Environments" is nodes and runsOn, the object here is an execution environment. Mitigation: the new table is titled "Shared environments"; docs say so.
- A personal environment may already have the same name as a shared one. Mitigation: bare name means personal first, `env:<name>` always shared, listing marks both.
- Retire without delete leaves rows behind. Mitigation: they are tiny, counted in the console, and a later explicit purge can be added.
- Sync and agent edits land together only through `/deploy`; a filesystem tenant edits two places. Mitigation: boot and reload validate both and keep the previous rows on error.
- Key pair generation inside the sync transaction: a failure fails the sync whole, by design (tested).
