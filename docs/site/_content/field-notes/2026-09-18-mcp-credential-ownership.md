# MCP credential ownership: measuring before designing

**Date:** 2026-09-18

Phase 3 moves every MCP credential — the agent's own shared identity and each
person's — into one store owned by the gateway, with each node holding only a
pod-local working copy for the duration of a turn. Two questions about the
agent binary decided how refresh has to work, and neither could be answered by
reading slaude's own source. So they were measured, inside a node pod, against
a real agent session.

## Why the shared-file design died

The first design put one canonical credentials file per person on the shared
volume and made each persona's `.credentials.json` a symlink to it.

The agent's Linux credential store writes through a single helper: write a
temp file, then `rename` it over the target, with `copyFile` only as a fallback
for `EXDEV`, `EPERM`, `EEXIST` and `EBUSY`. A rename over a symlink replaces the
link. Reproduced on the shared volume itself:

```
before: symlink
after : regular file
canonical still says: {"token":"canonical-v1"}
per-persona now says: {"token":"refreshed-v2"}
```

The refresh lands in one persona's directory as a plain file, the canonical
copy keeps the stale token, and everything still linked to it keeps using the
dead one. No error anywhere.

The fallback makes this worse, not better. `copyFile` *follows* a symlink, so
on a filesystem that answers the rename with one of those four codes, sharing
survives. The same code shares credentials on one storage backend and silently
un-shares them on another.

The binary also runs its own OAuth refresh with refresh-token rotation on 401,
so any design that names some other component "the only refresher" is
asserting something it cannot enforce.

## The probe

A stub MCP server running in the pod accepted exactly one bearer token at a
time. One agent session, configured with that server, was driven through four
prompts, each asking it to call the stub's single tool:

1. The stub accepts `T1`; the credentials file holds `T1`.
2. The stub now accepts only `T2` — the provider has rotated — and the file
   still holds `T1`.
3. The file is rewritten to hold `T2`, as a gateway-side refresh would, then
   six seconds pass, longer than the binary's two-second credential poll.
4. `reconnectMcpServer` is called explicitly, then the tool again.

Tokens were random per run and never logged; the stub recorded only whether
each request carried the valid token, a stale one, or none.

## What it showed

| Phase | Tool result | Server status | What the stub saw |
| --- | --- | --- | --- |
| 1 | success | `connected` | `initialize`, `tools/list`, `tools/call` — all valid |
| 2 | error: `MCP server "stub" requires re-authorization (token expired)` | `needs-auth` | `tools/call` with a stale token |
| 3 | success | still `needs-auth` | `tools/call` with the valid token |
| 4 | success | `connected` | a fresh `initialize` and `tools/list`, then `tools/call` — all valid |

### Question A — does an auth failure reach slaude, distinguishably?

**Yes, and through a structured signal, not only text.** The failing call comes
back as an error tool result whose message says the server requires
re-authorization. That text alone would be a heuristic. But the SDK's
`mcpServerStatus()` reports the server as `needs-auth`, one of a closed set of
states (`connected`, `failed`, `needs-auth`, `pending`, `disabled`). A node can
confirm an auth failure by asking, rather than by parsing an error string.

### Question B — does the running agent see a rewritten credentials file?

**Yes, on the next call.** After the file was rewritten, the status stayed
`needs-auth` — nothing re-initialised the connection on its own — but the next
tool call carried the new token and succeeded. The agent reads the MCP token
from the file per call; the two-second poll that clears caches on an mtime
change covers the Anthropic login credentials, and was not needed here.

The status only returned to `connected` after an explicit
`reconnectMcpServer`, which re-ran the handshake with the new token. So a
rewrite is enough to make calls work, and a reconnect is what makes the reported
state honest again.

### Lever C — are MCP tools identifiable before they run?

**Yes.** The permission callback received `mcp__stub__whoami` before the call
went out. MCP tools carry an `mcp__<server>__` prefix, so a node can map a
pending call to its server, and therefore to its credential, before it runs.

## Decision

**Branch R — reactive refresh through the gateway.** When an MCP tool call
fails and `mcpServerStatus()` confirms that server is `needs-auth`, the node
asks the gateway to refresh that server's credential for the turn's owner,
rewrites its pod-local file, and calls `reconnectMcpServer` so the reported
state is correct. The gateway performs every refresh; a node never holds a
client secret or talks to an identity provider.

This bounds a mid-turn expiry to the single call that hit it, rather than the
rest of the turn. Once nodes were given access tokens only (below), no rotation
can happen on a node at all, so a pod dying mid-turn loses nothing either.

Lever C makes a proactive variant possible — refreshing in the permission
callback when a token is inside its expiry window, so the model never sees the
failure at all. It is not needed for correctness and is left as a follow-up.

## What was built

**One store for every MCP credential.** The agent's own shared identity per
tenant and persona, and each person's per account, sit in one Postgres table,
AES-256-GCM under `SLAUDE_MASTER_KEY`. Exactly one owner per row is enforced by
`CHECK` constraints rather than by code, and a person's rows cascade away with
their account through a real foreign key.

**Whose credentials a turn gets is signed, not inferred.** The dispatcher
computes it with the same rule the node uses for its config directory and signs
it into the job token as `runAs`. The existing `initiator` claim was the wrong
key: it is whoever sent the message, which in a channel thread is a colleague
while the session runs as the agent. The credential endpoints take no owner in
the URL, so there is nothing to tamper with, and a token without `runAs` is
refused rather than read as the agent. A failed lock lookup fails the dispatch,
because defaulting would run a 1:1 turn with the agent's credentials.

**Nodes hold access tokens only.** The node-facing endpoint returns an
allowlisted projection. Refresh tokens and client secrets never leave the
gateway, which makes it the only refresher by construction: the agent cannot
rotate what it does not hold. That removed the turn-end write-back the plan had
called for, the write path a compromised node could have planted credentials
through, and the accepted cost of losing a rotation when a pod died.

**Refresh is single-flight across replicas.** A rotating refresh token can be
spent once, and many sessions share the agent's owner. Callers in one process
share a promise, replicas serialise on a Redis lock, and under the lock the
stored entry is re-read so a caller whose token was already replaced gets the
new one without the provider being called. A fresh token skips the lock
entirely. Under the lock the result is written unconditionally: a refreshed
token can expire sooner than the old one's nominal expiry, and a newer-wins
guard there would hand back the very token just rejected.

**Two refresh triggers.** A node fetches its owner's tokens at the start of
each turn, and the gateway refreshes anything inside its expiry window before
answering, so most turns never meet an expired token. Mid-turn, Branch R above
takes over.

**Every node session gets a pod-local home**, an `emptyDir`, seeded from the
gateway. The file is written by temp-file rename, which replaces a planted
symlink rather than writing through it.

**The boot import is insert-only.** Once the store holds a row it is
authoritative; an old file with a later nominal expiry must never replace a
grant refreshed since. That also makes it safe on every replica with no lock. A
person's on-disk directory carries no workspace, so their Slack id imports only
when it maps to exactly one account.

## Found along the way

**Default-persona transcripts never reached the shared volume.** Node pods run
with no `CLAUDE_CONFIG_DIR`, so the agent's own home resolved to `~/.claude` on
the pod's filesystem, and a session resumed on another node started cold. This
predated phase 3. The node's default-persona base is now `$SLAUDE_HOME/.claude`.

**A stub provider with incomplete metadata broke recovery, and a real one
would too.** A 401 that advertises `resource_metadata` makes the SDK run its own
OAuth discovery. Against authorization-server metadata missing
`response_types_supported`, that discovery throws a schema error, the server
stays `connected`, and the needs-auth signal Branch R keys on never appears.
Against conformant metadata the server goes `needs-auth` as measured. So
mid-turn recovery depends on the provider publishing valid RFC 8414 metadata.
The turn-start refresh does not, and still covers ordinary expiry.

**Literal NUL bytes, twice more.** Writing the JavaScript NUL escape sequence
into source through the editing tooling produced real NUL bytes, in a test and
in the refresher, making git treat the files as binary. The same thing had
already happened in a merged plan document. All are fixed, and the refresher
now builds its keys with `JSON.stringify`, so it needs no control characters
in source at all.

**The token endpoint was re-discovered on every refresh.** Found in the
security pass. Refresh ran OAuth discovery from the MCP server's own metadata
and then posted the stored refresh token and client secret to whatever token
endpoint it named. A third-party MCP server that later turned hostile could
repoint it and collect both. The endpoint a connect exchanged its code at is
now pinned with the grant, and refresh posts only there. An entry imported from
disk discovers once on its first refresh and pins what it found.

## Verified on the local scale cluster

Two gateways and two nodes on real Postgres and Redis, with a stub OAuth
provider and MCP server whose refresh tokens rotate and are single-use:

| Check | Result |
| --- | --- |
| Expired stored token refreshed as a node fetched it at turn start | one provider call |
| Node session home | pod-local, `0700`; file `0600` |
| Fields in the node's file | `accessToken`, `clientId`, `expiresAt`, `serverName`, `serverUrl` only |
| Mid-session expiry | tool error, status `needs-auth` |
| Recovery through the gateway | one refresh, file rewritten, server `connected`, next call succeeds |
| Eight concurrent refreshes across both gateway replicas | one provider call, zero rejected grants, one token |
| Credentials written to the shared volume | none |
| Unpinned entry's token endpoint after its first refresh | pinned in the store |

Run on both node pods. `verify-ha.sh`, extended with credential-placement
checks, passed 23 of 23.
