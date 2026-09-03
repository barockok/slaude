# Panel OIDC auth: replacing an unverifiable trust boundary

**Date:** 2026-08-29

The session control panel shipped with no authentication of its own. It read an
identity from a request header (`SLAUDE_PANEL_HEADER`, default
`x-auth-request-email`) that an SSO/ingress was supposed to inject, gated behind
an explicit `SLAUDE_PANEL_TRUST_HEADER=1` acknowledgement. The panel is now its
own OIDC **relying party**: Authorization Code + PKCE against one configured
issuer, identity from an ID-token claim, roles from operator-authored config, and
session credentials the panel mints for itself.

## Why the header had to go

`SLAUDE_PANEL_TRUST_HEADER=1` is an *assertion*, not a check. It says "an
authenticating proxy sits in front of me" and slaude has no way to confirm it.
The whole scheme rests on a step that happens in someone else's config file: the
proxy must unconditionally strip any client-supplied identity header before
re-injecting its own. Forget that one line — or route around the proxy at all —
and every caller sets the header and becomes any operator they like, with full
session control: stop, reset, chat as the agent.

The failure is silent. There is no request that looks wrong, no log line, no
boot-time symptom. A correctly configured deploy and a catastrophically broken
one are byte-identical from inside the process. That is the property that made it
unfixable rather than merely risky: a security control you cannot verify from the
side that depends on it is not a control.

The second problem was reach. With no ingress there was no way to run the panel
at all — local development, a single-node deploy. The obvious relief valve is a
bypass flag, and a bypass flag is exactly the thing that gets left on in
production. **There is no bypass flag anywhere in the codebase.** Local
development runs the real code path against a dev identity provider in a
container (`docker-compose.dev.yml`, realm in `dev/keycloak/`).

## The no-user-table constraint

The design keeps a hard constraint from the original panel: slaude stores **no
operator records**. No user table, no session table, no anything. That single
constraint determines most of what follows.

**Self-contained session tokens.** With nowhere to store a server-side session,
the session *is* the token: HS256 over `node:crypto`, keyed by
`SLAUDE_PANEL_SECRET`, carried in cookies. `panel_at` (15 min, `Path=/panel`)
authorizes ordinary requests; `panel_rt` (8 h, `Path=/panel/auth/refresh`) buys a
new access token. The narrow refresh path keeps that cookie off every request
that does not need it. Both are `HttpOnly; Secure; SameSite=Lax` — `Lax` and not
`Strict`, because the provider's callback is a top-level cross-site GET and
`Strict` would withhold the flow cookie at precisely the moment it is needed.

**No revocation.** This is the honest cost, not an oversight. A denylist needs
storage. The bounds that remain are time and scope: the access token dies in 15
minutes, and the refresh window is **absolute, not sliding** — after eight hours
the operator goes back to the provider, whatever they were doing. Rotating
`SLAUDE_PANEL_SECRET` invalidates every outstanding session at once and is the
break-glass. A stolen cookie is good for at most its remaining TTL.

**No server-side flow state either.** The login flow needs `state`, `nonce`, a
PKCE verifier and a `returnTo` to survive a round trip through the provider, and
there is no store to park them in. They travel in a signed 10-minute `panel_flow`
cookie scoped to `/panel/auth`, verified and cleared at the callback. The same
trick as the session tokens, applied to a much shorter-lived secret.

**Roles from config, not from the provider.** Group claims would mean coupling
admission to whatever the provider's directory happens to say, and mapping code
per provider. Instead a YAML file the deployment operator owns
(`$SLAUDE_HOME/panel-roles.yaml`, or env fallbacks) lists two roles. Matching is
exact and case-insensitive; in both lists ⇒ `superadmin`; in neither ⇒ `null`,
which is a 403 — *authenticated, not authorized*, a distinct outcome from *not
signed in*. The file is re-read on mtime change, so granting access is an edit,
not a redeploy. Malformed YAML at boot is fatal; malformed at runtime keeps the
last good config and records an error, because a typo must not lock every
operator out of a live fleet.

This shape — discovery-based provider config, one nominated claim as the
identity, admission by declared rules, a self-contained token with a TTL and a
renewal endpoint — is the same one used by operator-facing secret-management
systems that authenticate through OIDC without keeping a user directory. Those
systems also offer a stateful, revocable server-side token; that variant needs
storage, so it is deliberately not adopted here.

## Why the ID token's signature is not verified

The panel never fetches a JWKS and never handles provider key rotation.

The ID token is only ever obtained as the direct response to the server-to-server
code exchange: the panel's own request, to the discovered `token_endpoint`, over
TLS, authenticated with the client secret. OIDC Core §3.1.3.7 explicitly permits
treating a token acquired that way as verified without checking its signature —
TLS plus client authentication already establishes that the issuer produced it.
Discovery is still used, for the endpoint URLs.

**The precondition is the whole argument, so state it plainly:** this is sound
*only* because the panel never accepts a provider token from a client. The moment
some future route takes a bearer ID token off an inbound request, signature
verification against the issuer's JWKS becomes mandatory — the claims are then
attacker-supplied and nothing but the signature stands between them and
impersonation. That pattern already exists in the tree
(`src/knowledge/server/oauth-guard.ts`, `jose` + remote JWKS) and should be
reused rather than re-derived. The precondition is recorded in the code, not only
here.

The provider's `id_token`, `access_token` and `refresh_token` are all discarded
at the end of the callback. After login the provider is never contacted again.

## Why the role is not a token claim

Authentication and authorization are deliberately split. The session token
carries **identity only** — `sub`, `email`, `iat`, `exp`, `jti`. The role is
resolved from config on **every request**.

The alternative — baking `role: superadmin` into the access token at login — is
cheaper by one config read, and wrong in the way that matters. Demoting someone
would then take effect at their next token refresh, not their next request: up to
fifteen minutes of retained superadmin during exactly the incident where you are
trying to take it away. Since there is no revocation, a role stamped into a token
is a privilege you cannot withdraw for the life of that token.

Re-resolving per request buys back the one thing the no-storage design otherwise
gives up. Remove an identity from the file and the next request is a 403. Delete
them from both lists and they are 403 everywhere, immediately, without waiting
for anything to expire. The cost is a read served from the mtime cache.

The role matrix is small and enforced server-side in `api.ts`: `superadmin` gates
`reset` (discards session state, unrecoverable), permission-`mode` changes
(`bypassPermissions` lets the agent act without gates — privilege escalation),
and `force-release` (steals another operator's lock). Everything else is open to
any listed operator. `superadmin` is a strict superset; no route requires
"operator but not superadmin". The web app disables controls the current role
cannot use, which is presentation only — the server is the sole authority, and
the tests assert the server refuses regardless of what the client renders.

## Audit

With no database, stdout is the only record of operator action. `audit.ts` emits
one JSON object per line — no pretty-printing, so log pipelines can split on
newlines — for every mutating route and every authentication decision, including
`auth.denied` for an authenticated-but-unlisted identity and `outcome: "denied"`
for role rejections. Never recorded: tokens, cookie values, the authorization
`code`, the client secret, or chat content.

## Consequences

- The panel cannot run without an identity provider. That is the point; the
  fallback was the impersonation footgun this replaced.
- Google and Keycloak differ only in the issuer URL. There is no
  provider-specific code — discovery absorbs the difference.
- With `SLAUDE_PANEL=1`, any missing required variable refuses the boot, keeping
  the fail-closed posture the trust-header guard had.
- Deferred to a follow-up, each additive: a `jti` denylist for real revocation,
  RP-initiated logout, multiple issuers, group-claim role mapping, domain
  wildcards, a read-only `viewer` role.

Spec: `docs/internal/superpowers/specs/2026-08-29-panel-oidc-auth-design.md` (supersedes
§6 of `docs/internal/superpowers/specs/2026-08-25-session-control-panel-design.md`).
Plan: `docs/internal/superpowers/plans/2026-08-29-panel-oidc-auth.md`.
