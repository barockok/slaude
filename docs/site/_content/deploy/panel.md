---
title: Control panel
description: The operator web console — see every session, take control from Slack, and chat it directly.
---

# Control panel

The control panel is an operator web console mounted at `/panel` on the
gateway process (`mono` or `gateway` [role](index.md#horizontal-scale-gateway-nodes),
never `node`). It's built for the moment Slack isn't the right surface — an
operator needs to see what a session is doing, stop it, or drive it directly
without a human relaying messages through a thread.

It's off by default (`SLAUDE_PANEL=1` to mount it) and works the same in a
single `mono` container as it does across a fleet of gateway replicas.

## What it does

**Fleet list.** Every session across every persona and node in one table —
status-dot triage (running / idle / errored), warm vs. cold, a context-window
meter that recolors as it fills, filters by persona/tenant/status, and summary
chips for at-a-glance fleet health.

**Session detail.** Drill into one session: its identity (thread, persona,
model, permission mode) with one-click copy, and the destructive controls
(stop, reset, model switch, permission-mode change, `/1on1` unlock) fenced
behind a confirm step.

**Event timeline.** A live, typed, colored view of the session's event stream
— tool calls with duration bars, thinking/response chunks, relative
timestamps and gap markers — streamed over SSE and resumable across a
reconnect (`Last-Event-ID`).

**Chat.** Send messages into the session directly from the panel, bypassing
Slack entirely.

**Take control.** Chatting or explicitly locking a session takes over its
*active surface*: inbound Slack messages for that thread are deferred (and
replayed once you release, with one thread notice so the thread isn't
confused by the gap) and the agent's Slack-bound replies are suppressed while
you drive it. The lock has a TTL and auto-releases if the operator's browser
tab dies. `force-release` (superadmin only) *steals* the lock rather than
handing it back to Slack — use `release` to give control back.

Reset, permission-mode changes, and `force-release` require the
**superadmin** role; everything else — including stop, model switch, chat,
and `unlock-1on1` — is open to any operator listed for the panel.

## Enabling it

The panel is its own OIDC relying party — it does not trust an ingress
header, and it keeps no operator records of its own. Identity comes from an
ID-token claim (Google or Keycloak, or anything else that speaks OIDC
discovery); roles come from a file or an env list you control.

```sh
SLAUDE_PANEL=1
SLAUDE_PANEL_OIDC_ISSUER=https://idp.example.com/realms/slaude   # or https://accounts.google.com
SLAUDE_PANEL_OIDC_CLIENT_ID=slaude-panel
SLAUDE_PANEL_OIDC_CLIENT_SECRET=...
SLAUDE_PANEL_PUBLIC_URL=https://panel.example.com   # derives the redirect URI
SLAUDE_PANEL_SECRET=...                             # >= 32 chars, HMAC key for session cookies
SLAUDE_PANEL_USER_CLAIM=email                       # default
SLAUDE_PANEL_ROLES_FILE=/etc/slaude/panel-roles.yaml
```

**The identity claim must be one the issuer verifies and the user cannot
self-assign.** The panel refuses an ID token whose `email_verified` is
`false`, so the default `email` claim is safe against a realm with
self-registration enabled; a non-default `SLAUDE_PANEL_USER_CLAIM` gets no
such check — pick a claim your provider vouches for (never a user-editable
profile attribute), because the role file is keyed on that string.

**Register the redirect URI** with your provider, exactly:
`${SLAUDE_PANEL_PUBLIC_URL}/panel/auth/callback`. Required scopes: `openid
email profile`. The client must be confidential (it holds a secret).

**Roles** are declared in `panel-roles.yaml` — matched case-insensitively
against the identity claim, superadmin winning when an identity appears in
both lists:

```yaml
superadmin:
  - lead@example.com
operator:
  - alice@example.com
```

An identity in neither list is authenticated but not authorized: `403`.
Edits take effect on the next request — no redeploy. As a fallback for
deployments without a mounted file, `SLAUDE_PANEL_SUPERADMIN` and
`SLAUDE_PANEL_OPERATORS` accept comma-separated lists instead.

**Sessions** are the panel's own: a 15-minute access token and an 8-hour
refresh token, both in `HttpOnly; Secure; SameSite=Lax` cookies. The refresh
window is absolute — after 8 hours the operator re-authenticates at the
provider. There is no revocation: removing someone from the role file blocks
them at their next request, but a stolen cookie stays valid until it expires.
`SLAUDE_PANEL_SECRET` rotation invalidates every outstanding session.

Any missing required variable with `SLAUDE_PANEL=1` stops the process at
boot rather than serving a half-configured auth surface. Serve the panel over
TLS — the session cookies are `Secure` and browsers will not send them over
plain HTTP.

Full variable reference: [Configuration → Control panel](../reference/configuration.md#panel).

## Local development

A Keycloak container with a preloaded `slaude-dev` realm is included:

```sh
docker compose -f docker-compose.dev.yml up -d keycloak
```

Then set the env block from that file's header comment. There is no
authentication bypass flag; local runs exercise the real code path.

> **Unverified end to end.** The compose file and realm JSON have been
> checked only statically — they parse, and the realm's registered redirect
> URI, client id and user emails match what the panel derives. Nobody has yet
> watched Keycloak boot, import the realm, or complete a sign-in. Treat the
> first run as a smoke test — confirm `curl -fsS
> http://localhost:8081/realms/slaude-dev/.well-known/openid-configuration`
> returns a document naming `authorization_endpoint` and `token_endpoint`
> before assuming the setup is good, and delete this note once someone has.

## Running across replicas

On the [horizontal-scale topology](multi-node.md), the active-surface lock, the
deferred-inbound replay, and the once-per-window "handled in ops panel"
notice are all coordinated through Redis (the lock key, a `panel-resume` /
`panel-hold` pub/sub pair, and a `panel-notice` NX guard). An operator can
drive a session on one gateway replica while Slack traffic and node `/v1`
posts land on another, without double-posting or losing messages.

## Known limits

Durable transcript read is not yet built — `GET /panel/api/sessions/:id`
returns the live session row, but history that predates the operator's
connection, and backfilling a gap when the capped event stream has trimmed
old entries, are both deferred. The live SSE tail is fully wired; only
history-before-connect is missing.

The React app (`src/gateway/panel/web/`) builds with Vite (`bun run
test:web` covers it under Playwright) — a browser toolchain kept separate
from the Bun server, excluded from `bun test` and the server `tsc`.
