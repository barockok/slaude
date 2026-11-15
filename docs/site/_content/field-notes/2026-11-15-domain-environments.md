---
title: "Domain environments: a shared ssh machine as a definition, checked per agent at every claim point"
date: 2026-11-15
---

# Domain environments: a shared ssh machine as a definition, checked per agent at every claim point

**Date:** 2026-11-15 (ships in rc.24)

## Problem

Environments (2026-10-19) are per person: a saved machine belongs to its
owner, and using it locks the thread to that owner. A team also wants one
machine many people drive through an agent, declared once in the deploy
repository. Reusing the personal table for that is where it goes wrong, and a
review of the first draft found why.

## What the code said

- A binding is keyed by thread, not by agent. `env_bindings` has
  `PRIMARY KEY (channel_id, thread_ts)`; `activeRemoteTarget(channel, thread)`
  takes no persona, nor does `threadIdentity`, and `handleRemoteEnv` hands the
  key to any token whose claim names the bound environment. Agent A binds a
  thread, agent B answers in it, and B gets the machine. The allow check
  therefore cannot live in `/env use`: it has to be at every point where a
  claim is built or served.
- `environments` is unique on `(team_id, user_id, name)` and `remote_keys` on
  `(team_id, user_id)`, with no tenant in either. A fixed owner for shared rows
  would collide across tenants and share one private key.
- "No target" means "run on the server". A retired or disallowed shared row
  returning no target would silently run the agent's tools locally.

## Decisions

- **Definition rows.** `environments/<name>.yaml` in the deploy repository,
  synced in the same transaction as the personas. Row: tenant-qualified id
  (`d` plus 24 hex of sha256(tenant, name)), team `def~<tenant>` (no Slack team
  id contains `~`), owner and name both the definition name. The generated key
  pair lives in `remote_keys` under that team, stored inside the sync
  transaction (`putKeyIfAbsentTx`), so a failed sync leaves no orphan key.
- **Narrow on purpose.** ssh only (tailcat needs an address, which must not sit
  in git; no provisioner exists for sandboxes), database tenants only (an agent
  can write under `$SLAUDE_HOME`, and the file guard covers guardrails only),
  `hostKey` required (no trust on first use for a shared box), secrets by
  reference only (a key named like a secret, or a token or PEM shaped value, is
  refused), private, loopback and link-local literals refused unless
  `allowPrivateAddress`. Both `shared: true` and `trust: unlocked` must be
  written; a file that does not say so is refused.
- **One decision function.** `remoteDecision` wraps `activeRemoteTarget` and
  returns a target, none, or a refusal. A personal row, or no binding, gets
  exactly the old answer. A shared row is usable only when it is live (not
  retired), belongs to the asking tenant, the asking agent's own
  `environment.allow` names it (read from the stored persona, not a cache),
  `SLAUDE_REMOTE` is on, and the turn is interactive. Any throw is a refusal.
- **Every claim point asks it:** `threadIdentity` (dispatch and token refresh),
  the mono resolver (it throws, so a session fails closed instead of booting
  with local tools; the opened helper asks again on every exec, so an agent
  that drops the allow entry stops a warm session at once), `handleRemoteEnv`
  (which also requires the row's tenant to equal the token's tenant) and
  `/env use`. Dispatch posts one notice per thread per hour and queues
  nothing. With `SLAUDE_REMOTE` off, a thread still bound to a shared machine
  is refused rather than served from the server.
- **Turn kinds.** Only a turn with origin `slack` or `panel`, no wake and no
  background run, is interactive. Cron, wake and background turns never run on
  a shared environment, and an unknown origin counts as not interactive. This
  also closes the foreign-cron concern, since the owner-lock rule that guarded
  it is not applied to shared rows.
- **Trust class.** A definition row reads as `provisioned` (no owner lock)
  only when its canonical config carries both opt-ins; any other definition row
  reads as a user machine, which no thread can satisfy. On the wire it rides the
  existing `provisioned` claim, so a node that understands it needs no change in
  how it fetches the key.
- **Node capability.** `shared-env/1`, newer than the other three. An agent that
  declares `environment:` needs it (`requiresCaps` is now a list), and the
  runtime bundle of such an agent is refused to a node without it.
- **No default binding yet.** `default:` is parsed, checked to be in `allow`,
  stored and not applied.
- **Ownership.** `updateEnv`, `deleteEnv` and `createEnv` throw
  `DefinitionManagedError` for a definition row, at the data layer, because
  callers only checked ownership by convention. Removing a file retires the
  row; re-adding it revives it with the same key.

## Rollback hazard

rc.23 reads a bound shared row as a personal ssh row owned by a name, and for a
stale `provisioned` claim would run it unlocked. Step zero of a rollback is
`slaude env unbind-shared --tenant <id> --apply` (after `--dry-run`; the tenant is
required, `--all-tenants` is explicit), then redeploy. Without it a bound thread runs
on the server. The
0051 columns are never dropped.

## Known gaps

- The generated key goes to every node that opens a handle, and there is no
  rotation yet (a later release). The interim remedy is to unbind and define
  the machine under a new name.
- A caller with the preview token can learn whether a name exists by seeing
  whether a reference to it is refused. Refusals never list stored names.
- sqlite has no tenant column on `environments`; definition sync is a
  database-tenant feature, so this does not arise there.
