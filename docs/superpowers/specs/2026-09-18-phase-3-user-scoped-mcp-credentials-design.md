# Phase 3 — user-scoped MCP credentials

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
enforce.

## 2. Decision

The gateway is the **durable authority** for a person's MCP credentials. A node
holds only a working copy, in a **pod-local** config directory that nothing else
can see, and hands changes back when a turn ends.

Three properties follow, and they are the point of the design:

- **No shared credentials file.** The rename that broke the symlink is now
  harmless, because the file it replaces has exactly one owner and nothing
  points at it.
- **No filesystem coordination.** Nothing needs locking on ReadWriteMany
  storage, which does not offer usable locking anyway.
- **One place to look.** A person's credentials are a row the gateway owns, not
  a file whose contents depend on which pod last ran their turn.

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

## 3. Architecture

```
  Slack ──▶ gateway ──▶ queue ──▶ node ──▶ agent child
              │                     │
              │  (1) seed           │  (3) write back
              └──────────────▶ pod-local config dir
                    control plane        (emptyDir)
```

1. **Seed.** At session start the node fetches the person's MCP credentials
   from the gateway and writes them into a pod-local config directory.
2. **Run.** The turn executes. The agent may refresh, rotate and rewrite that
   file. It owns the file for the duration.
3. **Write back.** At turn end the node compares the `mcpOAuth` subtree with
   what it seeded. If it changed, it posts the change to the gateway, which
   persists it as the new authority.

Transcripts are unaffected: the pod-local config directory keeps the existing
`projects/` symlink into the shared volume, which is already how per-initiator
config homes are built.

## 4. Storage

Credentials become gateway-owned state, encrypted at rest with the mechanism
already used for provider credentials (`provider_creds.kind` + `decrypt`).

```
mcp_credentials
  account_id   TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE
  server_key   TEXT NOT NULL      -- oauthKey(serverName, cfg), as today
  payload      TEXT NOT NULL      -- encrypted StoredEntry
  expires_at   BIGINT NOT NULL    -- plaintext, for expiry queries only
  updated_at   BIGINT NOT NULL
  PRIMARY KEY (account_id, server_key)
```

Keyed on **account**, not Slack user id. Phase 2 made that possible, and it is
the right key: one person with two Slack workspaces has one set of
integrations. The Slack user id remains the lookup path, resolved through
`accountForSlackUser`.

Deleting an account takes the credentials with it, which is the behaviour a
person expects when they disconnect.

## 5. Control-plane surface

A **separate endpoint**, not the runtime bundle. The bundle is per (tenant,
persona), shared across sessions and ETag-cached on the node; per-user
credentials must never ride in a cache keyed on something coarser than the
user. Mixing them would be the phase-1 per-persona cache bug again, with a
worse blast radius.

```
GET  /v1/tenants/:tenant/users/:slackUserId/mcp-credentials   → { entries: {...} }
POST /v1/tenants/:tenant/users/:slackUserId/mcp-credentials   ← { entries: {...} }
```

Both are job-token authenticated, and the token's claims must cover the tenant
**and** the user. A node holding a job token for one person must not be able to
read another person's credentials; that check is the entire authorization
story for this surface, so it gets its own test.

The POST is last-write-wins per `server_key` on the entry's own expiry, under a
Redis lock per account, so two nodes finishing turns for the same person cannot
interleave. The lock is the one the reaper and cron leaders already use.

## 6. The pod-local config directory

Today `initiatorConfigDir` resolves under `$SLAUDE_HOME`, which is the shared
volume. Node processes move to a local root:

- `SLAUDE_NODE_CONFIG_ROOT`, default `/config-home`, mounted as an `emptyDir`
  in the node manifest. Gateway and mono are unchanged.
- `initiatorConfigDir` gains the root as its base rather than `paths.home`.
  One accessor, so there is one place to change if this moves again.
- The `projects/` symlink still targets the shared volume, so transcripts stay
  durable across pod restarts. Only credentials and settings are local.

An `emptyDir` dies with the pod, which is the intent: nothing durable lives
there, and a lost pod costs at most the write-back of one turn.

## 7. Failure modes

**Pod dies mid-turn, after the agent rotated a token.** The rotated token is
lost and the gateway's copy may already be invalid, because rotation
invalidates the old refresh token at the provider. The person sees the
integration fail and reconnects with `/mcp connect`.

This is the accepted cost of the design, and it is bounded by writing back at
**turn end rather than session end**, so the exposure is one turn rather than
one conversation. It cannot be eliminated while the agent is the MCP client and
rotates tokens itself — the proxy design would move the problem, not remove it,
and would pay for that with the gateway on the data path.

**The seeded credential is already dead.** The gateway holds an entry whose
refresh token was rotated away in a turn whose write-back never landed. The
node cannot distinguish this from a revoked grant, so it does not try: the
failure surfaces as a normal connect prompt.

**Two nodes run turns for one person at once.** Both seed from the same state,
both may write back. The per-account lock serialises the writes and expiry
decides the winner. A rotation lost this way behaves as the first case.

## 8. What does not change

- `/mcp connect` and `/mcp disconnect` stay gateway-side. The gateway already
  runs the OAuth flows, and it is now also the store they write to.
- Default sessions keep using the agent's own shared identity. A 1:1 still
  swaps to the locked person's credentials. What changes is only that those
  credentials are the same ones across every persona, and that they no longer
  live on shared storage.
- The Anthropic provider credentials that the agent uses for the model itself
  are out of scope here. They reach the node through the runtime bundle as
  environment variables today, and that path is untouched.

## 9. Acceptance criteria

1. A person's credentials resolve identically on two different nodes, with no
   shared file between them.
2. A node holding a job token for one person is refused the credentials of
   another, on both the read and the write endpoint.
3. An agent-side rewrite of the credentials file during a turn is written back
   to the gateway and visible to the next turn on a different node.
4. Two concurrent write-backs for one account serialise, and the later expiry
   wins.
5. The node's config directory contains no symlink at `.credentials.json`, and
   `projects/` still resolves onto the shared volume.
6. With the feature off, a single-process `mono` deployment behaves exactly as
   it does today.
