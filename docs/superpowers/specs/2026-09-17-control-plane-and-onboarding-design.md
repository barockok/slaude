# Control plane consolidation and portal onboarding

Date: 2026-09-17
Status: design approved, implementation phased
Baseline: HEAD `2ac2546` (v0.44.0)

## 1. Why this document exists

An earlier findings review identified three bodies of work: fleet agent
management, user-scoped MCP credentials, and deterministic portal onboarding.
Verification against the code showed they are not three problems. They are one
problem seen from three angles: **identity and configuration are resolved from
the filesystem, so a node cannot run a job unless the agent's identity is
already physically present on it.**

That single fact is what couples the container image to the persona, what
forces a restart to add an agent, and what makes a user's integrations
invisible to every agent but the one they connected through.

This document sets the target architecture, fixes the two conclusions the
findings review got wrong, and phases the delivery.

### 1.1 Corrections to the findings review

Three of its conclusions do not survive contact with the code, and the design
below depends on the corrected versions.

**The runtime bundle carries less than claimed.** Only `providerCreds` is ever
consumed, in `src/node/worker.ts:164-171`. The soul, model, skills paths and
MCP config are computed, serialized, hashed into the ETag, shipped over the
wire, and discarded. The per-tenant bundle bug is therefore latent, gated
behind a `personas` table nothing populates, and its blast radius is provider
credentials only. It is a design landmine, not the most damaging live bug.

**Channels are not ungated.** A channel is heard only when it appears in
`trustedChannels` or `allowedChannels` in the soul file
(`src/gateway/core/gateway.ts:1229-1232`). Unlisted channels fall into the same
manager-only branch as direct messages. The onboarding access model must be
built on an allowlist, not on open channels.

**Credentials must not move into the database.** The findings review proposed
fetching credentials from the gateway per turn. The agent's own child process
owns `.credentials.json` at runtime and rewrites it on token refresh. A pulled
copy means refreshed tokens die with the pod, and any provider that rotates
refresh tokens on use would invalidate whatever the database still holds.
Database storage only works if the gateway is the sole writer, and it is not.
**The shared volume is the destination, not a stepping stone.**

## 2. Target architecture

### 2.1 The writer boundary

The rule that decides where every piece of state lives:

> **Anything the agent's own process writes lives on the shared volume.
> Anything it only reads is served by the gateway.**

| State | Writer | Home |
|---|---|---|
| MCP OAuth credentials | agent child, on refresh | shared volume |
| Transcripts (`projects/`) | agent child, per turn | shared volume |
| Soul, skills, plugins, settings | gateway (config writes) | runtime bundle |
| MCP server definitions, model | gateway | runtime bundle |
| Provider credentials | gateway | runtime bundle |
| Persona identity and routing | gateway | database |
| Account and Slack binding | gateway | database |

The volume stays read-write-many, because two nodes can hold sessions for the
same person at the same time. What changes is that it stops being the
configuration channel and shrinks to per-user runtime state.

### 2.2 What this buys

The persona directory stops existing on nodes. Identity stops being a
filesystem fact, so the container image becomes a pure capability statement
(what the agent can do) and the persona becomes configuration fetched at job
time (who it is). Two agents sharing a toolchain share an image and differ only
in the bundle they pull.

### 2.3 Non-goals

Capability-based queue routing (one queue per image) is deliberately out of
scope. It becomes possible once the bundle carries identity, but it is a
separate design. Multi-tenant Slack workspaces remain deferred. Local email
signup is out of scope: authentication is Keycloak or Google single sign-on
only.

## 3. Phase 0 — credential path correctness

Two bugs, one root cause: the persona argument is dropped at two call sites.
They are mutually exclusive by deployment mode, and a named-persona deployment
always has one of them.

**Paste-back deployments get false revocation.** `/mcp disconnect`
(`src/gateway/core/gateway.ts:1510`) calls `ensureInitiatorConfigDir(userId)`
with no persona, while connect (`:1496`) passes one. For a named persona,
disconnect looks in `oauth/<userId>`, finds nothing, and reports that the
server was not connected. The token remains at `oauth/<persona>/<userId>` and
is read again on the next session boot. The person believes they revoked
access; they did not.

**Loopback deployments get dead tokens.** The loopback `persistTokens` call
(`:814`) also omits the persona, though `a.personaName` is in scope and used
correctly in the paste-back branch at `:794`. The token is written to
`oauth/<userId>`, which no session ever reads, because `resolveSessionConfigDir`
always reads the persona-nested path. Connect reports success and the
integration silently never works.

Both fixes are one argument. Neither branch has any test coverage today, so
both get one.

Additionally, `removeEntry` shares the write-to-temp-then-rename pattern with
`writeEntry` (`src/agent/mcp-oauth/store.ts`), so both carry the symlink hazard
that phase 3 depends on. Both are made symlink-safe here, before anything
relies on it.

## 4. Phase 1 — control plane

### 4.1 Carry the tenant

`src/gateway/core/dispatch.ts` hardcodes `tenant: "default"` when minting the
job token (`:205`) and `tenantId: "default"` in the enqueued job (`:223`).
`slack_apps.tenant_id` is stored and never read on the execution path. Note
that `persona_id` is *not* dead: it already flows from dispatch into the job
and is re-read by the gateway. Only the tenant dimension is missing.

The tenant is resolved in the transport layer, carried through `DispatchMeta`,
into the job payload and into the job token. `"default"` stays the fallback, so
existing deployments are unaffected. `sessions.tenant_id` is written for real,
which also makes the panel's existing tenant filter
(`src/gateway/panel/api.ts:314`) meaningful rather than always matching
`default`.

### 4.2 Database as the source of truth for personas

Today the filesystem registry (`src/persona/registry.ts`) drives routing, the
outbound Slack client and soul loading, while the `personas` table drives the
runtime bundle and is never written by anything in `src/`, `scripts/` or
`tests/`.

The database becomes authoritative. A CRUD surface behind panel authentication
manages personas, and an import command seeds the table from existing
`~/.slaude/personas/` folders so no deployment loses its setup. The filesystem
loader remains as the import source only.

The registry stops being a process-local memoized map
(`src/persona/registry.ts:76`) and becomes a database-backed lookup with an
explicit invalidation hook, which is what makes section 4.4 possible.

### 4.3 Per-persona runtime bundle

`buildBundle` (`src/gateway/api/tenants.ts:63`) selects one persona per tenant
with `ORDER BY CASE WHEN name = 'default' THEN 0 ELSE 1 END, name LIMIT 1`, and
`NodeClient` caches on `tenantId` alone (`src/node/client.ts:77`).

The route becomes `/v1/tenants/:tenant/personas/:persona/runtime`, the node
cache is keyed on the `(tenant, persona)` pair, and the requested persona is
validated against the `persona` claim already present in the job token. The old
route is kept as an alias that resolves to the `default` persona, so nodes and
gateway can be rolled independently.

The bundle then starts carrying what it already computes: soul text, structured
soul, skills paths, MCP definitions and model become consumed rather than
discarded, replacing the node's filesystem reads. This is where the persona
directory stops being needed on nodes.

### 4.4 Make reload real

`publishReload` (`src/queue/pubsub.ts:101`) has zero callers in `src/`; only
tests call it. The subscriber is live (`src/node/worker.ts:191`). It is wired to
persona and tenant config writes, so a config change invalidates every node's
cache immediately instead of waiting for the next ETag revalidation. The
gateway's own persona lookup is invalidated on the same signal, which removes
the restart-to-add-an-agent problem (`src/server.ts:40`,
`src/node/main.ts:39`).

## 5. Phase 2 — identity

### 5.1 Model

Authentication is Keycloak or Google single sign-on. The gateway stores an
account record that is a local projection of that external identity, plus the
one thing the identity provider cannot give us: the Slack user ID binding.

At conversation time the mapping runs backwards. A message arrives carrying a
Slack user ID, the gateway looks up the linked account, and that account's
credentials are used. The Slack identity is a lookup key, not the thing
credentials are stored against.

### 5.2 The binding must be proven

A binding that lets any agent hand over a person's credentials cannot be
self-asserted. Approach chosen: **agent-delivered signed link.**

On 1:1 entry with no linked account, the agent posts an ephemeral Slack message
containing a link whose token encodes the Slack user ID, the team ID and an
expiry, signed with the gateway secret. The person clicks it, authenticates
through single sign-on, and the gateway creates the binding from the token's
claims rather than from anything the browser supplied.

Control of the Slack account is proven by delivery, because only that user can
see an ephemeral message addressed to them. Control of the email identity is
proven by the identity provider. No second identity provider is needed, and
`chat.postEphemeral` is already in use (`src/gateway/slack/mcp-tools.ts:354`).

Token rules: single use, consumed on binding; short expiry; bound to the team
ID so a token from one workspace cannot bind in another; stateless HMAC so any
gateway replica can verify it, following the existing `panel_flow` cookie
pattern. A Slack user ID already bound to a different account is rejected
rather than silently rebound.

### 5.3 Portal access for ordinary users

The panel today is operator-only and rejects any authenticated identity that
appears in neither role list, in three places
(`src/gateway/panel/auth/routes.ts:108`, `guard.ts:48`, `routes.ts:140`). There
is no baseline tier, no user table among the fifteen migrations, and no
email-to-Slack mapping anywhere.

The gap is not the login code, which is reusable as is. It is that the panel has
no per-identity data scoping: any authorized identity can list every session
and fetch any session by ID with no ownership check
(`src/gateway/panel/api.ts:304-330`).

So ordinary users do not get a role in the existing model. They get a separate
surface, mounted under its own path, sharing the single sign-on round trip but
not the operator guard. It exposes exactly one thing: the signed-in person's own
integrations. Operator routes keep their current guard unchanged, and no
ordinary-user session can reach them.

## 6. Phase 3 — user-scoped credentials

A canonical per-user credentials file at
`$SLAUDE_HOME/users/<userId>/.credentials.json`. The per-persona config
directory's `.credentials.json` becomes a symlink to it, created in
`ensureInitiatorConfigDir`. Everything else in that directory stays
per-persona, because the `projects/` symlink can only have one target
(`src/agent/oauth-home.ts:117-129`).

Access to it goes through a single `userCredentialPath(userId)` accessor, so
there is one module to change if this ever moves.

Default sessions continue to use the agent's own shared identity. A 1:1 session
swaps to the locked user's credentials, which is the existing behaviour; what
changes is only that those credentials are now the same ones across every
persona.

### 6.1 The symlink hazard

Both `writeEntry` and `removeEntry` write to a temp file and rename over the
target, which replaces a symlink with a regular file. Phase 0 makes both resolve
the link first.

The agent's own refresh write is the unknown, and it must be measured on Linux,
because on macOS the whole mechanism is bypassed by the login keychain
(`src/agent/oauth-home.ts:134-147`).

If the refresh write does break the link, the fallback is reconciliation at
session boundaries: when the credentials file is found as a regular file rather
than a link, merge its entries into the canonical store and restore the link.
The merge is per server key and last-write-wins on token expiry, and it runs
under a per-user lock so two nodes reconciling the same user cannot interleave.

## 7. Phase 4 — portal onboarding

Setup leaves the conversation. The person opens the portal, sees the available
integrations, authorizes them, and is done. Later, when they open a 1:1 with any
agent, the credentials are simply present.

The connect flow already supports this more than the findings review assumed.
It keys purely on the Slack user ID (`src/gateway/core/gateway.ts:737`); the
thread is used only to build a reply surface, and that surface was explicitly
designed to run outside a live turn (`:745`). The shared loopback already
demuxes concurrent flows by signed state and supports a public redirect URI.
What is needed is a non-Slack surface implementation and an identity resolution
step, not new OAuth machinery.

On 1:1 entry the gateway answers one question: is this Slack user linked? If
yes, carry on. If no, post the ephemeral onboarding link from section 5.2.
Onboarding unlocks the connected tools; it never gates the agent.

## 8. Horizontal scale requirements

These are acceptance criteria, not aspirations. Every one of them is verified
by a test in the plan.

1. **No per-persona state in node memory that outlives a job.** The bundle
   cache is keyed on `(tenant, persona)` and revalidated by ETag on every
   fetch.
2. **Two personas, one tenant, two nodes.** Each session receives its own
   persona's bundle. This is the case that silently fails today.
3. **Config writes reach every replica.** A persona update publishes reload;
   every subscribed node drops its cache; the gateway drops its persona lookup.
   No restart.
4. **Gateway replicas are interchangeable.** Onboarding tokens are stateless
   HMAC, so a link minted by one replica is redeemable on another. Login flow
   state stays in the signed cookie, as it already does.
5. **Concurrent credential access is safe.** Two nodes running sessions for the
   same person share one credentials file. Writes are atomic and symlink-safe;
   reconciliation holds a per-user lock.
6. **Single-writer invariants are preserved.** The reaper stays under leader
   election. Nothing added here introduces a second writer to a session.
7. **Rollout is order-independent.** The per-persona bundle route ships
   alongside the existing route so gateway and nodes can be rolled separately
   in either order.

## 9. Security considerations

- The onboarding token is a bearer credential for a Slack identity. Single use,
  short expiry, team-bound, and rejected when the Slack ID is already bound.
- Disconnect removes the stored grant but does not revoke at the provider. This
  is existing behaviour and stays true after phase 0; the success message
  should not imply more than it does.
- Sharing one credentials file across personas is a deliberate reduction in
  isolation. The code currently argues the opposite case in comments
  (`src/agent/oauth-home.ts:66-69`, `:83-85`), so those comments are updated to
  record that the change was made knowingly.
- The ordinary-user surface must never widen operator access. It is a separate
  mount with its own guard, and the existing operator guard is not relaxed.
- Approval and allowlist enforcement stay in the gateway, never in the model.
  Nothing in this design moves that boundary.

## 10. Delivery order

| Phase | Content | Depends on |
|---|---|---|
| 0 | Credential path bugs, symlink-safe writes | nothing |
| 1 | Tenant plumbing, persona source of truth, per-persona bundle, real reload | nothing |
| 2 | Accounts, single sign-on for ordinary users, signed-link binding | 1 |
| 3 | Per-user credential store | 0, 2 |
| 4 | Portal onboarding and the 1:1 entry check | 2, 3 |

Phase 0 is independent and ships first. Phase 1 is the structural unlock and
carries the horizontal scale criteria. Phases 2 through 4 are the user-facing
work and depend on the control plane existing.
