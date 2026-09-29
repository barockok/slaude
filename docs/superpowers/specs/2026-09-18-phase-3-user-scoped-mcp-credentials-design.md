# Phase 3 — unified MCP credentials

**Date:** 2026-09-18
**Supersedes:** §6 of `2026-09-17-control-plane-and-onboarding-design.md` (the shared-file-plus-symlink design and its reconciliation fallback).
**Depends on:** phase 2 (`accountForSlackUser`), phase 0 (symlink-safe credential writes).

## 1. What changed since the earlier design

The earlier design put one canonical credentials file per person on the shared
volume and made each per-persona config directory's `.credentials.json` a
symlink to it. Two measurements taken on a node pod, on the shared volume
itself, killed that design.

**The agent's write replaces the symlink.** The shipped Linux credential store
writes through one helper: temp file, then `rename` over the target.
`copyFile` appears only as a fallback for `EXDEV`, `EPERM`, `EEXIST` and
`EBUSY`. On a filesystem where the rename succeeds, and it did on the shared
volume, the symlink becomes a regular file:

```
before: symlink
after : regular file
canonical still says: {"token":"canonical-v1"}
per-persona now says: {"token":"refreshed-v2"}
```

The refresh lands in the persona directory, the canonical file keeps the stale
token, and every other persona pointing at the canonical file keeps using it.
Nothing reports an error.

Worse than a consistent failure: because `copyFile` *does* follow a symlink,
sharing survives on any filesystem that answers rename with one of those four
codes. The behaviour is therefore storage-dependent, so it would work in one
cluster and silently break in another.

**The agent refreshes and rotates on its own.** The binary carries a full OAuth
refresh path, including 401 recovery with refresh-token rotation. Whatever we
hand it can be replaced underneath us during a turn. Any design that names an
external component "the only refresher" is asserting something it cannot
enforce — unless the agent is never handed a refresh token at all, which is
what §4 does.

## 2. Decision

**One store for every MCP credential**, whoever it belongs to. There are two
kinds of owner today, and they were handled by two different mechanisms:

| Owner | Who connects it | Where it lives today |
| --- | --- | --- |
| **The agent** — its shared identity, per persona | a manager, `/mcp connect` outside a 1:1 | the persona's config home, or the process's own, on the shared volume |
| **A person** — per account | that person, `/mcp connect` inside their 1:1 | `$SLAUDE_HOME/oauth/<userId>`, on the shared volume |

Both move to the same place, under the same rules. The gateway is the
**durable authority** for all of them and the **only party that refreshes**. A
node holds only an access token, in a **pod-local** config directory that
nothing else can see.

Unifying is not only tidier. Leaving the agent's identity on the shared volume
would leave the exact hazard §1 measured in place for the credentials every
ordinary channel conversation uses — the most-used credentials in the system
would be the ones still exposed to it.

Three properties follow, and they are the point of the design:

- **No shared credentials file.** The rename that broke the symlink is now
  harmless, because the file it replaces has exactly one owner and nothing
  points at it.
- **No filesystem coordination.** Nothing needs locking on ReadWriteMany
  storage, which does not offer usable locking anyway.
- **One place to look.** A credential is a row the gateway owns, not a file
  whose contents depend on which pod last ran a turn.

### 2.1 Why the gateway is not an MCP proxy

Routing every node MCP call through the gateway was considered and rejected.

slaude is not the MCP client. It writes entries under an `mcpOAuth` key inside
the agent binary's own credential store, and the binary connects out. So
"route the calls through the gateway" means pointing the agent at the gateway
as a proxy URL and having it forward upstream — the shape the brain's remote
backend already uses.

That puts the gateway on the data path for every tool call. The gateway is
sized for no turns and drains in thirty seconds, so a rollout would cut off
in-flight tool calls. That is the defect we just removed from cron, where cron
turns executed in the gateway instead of on a node. Reintroducing it for every
MCP call trades a storage problem for an availability one. Stdio MCP servers
cannot be proxied this way at all.

## 3. Whose credentials a turn gets

This is the security core of the design, so it is decided in exactly one place:
**the gateway, at dispatch, from the session's lock state.** It is never
inferred on the node and never taken from a request.

A new job-token claim, `runAs`, carries the answer:

| Session | `runAs` |
| --- | --- |
| a thread with no 1:1 lock | `agent` |
| a 1:1 locked to a person | `user:<slackUserId>` of the lock owner |
| a cron job created inside a 1:1 | `user:<slackUserId>` it carries (the identity cron already threads through, since #120) |
| any other cron job | `agent` |

**Why a new claim instead of the existing `initiator`.** `initiator` is whoever
sent the message. In a channel thread the session runs as the agent while
`initiator` is a colleague who happened to speak, so authorizing on it would
hand that colleague's credentials to a session that is not running as them. It
coincides with the lock owner only inside a 1:1, which is exactly the case where
getting it wrong is invisible in testing.

Because the claim is signed, the credential endpoint takes **no owner in its
path**. It serves the token's `runAs` owner and nothing else. There is no path
parameter to tamper with, so the class of "change the id in the URL" bugs does
not exist on this surface.

## 4. Architecture

```
  Slack ──▶ gateway ──▶ queue ──▶ node ──▶ agent child
              │   (runAs signed        │
              │    into job token)     │
              │                        │
              │  (1) seed              │  (3) needs-auth → refresh
              └──────────────────▶ pod-local config dir
                    control plane        (emptyDir)
```

1. **Seed.** At session start the node fetches the access tokens for the
   token's `runAs` owner and writes them into a pod-local config directory.
2. **Run.** The turn executes. The agent calls MCP servers with those tokens.
   It holds no refresh token, so it cannot rotate anything.
3. **Refresh.** When a token expires mid-turn the agent reports that server as
   `needs-auth`. The node asks the gateway to refresh it, rewrites the file with
   the new access token, and reconnects the server. The next call succeeds.

**Why nodes hold access tokens only.** The store keeps the full grant, because
the gateway refreshes with it. Handing that whole grant to a node would put a
refresh token and a client secret on every pod that ran a turn. Instead the
node-facing endpoint returns a projection built from an allowlist of fields.
Three things follow:

- The gateway is the only refresher **by construction**. The agent cannot
  rotate what it does not hold, which the §1 probe confirmed: with no refresh
  token it reports `needs-auth` rather than rotating.
- A compromised node leaks only short-lived access tokens.
- A node has nothing to write back, so there is no write path for a
  compromised node to plant a credential through.

On a node, **every** session gets a pod-local config directory, not only 1:1
sessions. Today an unlocked session on the default persona inherits the
process's config directory and a named persona uses its config home on the
shared volume; both hold the agent's credentials, so both move.

What stays on the shared volume is everything that is not a credential: the
persona's soul, skills and settings, and the transcripts. The pod-local
directory is seeded from the persona home and keeps the existing `projects/`
symlink into it, which is already how per-initiator config homes are built.

## 5. Storage

Credentials become gateway-owned state, encrypted at rest with the mechanism
already used for provider credentials: AES-256-GCM under `SLAUDE_MASTER_KEY`,
versioned envelope `v1:iv:tag:ct` (`src/db/crypto.ts`).

```
mcp_credentials
  id              TEXT PRIMARY KEY
  account_id      TEXT NULL REFERENCES accounts (id) ON DELETE CASCADE
  agent_tenant    TEXT NULL
  agent_persona   TEXT NULL
  server_key      TEXT NOT NULL      -- oauthKey(serverName, cfg), as today
  payload         TEXT NOT NULL      -- encrypted StoredEntry
  expires_at      BIGINT NOT NULL    -- plaintext, for expiry queries only
  updated_at      BIGINT NOT NULL
  CHECK ((account_id IS NOT NULL) <> (agent_tenant IS NOT NULL))
  CHECK ((agent_tenant IS NULL) = (agent_persona IS NULL))
  UNIQUE (account_id, server_key)
  UNIQUE (agent_tenant, agent_persona, server_key)
```

Exactly one owner per row, enforced by the database rather than by the
application. Two nullable owner columns rather than a polymorphic
`owner_kind`/`owner_id` pair, for one reason: it keeps a real foreign key on
`account_id`, so deleting an account deletes that person's credentials through
the database's own cascade instead of through code someone has to remember to
call.

A person is keyed on **account**, not Slack user id. One person with two Slack
workspaces has one set of integrations. The agent is keyed on (tenant, persona),
matching how the runtime bundle already resolves an agent's identity.

## 6. Control-plane surface

**Separate endpoints**, not the runtime bundle. The bundle is per (tenant,
persona), shared across sessions and ETag-cached on the node. A person's
credentials must never ride in a cache keyed more coarsely than the person, and
putting the agent's there would mean one owner model inside the bundle and
another outside it.

```
GET  /v1/tenants/:tenant/mcp-credentials            → { entries: { <key>: <access-token projection> } }
POST /v1/tenants/:tenant/mcp-credentials/refresh    ← { serverKey }  → { entry } | 409 reconnect
```

Both are job-token authenticated. The tenant in the path must match the
token's `tenant` claim. The owner comes **only** from the token's `runAs`
claim. A token without `runAs` is refused rather than defaulted, so an older
gateway's token can never be read as "the agent".

Refresh is single-flight per owner and server key across every gateway
replica. For the agent this is the normal case, not an edge: many sessions on
many nodes share the agent's owner and can hit the same expiry together, and
with rotating refresh tokens a second, concurrent refresh would present an
already-spent refresh token and be refused. So a refresh request first checks
whether the stored token is already newer than the one that failed, and only
then refreshes, under a Redis lock. The write uses the store's conditional
upsert, so even a lost lock cannot let an older token replace a newer one.

## 7. The pod-local config directory

- `SLAUDE_NODE_CONFIG_ROOT`, default `/config-home`, mounted as an `emptyDir`
  in the node manifest. Gateway and mono are unchanged.
- One accessor resolves the per-session directory under that root for both
  owner kinds, so there is one place to change if this moves again.
- The `projects/` symlink still targets the shared volume, so transcripts stay
  durable across pod restarts. Settings and plugins are seeded from the persona
  home as they are today for 1:1 homes.

An `emptyDir` dies with the pod, which is the intent: nothing durable lives
there, and a lost pod costs at most the write-back of one turn.

## 8. The brain

The remote brain backend authenticates with an MCP OAuth token read from the
agent's config directory (`src/knowledge/remote/brain-client.ts`). That is an
agent-owned credential like any other, and it moves too: the brain client reads
it from the store for the agent owner. Leaving it on disk would keep one
credential on the old mechanism and make "unified" untrue.

## 9. Migration

Existing deployments have credentials on disk in both places. Without an
import, every connected integration — the agent's and every person's —
disappears on upgrade.

The gateway imports on boot, once, under a leader lock so replicas do not race:

- The agent's config directory and each persona's config home → agent owner.
- Each `$SLAUDE_HOME/oauth/<userId>` and `oauth/<persona>/<userId>` → the
  account bound to that Slack user.

A person's on-disk credentials with **no bound account** cannot be imported,
because there is no owner to key them on. They stay on disk untouched, the
import logs how many were skipped without naming anyone, and the person's
next `/mcp connect` after `/link` recreates them. Deleting them would destroy
something that cannot be recovered; importing them under a guessed owner would
be worse.

Imported files are left in place, not deleted. A rollback to the previous
version then still finds them. Removing them is a later, separate change once
the new path has soaked.

## 10. Failure modes

**A pod dies mid-turn.** Nothing is lost. A node never held anything that
could change a credential, so there is no rotation to lose. An earlier revision
of this design accepted losing a rotation on pod death; making the gateway the
only refresher removed that cost.

**The grant was revoked at the provider.** The gateway's refresh fails, the
endpoint answers 409, and the failure surfaces as a normal reconnect prompt —
a person with `/mcp connect` in their 1:1, the agent by a manager.

**Many sessions hit one expiry at once.** Single-flight refresh on the gateway,
as §6 describes: one call to the provider, every waiter gets its result.

## 11. What does not change

- `/mcp connect` and `/mcp disconnect` stay gateway-side, and keep their
  existing gates: a manager for the agent's identity, the lock owner inside a
  1:1. Only the destination changes.
- A 1:1 still runs as the locked person and gets only their credentials. It
  does not also receive the agent's, which is today's behaviour and is now
  enforced by `runAs` rather than by which directory happened to be mounted.
- The Anthropic provider credentials the agent uses for the model are out of
  scope. They reach the node through the runtime bundle as environment
  variables today, and that path is untouched.

## 12. Acceptance criteria

1. An owner's credentials resolve identically on two different nodes, with no
   shared file between them. Tested for both owner kinds.
2. A job token receives only its `runAs` owner's credentials. A session running
   as the agent cannot read a person's, a 1:1 cannot read the agent's, and one
   person cannot read another's.
3. A token without `runAs` is refused.
4. A node never receives a refresh token or a client secret, for either owner
   kind, and has no endpoint through which to write a credential.
5. A token that expires mid-turn is refreshed by the gateway and the turn's
   next call succeeds; concurrent refreshes for one owner and server make one
   call to the provider.
6. No node has a `.credentials.json` anywhere under the shared volume after a
   turn, for either owner kind.
7. An upgrade from on-disk credentials loses nothing that has an owner, and
   leaves the unowned ones in place.
8. With the feature off, a single-process `mono` deployment behaves exactly as
   it does today.
