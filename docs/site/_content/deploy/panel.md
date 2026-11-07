---
title: Console and portal
description: The operator console (agents, sessions, approvals and audit, access, memory, environments) and the end-user portal.
---

# Console and portal

The console is the operator web app mounted at `/panel` on the gateway
process (`mono` or `gateway` [role](index.md#horizontal-scale-gateway-nodes),
never `node`). It is built for the moment Slack is not the right surface: an
operator needs to see what an agent may do and for whom, what a session is
doing, who approved what, or to drive a session directly without a human
relaying messages through a thread. The [portal](#the-user-portal) is its
sibling for everyone else, at `/portal`.

It is off by default (`SLAUDE_PANEL=1` to mount it) and works the same in a
single `mono` container as it does across a fleet of gateway replicas.

## What it does

The console has a top bar, a left navigation and one page per area. Light and
dark themes follow the browser, and every page works at phone width.

| Page | What you see |
|---|---|
| **Overview** | Counts of agents, live sessions, pending approvals and audit events in the last 24 h, and recent activity. |
| **Agents** | Every agent (persona) with its live state. An agent's page has four tabs: *Overview* (identity, model, the label it runs on), *Mandates* (its jobs: the soul's mandate, each channel block, each cron and the heartbeat, with triggers and the approvers who can actually approve), *Access* (effective grants from the soul and the console) and *Activity* (its audit events). |
| **Sessions** | Live and recent sessions with filters by agent and status. A session has a *Timeline*, a *Chat* tab and its *Audit* events. |
| **Approvals and audit** | Every permission and approval decision, refusal and expiry, and every console change, newest first, filterable by agent, action, actor, decision and time. |
| **Access** | Console roles (read only, from the role file; superadmins only, operators see a note) and every stored agent grant. |
| **Memory** | Memory stores with page counts; a store lists its pages; a page shows its content, type, tags and links. Read only. |
| **Environments** | Node pools (labels, live nodes, last heartbeat), each agent's placement label, and personal environments (secrets never shown). |

**Grants.** A superadmin adds or revokes an agent grant from the agent's
*Access* tab: a user, a channel's members or a whole workspace gets the
`member`, `approver` or `manager` role on that agent, or a user is denied. A
change applies at once on the replica that made it and within a few seconds on
the others. Grants are keyed by persona name, so a persona renamed in git is a
new persona and its grants must be re-created. Operators see grants but cannot
change them. A stored approver grant applies in every channel, unlike the
approvers in a SOUL.md `## Channel` block, which replace the global list in
their channel only. A channel grant takes a channel id (`C` or `G`); for DMs,
give the person a user member grant with DM only. A deny grant also removes
the user from every approval card, the default persona's included. The console
roles list (who may sign in, and as what) is visible to superadmins only.

**Private memory stores.** Personal (`user-*`) and profile (`profile-*`)
stores hold what one person told an agent. Only superadmins see them, and every
page a superadmin opens in one is recorded in the audit trail
(`memory.page.viewed`, store and slug, never content).

**Session timeline.** A live, typed view of the session's event stream (tool
calls with duration, thinking and response chunks, relative timestamps and gap
markers), streamed over SSE and resumable across a reconnect
(`Last-Event-ID`). The session's controls (stop, model switch, permission-mode
change, reset, `/1on1` unlock) sit behind a confirm step.

**Chat and take control.** Chatting or explicitly locking a session takes over
its *active surface*: inbound Slack messages for that thread are deferred (and
replayed once you release, with one thread notice so the thread is not
confused by the gap) and the agent's Slack-bound replies are suppressed while
you drive it. The lock has a TTL and auto-releases if the operator's browser
tab dies. Taking over a session another operator is driving (`force-release`)
is superadmin only and *steals* the lock rather than handing it back to Slack;
use release to give control back.

Reset, permission-mode changes, taking over, and grant changes require the
**superadmin** role; everything else, including stop, model switch, chat and
`unlock-1on1`, is open to any operator listed for the console. Console actions
are written to the audit trail.

**Persona definitions.** `GET /panel/api/personas/<name>` answers "what is this
agent, and where does it run" without reading the database or a node's disk.
It is read only and open to any operator; the console's agent page shows the
identity part of it, and the rest is API only for now. Definitions change
through git ([personas as code](personas-as-code.md)). It returns:

| Section | What it returns |
|---|---|
| Identity | origin (`git` or `runtime`), retired or not, Slack user id, the label it runs on (`default` when it names none), model from git and the live model, with an override marked |
| Soul | its length, whether a runtime override replaced it, and the first 200 characters |
| Provider | for `apiKey`, `authToken` and `oauthToken`: the reference (`vault://…#field` or `env://PERSONA_…`), `stored` for a value that is not a valid reference, or `none`; the base URL reduced to scheme, host and path |
| MCP servers | name, transport, hostname only, the route, and the agent credential (below) |
| Knowledge | `all` installed KBs, `none`, or the listed ids, each marked installed or not |
| Skills | slug, name, and whether it is global or the persona's own overlay (which shadows a global skill of the same slug) |
| Nodes | the live nodes whose heartbeat carries the persona's label, with their labels; "no node registry answered" in `mono` or without Redis |

**An MCP server's route** (`via` in the API) says how the persona's agent
gets its tools:

- `bridge` (*gateway bridge*): an HTTP server, relayed by the gateway's MCP
  bridge.
- `stdio` (*runs in the gateway process*): `mono` only, where a persona's
  stdio server runs beside the agent.
- `none`: not served from this definition. In the gateway role a node mounts
  only its own manifest's stdio and plugin servers, never a persona's, so a
  persona's stdio server reads *not served here (stdio comes from the node
  manifest)*; `sse` and unknown types are not bridged.

`plugin` is never reported: plugin MCP servers are node-local software the
gateway cannot see. A node's manifest servers are not listed here either.

**The agent credential** is about the persona's **agent identity only**:
*agent credential: stored* when the gateway holds an OAuth credential for that
server's exact configuration, *stored, expired; refreshes on use* past its
expiry (the gateway refreshes it on the next call), *none* otherwise.
Per-user credentials (a person's own connection, used in a locked 1:1) are
not shown. The API returns the expiry time (`expiresAt`), never the token.

**What is deliberately not shown**, by the server rather than hidden by the
page: any secret value; a provider credential's resolved value; the
persona's Slack user token (the list says only `present` or `absent`); an
MCP server's URL, path, query string, userinfo, port, headers, env, command
or arguments; any OAuth token. A reference's path is visible to
signed-in panel users only and the route logs nothing about the persona.
Showing a reference tells an operator *which* secret a persona uses, which
is the point; it does not let them read it.

Persona definitions need the persona tables, which exist on Postgres only: on
a sqlite deployment the API answers `409`, and an unknown name answers `404`.

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

## The user portal

The portal is a second surface on the same process, mounted at `/portal` for
the `mono` and `gateway` roles. It is for end users rather than operators:
someone signs in, and their account is bound to their Slack user so later
phases can run a session as them rather than as the agent.

Enabling it is two steps, and the second is easy to miss:

1. Set `SLAUDE_PORTAL=1`.
2. **Register `${SLAUDE_PANEL_PUBLIC_URL}/portal/auth/callback` as a second
   redirect URI on the identity-provider client you already created for the
   panel.** Without it every portal login fails at the provider, and slaude
   never sees the request — there is nothing in its logs to explain it.

There is no step three. The portal reuses the panel's issuer, client id,
client secret, public URL and signing secret.

### Portal pages

The portal has three pages:

- **My account**: the signed-in identity and the Slack identities linked to it.
- **Integrations**: the MCP servers a person can connect (below).
- **My agents**: the agents the person holds a grant on, with their role.

### The integrations page

The integrations page is the one a person uses most. It lists every HTTP MCP server
that any agent on this deployment mounts, with a connect or disconnect button
each, and it says plainly where those credentials apply: in a 1:1 with an agent
and in what the person schedules there, not in a channel thread, where the agent
runs as itself.

The list is the union of each persona's MCP servers, resolved exactly as a
session resolves them: a persona's own `mcp.json` (or, for a persona managed
from git, its synced `mcp`), and for the default persona the global
`.mcp.json`. A server several personas share is one row that names them, and
one connect covers all of them, because the stored credential is keyed by the
server's name and configuration, not by persona. Two different servers that
happen to share a name are shown as separate rows. Only the host is shown;
a server's headers, which can hold a persona's own credential, never reach
the page.

The MCP provider redirects back to `${SLAUDE_PANEL_PUBLIC_URL}/portal/oauth/callback`.
That is not something you register anywhere: MCP servers use dynamic client
registration, so slaude registers the redirect URI itself at each connect. It
does mean the public URL must be the address the person's browser can actually
reach, which is the same requirement the panel already has.

Nothing about this needs a second replica to be correct. A connect started on
one gateway completes on whichever replica the ingress hands the callback to,
because the in-flight state lives in the database rather than in a process.
`/mcp connect` in Slack now shares that property in paste-back mode: the parked
flow is a row, so the pasted callback can arrive at any replica.

That does mean paste-back mode requires `SLAUDE_MASTER_KEY` — the parked flow
holds the registered client secret and the PKCE verifier, and is stored
encrypted. A connect refuses up front and names the variable if it is unset.
Loopback mode (`SLAUDE_OAUTH_REDIRECT_URL` unset) is unchanged, needs no key,
and stays per-process: the browser is sent to a listener inside one pod, so that
flow has to finish where it started.

A completed portal connect writes the same stored credential a 1:1 `/mcp
connect` would, so the two surfaces are interchangeable as far as the agent is
concerned.

**Any identity the provider authenticates gets a portal account**, with no
role check. That is intended. An account grants nothing on its own: it becomes
useful only once a Slack identity is bound to it, and binding requires an
onboarding link that only that Slack user can see. A portal session is never
an operator session — different token type, different cookie path — so the
panel's role check is untouched.

**Binding is user-driven.** A person types `/link` in a thread with the agent
and gets a private, 15-minute link; opening it while signed in to the portal
binds the two identities. Replies to `/link` are always ephemeral, and a
surface that cannot reply privately gets a refusal rather than a public post.
A Slack user already bound to one account cannot be rebound to another; the
person unlinks from the portal first.

`/link` reaches exactly the people the agent already answers: it runs after the
usual engagement rules, so a DM from someone outside the soul's DM allowlist is
dropped before the command is seen, and in a channel the agent must be engaged
or mentioned. Someone brand new therefore cannot self-onboard by DMing the
agent cold — add them to the allowlist, or have them ask in a channel where the
agent is active.

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

Both web apps are built into the container image now (`bun run web:build`, run
by the image's web stage and by CI). Until phase 4 they were not: `dist/` is
gitignored and nothing built it, so a deployed image served Vite's source
shell and the panel UI never worked in a container at all.

The console (`src/web/console/`, served at `/panel`) and the portal
(`src/web/portal/`) build with Vite from one shared codebase (`src/web/`).
It is a browser toolchain kept separate from the Bun server: excluded from
`bun test` and the server `tsc`, and checked by its own
`src/web/tsconfig.json`, which `bun run typecheck` also runs. `bun run
test:web` drives the built app under Playwright.
