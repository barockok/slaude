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
| **Agents** | Every agent (persona) with its live state. An agent's page has five tabs: *Overview* (identity, model, the label it runs on), *Mandates* (its jobs: the soul's mandate, each channel block and scope with its boundary, mode and effective text, each cron and the heartbeat, with triggers and the approvers who can actually approve; then its proactive settings and caps, the wake tool allow-list, budgets and the rules it learned), *Access* (effective grants from the soul and the console; then approvals, permission cards, admission and redaction), *Guardrails* (the owner guardrails that apply to it, shared and its own) and *Activity* (its audit events). |
| **Sessions** | Live and recent sessions with filters by agent and status. A session has a *Timeline*, a *Chat* tab and its *Audit* events. |
| **Approvals and audit** | Every permission and approval decision, refusal and expiry, and every console change, newest first, filterable by agent, action, actor, decision and time. An event the agent itself did shows the agent's name as its actor, not its bot user id. |
| **Access** | Console roles (read only, from the role file; superadmins only, operators see a note) and every stored agent grant. |
| **Users** and **Boundaries** | The domain records (superadmin only, read only). *Users* lists every person and bot the deployment has matched: the preferred binding (a verified email, else a Slack id), how many of its bindings are verified, observed or declared, its alias count and when it was created. A user's drawer lists each binding (service, workspace, masked value, state, source) and the ids merged into it. *Boundaries* lists channels and groups with service, workspace, state, display name and age. Both filter by state and service and search by the start of a value. |
| **Memory** | Memory stores with page counts; a store lists its pages; a page shows its content, type, tags and links. Read only. Below the stores, *Write rules* shows per agent what it may write without asking and who must approve the rest. |
| **Environments** | Node pools (labels, live nodes, last heartbeat), each agent's placement label, and personal environments (secrets never shown). |
| **Resources: Skills** | Every skill an agent can use, filterable by source, agent and status, with search. A skill's page shows its `SKILL.md` rendered (raw and copy too), where it came from, which agents have it, its files, per-agent usage and related proposals. |
| **Resources: Guardrails** | The owner's guardrails: scope, enforced rules by kind, Guidance, source, status and when each last fired, with a page per guardrail. A superadmin creates one from a template, edits it (an override for a deploy repo or host-file guardrail, shown as a diff against its source), clears an override, deletes a console guardrail and switches any off and on. *Test a guardrail* tries a tool call, a reply or a message against an agent's guardrails. |

**Grants.** A superadmin adds or revokes an agent grant from the agent's
*Access* tab: a user, a channel's members or a whole workspace gets the
`member`, `approver` or `manager` role on that agent, or a user is denied. A
change applies at once on the replica that made it and within a few seconds on
the others. Grants are keyed by persona name, so a persona renamed in git is a
new persona and its grants must be re-created. Operators see grants but cannot
change them. A stored approver grant applies in every channel, unlike the
approvers in an agent.yaml `access.approvers` entry with a `channel`, which replace the global list in
their channel only. A channel grant takes a channel id (`C` or `G`); for DMs,
give the person a user member grant with DM only. A deny grant also removes
the user from every approval card, the default persona's included. The console
roles list (who may sign in, and as what) is visible to superadmins only.

**Markdown.** Memory pages, `SKILL.md` files, mandate text, the soul's own
guardrail sections and the agent's messages in a session's timeline and chat
are shown rendered. Every one has a *Rendered* or *Raw* switch (each viewer's
choice, remembered in the browser) and a copy button. Rendering never passes
HTML through: raw HTML in the text shows as text, and only `http`, `https` and
`mailto` targets become links. People's own messages keep Slack's formatting
(links, mentions) rather than markdown.

**Skills.** Each skill has one source:

- *Built-in*: slaude's own `slaude:*` skills, part of every session.
- *Installed*: in the shared skills root (`$SLAUDE_HOME/skills`) or an agent's
  own root, put there by the dependency manifest (`slaude.json`, pinned in
  `slaude.lock`: the page shows the repository, ref and commit), shipped with
  the release, or placed by hand (in no lock).
- *Plugin*: from a Claude Code plugin installed from the manifest; every
  session mounts it.
- *Agent-authored*: written by the agent with `write_skill`. The default
  agent writes to the shared root, so every agent sees it; a named agent
  writes to its own root (`$SLAUDE_HOME/personas/<name>/skills`), which
  shadows a shared skill of the same name for that agent only.

Uses come from the `skill_usage` table (a counted load of the skill), keyed by
the name the agent called the skill with: a shared or own skill by its name, a
built-in as `slaude:<name>`, and a plugin skill as `<plugin>:<name>` (the
name in its frontmatter, as the plugin lists it), `<plugin>:<directory>`, or
its bare name when no other skill has that name. A
superadmin can **retire** an agent-authored skill (it moves to `.retired/` and
stops reaching the agent, the same path the weekly skill review takes, so the
next digest lists it and the manager can restore it from Slack) and **restore**
a retired copy. Both are recorded in the audit trail (`skill.retired`,
`skill.restored`). Installed, plugin and built-in skills are changed where they
come from (the manifest, the personas repo), never from the console.

**Guardrails.** The page lists the owner's guardrails: rules you set for your
agents the way you set their souls, shared by every agent or for some, written
as `GUARDRAIL.md` in the deploy repo's `guardrails/` folder or imported from
host files (`slaude guardrails import <dir>`). Each row shows the scope, the
rules by kind (*Enforced*: checked by code and never in the prompt;
*Guidance*: text the agent reads),
the source (*Deploy repo*, *Host file*, *Console override*, *Behind source*),
the status (on or off, validation problems, applies to no agent, over the
always-loaded prose cap) and when it last fired. A guardrail's page shows its
`GUARDRAIL.md` (Rendered, Raw, Copy), the parsed rules, its problems, the
agents and channels it applies to (names resolved), its Guidance and triggers,
and its recent firings from the audit trail. A superadmin can switch a
guardrail off and on: one audited write, then a config reload so nodes and warm
sessions pick it up after their turn.

Superadmins also edit guardrails (`rc.11`). *New guardrail* starts from a
template (Enforced rule examples or Guidance). The editor checks the text as
you type with the server's own parser: a rule that would refuse the save is
shown inline and disables *Save*, other problems are shown, unknown agent
names are flagged, and the always-loaded prose cap names the guardrail it
would leave out. A console guardrail is edited in place and can be deleted. A
guardrail from the deploy repo or host files is edited as a console override:
its source text stays, the override is kept across syncs and marked *Behind
source* when the source changes, and its page shows the override as a diff
against the source with a *Clear override* button; it cannot be deleted from
the console (switch it off). Every save carries the revision the editor
loaded; when someone else saved first, the save is refused and the editor
offers a reload, keeping your edits to copy. While the stored set fails to
verify, every write is refused with the repair command. Each write is audited
without the text and announced to nodes and warm sessions like the switch.

The *Test box*, on each guardrail's page, under the editor (with the unsaved
text) and on *Test a guardrail*, takes a tool call (name and JSON input), a
reply or an inbound message, an agent and a channel, and shows every rule
that matches, the deciding action, what would happen, the Guidance that loads
or would be delivered, and inputs too large to check. It runs the runtime's
own matcher and does nothing else (one `guardrail.tested` audit row, without
the text). Operators read everything, validate and test, and cannot write.
The page also
says how strongly the deployment keeps an agent from changing its own
guardrails: with Postgres or nodes a session cannot reach the database; on one
process with sqlite the guarantee is drift and tamper detection only. The
format, the threat model and the audit actions are in the
[guardrails reference](../reference/guardrails.md).

The runtime's own layer (its hooks, gates and deny lists) is not shown: it
lives in the code (`src/agent/guardrails.ts`), checked by a test against the
hooks real sessions are built with.

**Agent settings.** The soul and access settings that constrain an agent are
shown where they apply (until `rc.10` they were folded under Guardrails). The
*Access* tab has approvals (who may approve for this agent, the scope words
of the default agent's approvers, and the approval timeout), permission cards
(always-allowed tools from `SLAUDE_AUTO_ALLOW_TOOLS`, the default permission
mode, who may decide a card, and the agent's threads per permission mode),
admission and grants, and redaction (the default soul's patterns plus the
agent's own; the patterns themselves are shown to superadmins only, operators
see a count). The Memory page's *Write rules* has the memory write tiers
(what is read freely, written freely, needs approval or a manager) and the
profile write guard, per agent. The *Mandates* tab has proactive restraint
(from the soul's `## Proactive` block and the code's caps), the wake tool
allow-list, the background and wake budgets, and the learned proactive rules
(read from the agent's memory on their own, so a slow brain never holds up
the tab). Each value has a source badge: *Env*, *Soul*, *Persona* (its config
in git), *Console* (a stored grant), *Learned*, *Default* or *Fixed* (in the
code). Change a value where its badge points; these cards never edit.

**Surfaces.** Slack is the only chat surface today, but the console names it
from a small registry (label, its word for a conversation, how to show a
conversation id), and session views, history lines, live messages and audit
events say which surface they came from. Words that are Slack-only stay where
the feature is Slack-only: grants (Slack user, channel and workspace ids), an
agent's Slack user, and `/env`.

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

## Domain records: Users and Boundaries

These two pages read the records described in the typed references
spec: a *user* (a person or bot), the *bindings* that tie it to a service
identity, and *boundaries* (a Slack channel, later a WhatsApp group). They
are a projection kept in step with accounts, portal links, first sight and
agent.yaml sync. Nothing here changes a record and nothing reads these for
access yet; the pages carry a note saying so. Resolving a conflict and
undoing a merge arrive in a later release.

The API is `GET /panel/api/users`, `GET /panel/api/users/:id` and
`GET /panel/api/boundaries`, all superadmin only (an operator gets `403`, and
the denied attempt is audited like any other superadmin action).

- **States.** A record is *declared* (named in an agent.yaml, not seen),
  *observed* (seen sending or being used) or *verified* (proven, for
  example by a portal link or sign-in). A state only goes up.
- **Unmatched.** A user whose bindings are all declared, or a boundary that
  is declared, and that was created more than seven days ago. It usually
  means an agent.yaml names someone who never showed up: a typo, or a person
  who has not used the agent yet. A user with no bindings is not flagged.
- **Preferred binding.** A verified email, else the best Slack binding
  (verified first, then oldest); a user holding only other bindings shows
  the best of those.
- **Masking.** Email addresses (and any value shaped like one, such as a
  sign-in subject) are shown as `a***@example.com`, phone numbers keep their
  last two digits. The full value is never in a list or a detail answer. The
  *search* box matches the start of a stored value, but never a masked one:
  an email binding, a phone binding or a value shaped like an address (a
  sign-in subject) does not answer a search, so a prefix cannot be used to
  confirm that an address exists. Find a user by a Slack id, or list with
  `service=email` and no search to see the masked rows.
- **Filters and paging.** `state` (`declared`, `observed`, `verified`),
  `service` (`slack`, `email`, ...), `q` (value prefix, never an email, phone or address-shaped value), `limit` (default 50,
  at most 200) and `cursor` (from `nextCursor`). Newest first. A user filter
  matches a user that has a binding with every given state, service and
  prefix. A detail request also accepts the id of a merged user and answers
  with the user it became.

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

- **My account**: the signed-in identity and the chat identities linked to it,
  each with its surface (Slack today), workspace and user, shown by name with
  the id as secondary text.
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

**Binding is user-driven.** A person sends `/link` to the agent as a message
and gets a private, 15-minute link. In Slack, put a space before it or mention
the agent (`@agent /link`): Slack treats a message that starts with `/` as one
of its own slash commands and rejects `/link` as not a valid command, while
slaude reads its commands from the message text. The generated Slack app
manifest registers no slash commands, because the gateway handles none (it
has no slash-command endpoint). Opening the link while signed in to the portal
binds the two identities; the confirmation page shows the workspace and Slack
user names when the gateway can resolve them, with the ids beneath. Replies to `/link` are always ephemeral, and a
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
