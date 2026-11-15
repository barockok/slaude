# Domain environments, slice E: shared environments as definitions and the `environment:` key (narrow, safe)

> For Claude: use superpowers:executing-plans, task by task. One task per commit. A release boundary is a hard stop: soak, check the gate, then continue.

Goal: a shared ssh machine is declared once in a definition file in the deploy repository, synced into the gateway, and an agent names it in `environment: { allow: [env:team-sandbox] }`. A thread runs on it only after `/env use env:team-sandbox`, and only for turns of an agent that allows it. Everything is checked per persona at the point where the claim is built and served, and fails closed. Per-person environments, and agents with no `environment:` key, behave exactly as today.

Spec: `docs/superpowers/specs/2026-11-12-domain-model-and-references.md` ("Node and environment binding", slice E). Field notes: `docs/site/_content/field-notes/2026-10-19-remote-environments.md`, `2026-10-01-remote-exec.md`. `runsOn` stays one node label.

## What this slice cuts (and why)

- Database tenants only. A filesystem tenant is out: an agent can write under `$SLAUDE_HOME`, and the file guard covers only guardrails (`src/agent/guardrails.ts:200`), so an agent could write its own environment definition.
- Kinds: `ssh` only. `tailcat` (an address, which is sensitive and must not sit in git) and `provisioned` (no provisioner exists, `src/remote/kinds/index.ts:1-7`) are refused at sync with a clear message.
- No default binding. The `default:` key parses and is stored, and is not applied until a later gate (a bound-by-default shared machine in an unlocked thread is the riskiest part and needs its own soak).
- No console work beyond a read-only list. No `slaude env` CLI.
- Rotation of the generated key is a follow-up gate, not built here.

## Findings, verified in code

1. `env_bindings` is keyed by thread, not agent: `PRIMARY KEY (channel_id, thread_ts)` (`src/db/migrations/0018_environments.sql:38`). Agent A can bind a thread and agent B, answering in the same thread, would get the claim: `activeRemoteTarget(channelId, threadTs)` takes no persona (`src/remote/active.ts:28`), `threadIdentity` takes none (`src/gateway/core/thread-identity.ts:25`) and `handleRemoteEnv` hands the key to any token whose claim names the bound environment (`src/gateway/api/remote-env.ts`). So the allow check cannot live only in `/env use`; it must be in the claim path, for every persona, from the first release. There is no legacy behaviour for a new shared row, so there is nothing to shadow.
2. `environments` has `UNIQUE (team_id, user_id, name)` and no tenant in it (`0018:19`); `remote_keys` is `PRIMARY KEY (team_id, user_id)` (`src/db/migrations/0012*`, `src/db/remote.ts:86` `ON CONFLICT(team_id, user_id)`). A fixed sentinel owner would collide across tenants and share one private key. The `environments.tenant_id` column exists (0018) but nothing reads it.
3. "No target" means "run locally": `activeRemoteTarget` returns null for a missing binding, an unknown kind (`active.ts:18,20`) and a failed lock rule (`active.ts:33`); `threadIdentity` then sends no `remote` claim (`thread-identity.ts:34-40`); the mono path resolves with the same function and never passes through dispatch (`src/remote/mono.ts:20`, `monoRemoteResolver`). A retired or disallowed shared row must not look like that: it needs an explicit refusal.
4. `SLAUDE_REMOTE` defaults off (`src/config/env.ts:762-768`) and gates `/env` (`gateway.ts:2229,2246,2264,2286,2298`), `threadIdentity` (`thread-identity.ts:34`) and `ensureProvisioned` (`dispatch.ts:408`).
5. A node that predates environments runs an unlocked environment turn locally (`src/remote/kinds/index.ts:5-7`; the node's resolver `src/node/remote.ts:34-36` builds a target only from the token's `provisioned` claim). The gateway already routes by capability: `requiresCaps` in `src/queue/turns.ts:93-96`, set at `dispatch.ts:501`, honoured by the reaper (`src/queue/reaper.ts:99`); capability strings live in `src/guardrails/capability.ts:2-4`.
6. `updateEnv` and `deleteEnv` act on the id alone (`src/db/environments.ts:92,169`); ownership is enforced only by callers. A data-layer guard for definition rows is therefore required, not defense in depth.
7. `refRole` returns `other` for agent, env and node (`src/refs/parse.ts:83-93`) and `INTERNAL_ID` is `[A-Za-z0-9._-]{1,64}` (`parse.ts:33`): a schema that takes `env:` must check `type === "env"` and apply its own stricter name pattern.
8. `putKeyIfAbsent` writes through the global `db` (`src/db/remote.ts:86-96`), not a transaction. `checkSshHost` classifies addresses only when connecting (`src/remote/kinds/ssh.ts:28-40`).
9. The preview token may run `?dryRun=1` (`src/gateway/deploy/api.ts:9,47-54`); its 422 messages must not list stored names.

## Definition file format

`environments/<name>.yaml` in the deploy repository, beside `personas/` and `guardrails/`. `<name>` matches `^[a-z0-9][a-z0-9-]{0,40}$`, equals the `name:` key, and is the reference `env:<name>`.

```yaml
# yaml-language-server: $schema=https://barockok.github.io/slaude/schemas/environment.schema.json
name: team-sandbox
description: Shared build box for the platform team.
kind: ssh
shared: true                 # required, literal true: this is a machine many people drive
trust: unlocked              # required, literal "unlocked": threads need no /1on1 lock
defaultDir: /srv/work        # absolute path or ~/..., the /env use rule
ssh:
  host: build-box.example.com
  user: dev
  port: 22                   # optional
  hostKey: "SHA256:<43 chars>"   # required: no trust on first use for a shared box
  allowPrivateAddress: false # optional; see below
```
- Strict keys at every level; the message names the key, never the value. A file with `kind: tailcat` or `kind: provisioned` is refused: "kind X is not supported for shared environments yet". A file without `shared: true` and `trust: unlocked` is refused with a message saying a definition is a shared machine that needs no lock, and both must be written to say so.
- Secrets: there is no key for a private key, password or token; a key named like one, or a value with a token or PEM shape (the shapes `personas export` refuses, `src/cli/personas.ts`), gets a dedicated refusal. slaude generates the key pair (`generateSshKeyPair`) at first sync; only the public key is ever shown.
- Field values are checked by `sshKind.parse` so they cannot drift from `/env add`. A `host` that is an IP literal is classified at sync with `classifyAddress` (`src/net/outbound-policy.ts:168`); loopback, private, link-local, metadata and reserved addresses are refused unless `allowPrivateAddress: true`, and even then the gateway's own rules at connect still apply (`SLAUDE_ENV_SSH_ALLOW_PRIVATE`, `ssh.ts:36-43`). A host name is resolved only at connect (the existing single-resolution rule).

Agent key:
```yaml
environment:
  allow: [env:team-sandbox]    # required, 1 to 16, no repeats
  default: env:team-sandbox    # optional; parsed, checked to be in allow, stored, NOT applied in this slice
```
Strict object. Only `env:<name>` references, checked with `parseRef(v, ["other"])` AND `type === "env"` AND `^[a-z0-9][a-z0-9-]{0,40}$` (finding 7). Any other key (`kind`, `host`, `ssh`, `config`, `secrets`, ...) gets: "environment configuration cannot be written in agent.yaml: define it in environments/<name>.yaml and refer to it as env:<name>". Sync refuses (422) an agent that declares `environment:` while `SLAUDE_REMOTE` is off on the gateway (finding 4), with a message naming the persona and the flag.

## Data model

Migration `0042_environment_definitions.sql` (both dialects, mirror in `src/db/drivers/sqlite.ts`, additive):
```
environments ADD source TEXT NOT NULL DEFAULT 'user', ADD definition_name TEXT NULL,
             ADD definition_hash TEXT NULL, ADD definition_revision TEXT NULL,
             ADD description TEXT NULL, ADD retired_at BIGINT NULL
UNIQUE INDEX idx_environments_definition ON environments (tenant_id, definition_name) WHERE definition_name IS NOT NULL
```
A definition row (finding 2): `tenant_id = <tenant>`; `id = 'd' || first 24 hex of sha256(tenant || 0x00 || name)` (25 chars, bounded, tenant qualified); `team_id = 'def~<tenant>'` (at most 67 chars; no Slack team id contains `~`); `user_id = <name>`; `name = <name>`. The key pair is stored in `remote_keys` as (`def~<tenant>`, `<name>`), so two tenants never share a key. `config` holds the canonical non-secret config; `secrets` is NULL. `env:<name>` resolves with `(tenant, name)` in `src/remote/definitions/resolve.ts`; `src/refs/resolve.ts` is unchanged.

The agent's key lives in the persona's `definition` JSON (`environment: { allow, default? }`, names without the prefix). Payload version 7: `PERSONA_FIELD_VERSION.environment = 7`, a top-level `environments` list (absent: leave stored rows alone; present: the whole set, an unlisted row is retired), `SUPPORTED_PAYLOAD_VERSION = 7` (`src/persona/sync/payload.ts:53-54`). A payload that sets neither stays at its old version, so a version 6 payload still deploys.

## Enforcement (all per persona, fail closed, from rc.24)

One function, `remoteDecision({ tenant, persona, channel, thread, turnKind })` in `src/remote/definitions/decision.ts`, wraps `activeRemoteTarget` and returns `{ target } | { none } | { refused: { code, message } }`. `activeRemoteTarget` itself keeps its signature and personal behaviour (its existing tests stay green). Callers:

1. `threadIdentity` (`thread-identity.ts:25`) gains `persona` and `turnKind` parameters; callers: `dispatch.ts:416` (has `personaId`) and `src/gateway/api/jobs.ts:65` (has `claims.persona`). A refusal is carried in `ThreadIdentity.refused`; dispatch does not run the turn, posts one notice per thread per hour ("This thread is set to an environment this agent may not use. `/env off` returns to the server.") and runs nothing locally.
2. Mono: `monoRemoteResolver` (`src/remote/mono.ts:19-22`) receives the session's persona (`Sessions.findById(...).persona_id`) and THROWS `RemoteError("REMOTE_UNREACHABLE", ...)` on a refusal so the session fails closed; it must not return null.
3. `handleRemoteEnv` (`src/gateway/api/remote-env.ts`): for a definition row, require `row.tenant_id === claims.tenant` (the current `env.teamId !== claims.team` test cannot apply to a `def~` team), `remoteDecision` for `claims.persona`, and the hash match. Any failure is 403 or 409 with no key.
4. `/env use` (`useEnvironment`, `src/gateway/core/env-command.ts:155`): the same decision, first, with the agent's id from `RemoteCommandCtx.personaId` (new; `remoteCommandCtx`, `gateway.ts:2153`, already has it). The reply says plainly: "`team-sandbox` is a SHARED machine: anyone in this thread can steer it through me, and what runs there is visible to the team."
5. `turnKind`: `interactive` only. A cron turn, a wake turn and a background turn (`meta.wake`, `meta.backgroundRunId`, `dispatch.ts:82-84,498-499`; cron needs an explicit `origin` flag added to the dispatch meta in task 9) NEVER run on a shared environment: refused, with the notice above reworded ("scheduled and background turns do not run on shared environments"). This also closes the foreign-cron concern, since the lock rule that guarded it is not applied to shared rows.
6. Rule: a definition row is usable iff not retired, the persona's `environment.allow` names it, `SLAUDE_REMOTE` is on, and the turn is interactive. A persona with no `environment:` key is refused for every shared row. A policy lookup or row read that throws is a refusal.

Trust class: a shared row is a new explicit class, not "provisioned by default". `StoredEnv.source = "definition"` makes `trustOf` return `provisioned` only for a row that carries `shared` and `trust: unlocked` in its canonical config (sync guarantees both). On the wire it rides the existing `provisioned` claim so the node path needs no change (`src/node/remote.ts:34-36`), but the gateway-side decision above is what authorises it. The key path is by kind (`connectInfoForBinding`, `src/remote/env-runtime.ts`): the ssh row uses the generated key from `remote_keys` (`env-runtime.ts:20` with the row's `def~tenant` team).

Node capability (finding 5): new `SHARED_ENV_CAPABILITY = "shared-env/1"` in `src/guardrails/capability.ts`, advertised by nodes where they advertise the others. At `dispatch.ts:501` `requiresCaps` becomes a list, and a turn of a persona that declares `environment:` requires it, so an older node is never handed such a turn. Sync warns when no live node advertises it.

Rollback hazard (to be documented and scripted): redeploying rc.21 reads a bound shared row as a personal `ssh` row with owner `<name>` and no lock requirement path, which it treats as user-machine and then refuses (owner never matches) or, for a stale `provisioned` claim, runs unlocked. Therefore rollback step zero is `slaude env unbind-shared` (task 12) or `DELETE FROM env_bindings WHERE env_id IN (SELECT id FROM environments WHERE source = 'definition')`, then redeploy.

Ownership: `updateEnv`, `deleteEnv`, `createEnv` throw `DefinitionManagedError` for a definition row (REQUIRED, finding 6); `/env edit|rm` on a shared name answers "defined in the repository; change it there". Removing a file retires the row (`retired_at`); a retired row refuses (item 6); re-adding revives it.

Sync: phase one validates everything (definitions, agent refs, `SLAUDE_REMOTE`), then `applySync` (`src/db/personas.ts:191`) writes definitions in the same transaction as personas. A new row's key pair is stored through a new transaction-aware `putKeyIfAbsentTx` (finding 8), so a failed sync leaves no orphan key. A no-op resync (same canonical hash) writes nothing and moves no `updated_at`, so no warm session reboots. Refusals name the persona, field and environment from the submitted payload; they never list stored names (finding 9), and the report never contains host, address or key.

## Tasks

### rc.24

1. Migration 0042 and sqlite mirror. Files: `src/db/migrations/0042_environment_definitions.sql`, `src/db/drivers/sqlite.ts`, `tests/db/environment-definitions-schema.test.ts`. Tests first: upgrade from 0041 with personal rows (defaults, NULLs); old insert shape works; partial unique index; pg too.
2. Definition schema and parser. Files: `src/remote/definitions/schema.ts`, `parse.ts`, `tests/remote/definitions/schema.test.ts`. Tests first: valid ssh; each unknown key refused without its value; name equals file and matches the regex; `shared` and `trust` required; tailcat and provisioned refused with the stated message; secret-like key and token or PEM value refused; no `hostKey` refused; IP literals (loopback, private, link-local, metadata) refused unless `allowPrivateAddress`.
3. JSON Schema. Files: `scripts/gen-agent-schema.ts` also emits `docs/site/schemas/environment.schema.json`, `package.json` script, `tests/remote/definitions/json-schema.test.ts` (committed equals generated).
4. `environment:` key on agent.yaml. Files: `src/persona/agent-schema.ts`, `agent-def.ts`, `src/persona/sync/payload.ts`, `types.ts`, `registry.ts`, regenerated `docs/site/schemas/agent.schema.json`, tests in `tests/persona/`. Tests first: allow only; with default (stored, flagged unapplied); a bare name, `agent:x`, `user:x`, upper case, 42-character names refused; inline keys get the inline-config message; default outside allow; repeats; 17 entries; version stays 6 when unused and is 7 when used; every existing agent fixture compiles identically (`tests/persona/agent-corpus.test.ts`).
5. Data-layer guard. Files: `src/db/environments.ts` (`DefinitionManagedError`, `StoredEnv.source`, `retired`), `tests/db/environments-definition-guard.test.ts`. Tests first: update, delete, rename and create refuse a definition row; personal behaviour byte-identical.
6. Definition sync (database tenants). Files: `src/remote/definitions/sync.ts`, `resolve.ts`, `src/persona/sync/payload.ts`, `run.ts`, `src/db/personas.ts`, `src/db/remote.ts` (`putKeyIfAbsentTx`), audit event `environment.definition_synced`, `tests/persona/run-sync-environments.test.ts`. Tests first: create, no-op (nothing written, no reboot), change, retire, revive, absent list leaves rows alone; rollback in either half; unknown, retired or disallowed refs are 422 naming only submitted names; `SLAUDE_REMOTE` off with an agent key is refused; two tenants with the same name get distinct ids, teams and keys; a dry run writes nothing; no host or key in report, logs or audit.
7. Policy and decision. Files: `src/remote/definitions/policy.ts`, `decision.ts`, `src/remote/active.ts` (no change in signature; trust for definition rows), `src/remote/kinds/index.ts`, `tests/remote/definitions/decision.test.ts`. Tests first: the finding 1 scenario (agent B, same thread, bound by A): refused; no key policy refused; retired refused; cron, wake, background refused; flag off refused; throw refuses; personal rows untouched.
8. Wire the claim points. Files: `thread-identity.ts`, `dispatch.ts`, `src/gateway/api/jobs.ts`, `src/remote/mono.ts`, `src/gateway/api/remote-env.ts`, tests `tests/remote/definitions/claims.test.ts`, existing `tests/remote/*.test.ts` unchanged and green. Tests first: dispatch refuses and posts one notice; mono throws and does not run locally; `handleRemoteEnv` returns no key for another persona, another tenant, a stale hash, a retired row; the claim and fingerprint for every personal and tailcat environment are byte-identical to before.
9. Turn kind and node capability. Files: `src/gateway/core/dispatch.ts` (`origin` on meta, set by the cron scheduler), `src/guardrails/capability.ts`, node capability advertisement, `requiresCaps` list at `dispatch.ts:501`, `tests/queue/`. Tests first: an agent with `environment:` is pinned only to a capable node; an agent without it is unaffected.
10. `/env` surface. Files: `src/gateway/core/env-command.ts`, `slack/commands.ts` (`env:<name>`), `gateway.ts` (`personaId` in ctx), tests `tests/gateway/env-command-shared.test.ts`. Tests first: allowed use binds and prints the shared-machine warning; an agent without the key refuses; edit, rm, add over a shared name refuse; a stale Use button re-checks; with `SLAUDE_REMOTE` off `/env` answers as today ("not enabled"); no host, address, key or hash in any reply.
11. Console list, read only. Files: `console-views.ts` (`environmentsView.shared`: name, description, retired, revision, public key, allowing agents), `api-types.ts`, `EnvironmentsPage.tsx`, fixtures, `tests/gateway/panel-environments.test.ts`. Tests first: no host or config in the payload; operators see the public key; a test enumerates panel routes and fails if any accepts a definition id for a write.
12. Render, export, unbind. Files: `src/cli/personas.ts` (`renderDir` reads `environments/`, `--check` validates and resolves agent refs offline; export refuses unknown keys and never invents definitions; migrate unchanged), `src/cli/env.ts` (`slaude env unbind-shared`, read only `list`), tests. Tests first: payload version 6 without `environments/`, 7 with; render then export round trip.
13. Docs and release rc.24. Files: `docs/site/_content/guides/environments.md` (shared environments, the shared-machine warning, key distribution to nodes, no rotation yet, reachability from nodes), `docs/site/_content/deploy/personas-as-code.md`, field note `2026-11-15-domain-environments.md`, `docs/site/_content/releases/v0.46.0-rc.24.md`, `CLAUDE.md` index line, spec update.

### rc.26 (a hard stop after rc.24 soaks; only if the gate passes)

14. Key rotation: `slaude env rotate-key <name>` (new pair, old stays until the next sync confirms, public key shown), with a test that warm sessions reboot.
15. Apply `default:` (bind once with insert-only `bindIfAbsent`, interactive turns only), behind `SLAUDE_ENV_DEFAULT=off|shadow|enforce`, default `off`, with its own gate and tests.
16. Console binding counts and agent detail view.

Gate before rc.26: three days on a staging or split deployment with `SLAUDE_REMOTE=1` and one shared environment; zero refusals unexplained; every node advertises `shared-env/1`; the rollback script rehearsed.

## Test strategy

- Unit: schema, canonical hash (key order does not change it), policy, decision, refs.
- The central regression: the finding 1 scenario across `/env use`, dispatch, mono and `handleRemoteEnv`, and the same for another tenant.
- Golden: existing agent and environment fixtures produce identical compiled output, claims and fingerprints (personal, tailcat).
- Security: no secret, host, address or key in any error, report, log, audit event, console payload or reply (a helper greps outputs for a planted host and token); a shared row cannot be changed through any path; the preview token's 422s list no stored names.
- Failure injection: registry throws, row read throws, key insert fails mid sync.
- Commands: `bun test`, `SLAUDE_DB=pg bun test`, `bun run typecheck`, `bun run test:web`, `bun run schema:agent` then `git diff --exit-code docs/site/schemas`.

## Rollout

Per RC: backup before the version bump, deploy, `verify` 0 FAIL, smoke.

| RC | Behaviour change | Rollback |
|---|---|---|
| rc.24 | none until a repository adds `environments/` and an agent declares `environment:`; then `/env use env:<name>` works for that agent only | remove the agent key and resync; to go back to rc.21 first run `slaude env unbind-shared` (hazard above) |
| rc.26 | key rotation; `default:` only when its flag is moved off `off` | flag back to `off`, or rc.24 |

Do not drop the 0042 columns.

## Smoke test

The live deployment has `SLAUDE_REMOTE` off, so `/env` is not enabled there. Live (rc.24, no environment declared anywhere):
1. Migration 0042 applied; `verify` 0 FAIL.
2. A version 6 payload (the current repository, no `environments/`) still deploys; dry run (`?dryRun=1`) reports no environments; a no-op resync causes no session reboot.
3. The console Environments page loads, the Shared list is empty, and a personal row (if any) is unchanged.
4. `/env` answers that it is not enabled; an agent with no `environment:` key behaves exactly as before (a normal turn, an approval card).
5. A scratch repository with `environments/` and an agent key is refused at sync (`SLAUDE_REMOTE` off) with the named message, and applies nothing.

Full scenario, on a staging mono or a split deployment with `SLAUDE_REMOTE=1` (locally: `bun run sim` from `src/gateway/sim/cli.ts` for a mono gateway, a test ssh server from the in-process test server used by `tests/remote/environments.test.ts`, and for split a gateway plus a node with `SLAUDE_ROLE=node`):
1. Add `environments/team-sandbox.yaml` (placeholders for host and `hostKey`) and give `agent-a` `environment: { allow: [env:team-sandbox] }`; `slaude personas render <repo> --check` passes; each cut or bad input (tailcat, no `shared`, private IP, token-like value, inline `host:` under `environment:`) fails with the stated message and no value.
2. Dry run, apply, resync (unchanged). Install the public key from the console on the test box.
3. In an `agent-a` thread: `/env use env:team-sandbox` prints the shared-machine warning; ask for `hostname`; the answer is the box's; the thread is not locked; the approval card appears.
4. In an `agent-b` thread (no key), and in `agent-b` replying inside the thread `agent-a` bound: no key reaches the node, the turn is refused with the notice, nothing runs on the server. A cron job and a wake turn of `agent-a` in the bound thread are refused.
5. Retire the file and resync: the bound thread's next turn is refused (mono and split), `/env list` no longer offers it.
6. Personal `/env use <mine>` still locks the thread and works.
7. Grep gateway and node logs for the host and the key: zero hits.

## Decisions needed from the owner (recommended default first)

- D1 Shared environments are an explicit opt-in per definition (`shared: true` and `trust: unlocked` both written), per agent through `allow`, interactive turns only (recommended). Alternative: also allow scheduled turns (not recommended).
- D2 slaude generates the ssh key per definition and the operator installs the public key (recommended); rotation is task 14. Alternative: an operator-supplied `keyRef`, later.
- D3 `default:` is parsed and stored but not applied in rc.24 (recommended); applied in rc.26 behind a flag. Alternative: never apply it.
- D4 Per-person environments are unaffected by an agent's `environment:` key (recommended). Alternative: an optional `personal: deny`.
- D5 An agent with no `environment:` key cannot use shared environments (recommended).
- D6 Removing a definition retires it and bound threads are refused (recommended); no fallback to the server.
- D7 `tailcat` and `provisioned` definitions are refused in rc.24 (recommended); tailcat needs an address-by-reference design first.
- D8 ssh `hostKey` required (recommended).
- D9 The reference is the file name `env:<name>`; the internal id is a hash and appears only in audit.
- D10 Shared-row checks are enforced from rc.24, no shadow period (recommended: nothing legacy to compare).
- D11 Sync refuses an agent key while `SLAUDE_REMOTE` is off (recommended).
- D12 Filesystem tenants stay out until an agent cannot write its own definitions (recommended).

## Risks

- A shared machine in an unlocked thread: any participant steers it through the agent. Mitigations: explicit opt-in per definition and per agent, the warning on use, normal approvals, interactive turns only, console shows who allows it.
- The generated private key goes to every node that opens a handle, and there is no rotation until rc.26. Mitigation: documented; the key grants only the shared box; unbind plus a new definition name is the interim remedy.
- Nodes without `shared-env/1` never receive such turns; if none is capable the turn waits (the existing capability behaviour), and sync warns.
- The connection is made from the node while the host check runs on the gateway; a box reachable from one only fails with `REMOTE_UNREACHABLE`.
- A redefinition reboots warm sessions of bound threads; no-op syncs do not.
- Rollback to rc.21 with live shared bindings: handled by the unbind step; the plan makes that step part of the rollback procedure.
- A name collision between a personal and a shared environment: the bare name means personal, `env:<name>` means shared.
