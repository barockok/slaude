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
rest of the turn. It also narrows the accepted cost of the design: a lost
rotation on pod death still costs a reconnect, but an ordinary expiry no longer
does.

Lever C makes a proactive variant possible — refreshing in the permission
callback when a token is inside its expiry window, so the model never sees the
failure at all. It is not needed for correctness and is left as a follow-up.
