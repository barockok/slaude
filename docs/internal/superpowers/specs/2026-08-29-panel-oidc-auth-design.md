# Panel OIDC auth — design

Date: 2026-08-29
Status: approved (brainstorm), pending implementation plan
Supersedes: the operator-header auth in `2026-08-25-session-control-panel-design.md` §6

## Problem

The session control panel (PR #96) has no authentication of its own. It trusts
an identity header injected by an SSO/ingress in front of it
(`SLAUDE_PANEL_HEADER`, default `x-auth-request-email`), gated by an explicit
`SLAUDE_PANEL_TRUST_HEADER=1` acknowledgement and an optional allowlist
(`SLAUDE_PANEL_ALLOW`).

Two problems with that:

1. **It cannot be run without an ingress.** There is no way to reach the panel
   directly — local development, a single-node deploy, or any operator without
   an oauth2-proxy in front is stuck.
2. **The trust boundary is unverifiable.** `SLAUDE_PANEL_TRUST_HEADER=1` only
   *asserts* that an authenticating proxy exists. If the proxy fails to strip a
   client-supplied identity header, any caller sets it and impersonates any
   operator, gaining full session control (stop / reset / chat-as-agent). slaude
   cannot detect this.

## Goals

- The panel authenticates operators itself, against Google or Keycloak.
- No user table. slaude stores no operator records of any kind.
- slaude issues its own session credentials (access + refresh), so the identity
  provider is contacted only during login.
- Roles (`superadmin`, `operator`) are declared by the deployment operator in
  config, not derived from provider group claims.
- Fail closed everywhere: misconfiguration refuses to boot; an authenticated but
  unlisted identity is refused.

## Non-goals (v1)

Token revocation / denylist; provider-initiated (RP) logout; multiple
simultaneous identity providers; group-claim role mapping; domain wildcards in
role lists; a read-only `viewer` role. Each is additive later.

## Design overview

The panel becomes an OIDC Relying Party. It performs Authorization Code + PKCE
against a single configured issuer, reads the identity claim from the resulting
ID token, discards the provider's tokens, and mints its own signed session
tokens carried in cookies.

Authorization is separate from authentication: the session token carries
*identity only*. The role is resolved from operator-authored config on every
request, so a role change takes effect at the next request rather than the next
token refresh.

### Prior art

This mirrors the shape used by secret-management systems that authenticate
operators through OIDC without maintaining a user directory: discovery-based
provider config, a claim nominated as the identity, admission decided by
declared rules, and a self-contained, self-issued token with a TTL and a
renewal endpoint. The equivalent of a stateful, revocable server-side token is
deliberately not adopted here — it requires storage, which the no-user-table
constraint rules out. What remains is the self-contained-token variant.

### Why no JWKS verification

The ID token is only ever received as the direct response to the server-to-server
code exchange over TLS with the client secret. OIDC Core §3.1.3.7 permits
treating a token obtained that way as verified without checking its signature.
The panel therefore never fetches a JWKS and never handles provider key
rotation. Discovery is still used, for the authorization and token endpoint
URLs.

This is safe *only* because the panel never accepts a provider token from a
client. If a future change accepts a bearer ID token on an API route, signature
verification against the issuer's JWKS becomes mandatory —
`src/knowledge/server/oauth-guard.ts` already implements that pattern.

## Module layout

New directory `src/gateway/panel/auth/`, replacing the current single
`src/gateway/panel/auth.ts`.

| File | Purpose | Depends on |
|---|---|---|
| `oidc.ts` | Discovery document fetch + cache; authorize-URL builder (PKCE, `state`, `nonce`); code→token exchange; ID-token claim extraction and validation. Provider-agnostic. | `fetch` |
| `session.ts` | Mint and verify the access + refresh tokens (HS256 over `node:crypto`); cookie serialize/parse. | `node:crypto` |
| `roles.ts` | Resolve an identity string to `"superadmin" \| "operator" \| null` from the role config. Pure. | config loader |
| `routes.ts` | `/panel/auth/{login,callback,refresh,logout,me}`. The only module that talks to the provider. | the three above |
| `guard.ts` | Per-request: cookie → verify access token → resolve role → `{operatorId, role}`. Replaces `authenticateOperator`. | `session.ts`, `roles.ts` |
| `audit.ts` | One-line JSON audit records to stdout. | — |

`session.ts` reuses the HS256 mint/verify approach already in
`src/gateway/api/auth.ts` (hand-rolled over `node:crypto`, `alg` from the header
ignored, HS256 always enforced) rather than adding a JWT library.

Changes to existing files:

- `api.ts` — drop the `SLAUDE_PANEL_TRUST_HEADER` boot guard; swap
  `authenticateOperator` for `guard.ts`; add per-route and per-action role
  checks. The existing `enforceCsrf` is retained unchanged.
- `static.ts` — an unauthenticated request for an HTML path redirects to
  `/panel/auth/login` instead of returning 403.
- `src/config/env.ts` — the `panel` block gains the OIDC settings and drops the
  header settings.

**Boundary:** `roles.ts` takes an identity string plus config and returns a
role. It has no knowledge of HTTP, cookies, crypto, or the provider, and is
tested without any of them.

### Deleted

`SLAUDE_PANEL_TRUST_HEADER`, `SLAUDE_PANEL_HEADER`, the header-trust code path
and its tests, and the "ingress MUST strip the identity header" requirement in
`docs-new/deployment/multi-node.md` (the class of bug no longer exists).

`SLAUDE_PANEL_ALLOW` is superseded by the role lists. It is not silently
repurposed: if it is still set at boot, the panel refuses to start with a
message naming its replacement.

## Data flow

### Login — `GET /panel/auth/login?returnTo=<path>`

1. Generate `state`, `nonce`, and a PKCE `code_verifier` (32 random bytes each).
2. Because there is no server-side store, the flow state travels in a signed,
   10-minute `panel_flow` cookie (`HttpOnly; Secure; SameSite=Lax;
   Path=/panel/auth`) carrying `{state, nonce, verifier, returnTo}`.
3. Redirect (302) to the discovered `authorization_endpoint` with `client_id`,
   `redirect_uri`, `scope=openid email profile`, `code_challenge` (S256),
   `code_challenge_method=S256`, `state`, `nonce`.

### Callback — `GET /panel/auth/callback?code&state`

1. Read and verify the `panel_flow` cookie signature; require its `state` to
   equal the query `state`. Mismatch, absent, or expired ⇒ 400 and clear the
   cookie.
2. `POST` to the discovered `token_endpoint` with `code`, `code_verifier`,
   `client_id`, `client_secret`, `redirect_uri`.
3. Decode the returned `id_token` claims. Require `iss` == configured issuer,
   `aud` == client id, `nonce` == the flow cookie's nonce, `exp` in the future.
4. `identity = claims[SLAUDE_PANEL_USER_CLAIM]` (default `email`), trimmed and
   lowercased. A missing claim ⇒ 400. The provider's `id_token`, `access_token`,
   and `refresh_token` are discarded here and never stored.
5. Resolve the role. `null` ⇒ 403 ("authenticated, not authorized"), no cookies
   set, `auth.denied` audit record.
6. Mint the token pair, set both cookies, clear `panel_flow`, redirect to
   `returnTo`. `returnTo` is accepted only if it is a same-origin path beginning
   `/panel`; anything else falls back to `/panel`.

### Cookies

| Cookie | TTL | Path | Claims |
|---|---|---|---|
| `panel_at` | 15 min | `/panel` | `sub`, `email`, `iat`, `exp`, `jti` |
| `panel_rt` | 8 h | `/panel/auth/refresh` | `sub`, `email`, `iat`, `exp` |

All three cookies (including `panel_flow`) are `HttpOnly; Secure;
SameSite=Lax`. The refresh cookie's narrow `Path` keeps it off every ordinary
request.

Neither token carries the role — see *Authorization*.

`SameSite=Lax` is required (not `Strict`): the provider's callback is a
top-level cross-site GET navigation, and `Strict` would withhold the flow
cookie exactly when it is needed.

### Authenticated request

`guard.ts`: parse `panel_at` → verify HS256 signature and `exp` → resolve the
role → attach `{operatorId, role}`.

- Role `null` ⇒ 403.
- Role insufficient for the route or action ⇒ 403 plus an audit record.
- Token absent or expired: API paths ⇒ `401 {"error":"session expired"}`; HTML
  paths ⇒ 302 to `/panel/auth/login?returnTo=<path>`.

### Refresh — `POST /panel/auth/refresh`

Verify `panel_rt`, re-resolve the role (now `null` ⇒ 401 and clear both
cookies), mint a fresh access token.

The refresh cookie is **not** re-issued. Eight hours is an absolute cap, not a
sliding window: an operator re-authenticates at the provider once per working
session. This is the only bound on a stolen refresh cookie, since there is no
revocation.

The web app calls this once on any `401`, then retries the original request; a
second `401` triggers a hard redirect to login.

### SSE and token expiry

`EventSource` cannot set request headers but does send cookies, so the
`Path=/panel` access cookie authorizes `GET /panel/api/sessions/:id/events`.

The stream is authorized at connect time. When the access token's `exp` passes,
the server emits a final SSE event of type `session-expired` and closes the
stream. The client
refreshes and reconnects with `Last-Event-ID`, which the existing resume path
already handles — so expiry costs a reconnect, not lost events.

### Logout — `POST /panel/auth/logout`

Clears both cookies. The operator remains signed in at the provider; there is no
RP-initiated logout in v1.

### CSRF

Cookie-borne credentials are attached by the browser to cross-site requests, so
the existing anti-CSRF guard is load-bearing and is retained unchanged: non-GET
requests require `x-panel-csrf: 1` and a non-cross-site `Sec-Fetch-Site` when the
browser sends one. `SameSite=Lax` backs it up. The callback is a deliberate
cross-site top-level GET and is protected by `state` instead.

## Authorization

### Route and action matrix

| Route | Required role | Rationale |
|---|---|---|
| `GET /api/sessions` | operator | read |
| `GET /api/sessions/:id` | operator | read |
| `GET /api/sessions/:id/events` | operator | live tail |
| `POST /api/sessions/:id/chat` | operator | driving a session you hold |
| `POST /api/sessions/:id/lock` | operator | take control |
| `POST /api/sessions/:id/heartbeat` | operator | hold control |
| `POST /api/sessions/:id/release` | operator | give control back |
| `POST /api/sessions/:id/control` — `stop` | operator | interrupts a turn; recoverable |
| `POST /api/sessions/:id/control` — `model` | operator | scoped behaviour change |
| `POST /api/sessions/:id/control` — `unlock-1on1` | operator | scoped to one thread |
| `POST /api/sessions/:id/control` — `reset` | **superadmin** | discards session state; unrecoverable |
| `POST /api/sessions/:id/control` — `mode` | **superadmin** | `bypassPermissions` lets the agent act without gates — privilege escalation |
| `POST /api/sessions/:id/force-release` | **superadmin** | steals another operator's lock |

`superadmin` is a superset of `operator`: every route an operator may call, a
superadmin may call too. There are exactly two roles and no route requires
"operator but not superadmin".

Enforced in `api.ts`. For `control`, the check runs after schema validation so
it can read the parsed `action`.

The web app additionally disables controls the current role cannot use. This is
presentation only; the server is the sole authority.

### Role configuration

Primary source — `$SLAUDE_HOME/panel-roles.yaml` (path overridable via
`SLAUDE_PANEL_ROLES_FILE`):

```yaml
superadmin:
  - lead@example.com
operator:
  - alice@example.com
  - bob@example.com
```

Rules:

- Matching is exact and case-insensitive against the resolved identity claim.
  No wildcards or domain patterns in v1.
- An identity in both lists resolves to `superadmin`.
- An identity in neither list resolves to `null` — authenticated, not
  authorized, 403.
- If the file is absent, fall back to the comma-separated env lists
  `SLAUDE_PANEL_SUPERADMIN` and `SLAUDE_PANEL_OPERATORS`.
- If neither the file nor the env lists yield any entry, the panel refuses to
  boot. A panel nobody can reach is a misconfiguration, not a safe default.
- The file is cached and re-read when its mtime changes, so granting access is a
  file edit rather than a redeploy.
- Malformed YAML at boot ⇒ refuse to start. Malformed YAML at runtime ⇒ keep the
  last good config and emit an error record; a typo must not lock every operator
  out of a live fleet.

### Role resolution timing

The role is resolved on **every request**, from config, and is deliberately not
a token claim. Removing an identity from the superadmin list demotes them at the
next request rather than at the next token refresh. The cost is a config read
per request, served from the mtime cache.

## Audit records

`audit.ts` writes one JSON object per line to stdout — no pretty-printing, so
log pipelines can split on newlines.

```json
{"ts":"2026-08-29T10:12:03.114Z","evt":"panel.audit","action":"control.reset","operator":"lead@example.com","role":"superadmin","session":"S-123","outcome":"ok","detail":{"prevLockOwner":"alice@example.com"}}
```

Fields: `ts` (ISO 8601), `evt` (always `panel.audit`), `action`, `operator`,
`role`, `session` (omitted for auth actions), `outcome` (`ok` | `denied` |
`error`), `detail` (action-specific, optional).

Emitted for every mutating route and every authentication decision:
`auth.login`, `auth.denied`, `auth.refresh`, `auth.logout`, `chat`, `lock`,
`release`, `force-release`, `control.<action>`. Role rejections are recorded
with `outcome: "denied"`.

Never logged: tokens, cookie values, the authorization `code`, the client
secret, or chat message content.

Because there is no database, stdout is the only record of operator actions.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SLAUDE_PANEL` | — | `0` | Enable the panel surface (unchanged) |
| `SLAUDE_PANEL_OIDC_ISSUER` | yes | — | Issuer URL; endpoints via `/.well-known/openid-configuration` |
| `SLAUDE_PANEL_OIDC_CLIENT_ID` | yes | — | |
| `SLAUDE_PANEL_OIDC_CLIENT_SECRET` | yes | — | |
| `SLAUDE_PANEL_PUBLIC_URL` | yes | — | Derives `redirect_uri`; must match the provider registration |
| `SLAUDE_PANEL_SECRET` | yes | — | HMAC key for session and flow cookies; minimum 32 characters |
| `SLAUDE_PANEL_USER_CLAIM` | — | `email` | Which ID-token claim becomes the operator identity |
| `SLAUDE_PANEL_ROLES_FILE` | — | `$SLAUDE_HOME/panel-roles.yaml` | Role list file |
| `SLAUDE_PANEL_SUPERADMIN` | — | — | Env fallback, comma-separated |
| `SLAUDE_PANEL_OPERATORS` | — | — | Env fallback, comma-separated |

With `SLAUDE_PANEL=1`, any missing required variable causes the process to
refuse to start — the same fail-closed posture the trust-header guard had.

Google and Keycloak differ only in the issuer URL
(`https://accounts.google.com` vs `https://<host>/realms/<realm>`). There is no
provider-specific code.

## Frontend changes

In `src/gateway/panel/web/`:

- The `api()` fetch wrapper: on `401`, call `/panel/auth/refresh` once and retry;
  a second `401` triggers a hard redirect to `/panel/auth/login`.
- New `GET /panel/auth/me` → `{email, role}`; the header gains an identity chip
  showing the email, a role badge, and a sign-out action.
- A distinct "authenticated, not authorized" screen, separate from the
  session-expired path.
- Superadmin-only controls render disabled with a "requires superadmin"
  tooltip rather than being hidden — an operator should see that the control
  exists.

No login page is rendered: an unauthenticated HTML request redirects straight to
the provider.

## Testing

### Unit — no network, no provider

- `roles.ts`: file-over-env precedence; case-insensitive matching; presence in
  both lists ⇒ superadmin; absence ⇒ `null`; malformed YAML at runtime keeps the
  last good config; malformed at boot throws; empty config throws.
- `session.ts`: mint/verify round-trip; rejects a tampered payload, a wrong
  secret, an expired `exp`, and algorithm-confusion attempts (`alg: none`,
  `alg: RS256`); cookie serialization emits exactly `HttpOnly; Secure;
  SameSite=Lax` with the correct `Path` per cookie.
- `oidc.ts`: authorize-URL shape (S256 challenge, scope, redirect_uri, state,
  nonce); claim validation rejects wrong `aud`, wrong `iss`, mismatched `nonce`,
  expired `exp`, and a missing identity claim.
- `audit.ts`: one line per record, valid JSON, no secret-bearing fields.

### Route level — `fetch` against the panel handler, token endpoint stubbed

- Full round trip: login → callback → authenticated request → refresh → logout.
- Callback with mismatched `state` ⇒ 400; a replayed `state` after the flow
  cookie is cleared ⇒ 400.
- Authenticated but unlisted identity ⇒ 403, no cookies set, `auth.denied`
  recorded.
- An `operator` calling `reset`, `mode`, or `force-release` ⇒ 403; a
  `superadmin` ⇒ 200.
- Role demoted mid-session by rewriting the roles file ⇒ the next request is 403,
  without waiting for token expiry.
- Expired access token + valid refresh ⇒ 401, then refresh succeeds; expired
  refresh ⇒ 401 with both cookies cleared.
- `returnTo` pointing off-origin ⇒ redirect to `/panel`, not the supplied URL.
- The CSRF regression tests from `7f0f43e` re-run against cookie auth.
- Boot guards: each required variable missing ⇒ refuses to start; a leftover
  `SLAUDE_PANEL_ALLOW` ⇒ refuses to start with the migration message.

### End-to-end — Playwright, extending `tests/panel-web/`

`stub-server.ts` gains a stub provider speaking discovery, authorize, and token.
Covers: redirect to the provider when unauthenticated; the round trip landing on
the fleet list; the identity chip; superadmin-only controls disabled for an
`operator`; and a mid-session `401` producing a silent refresh followed by an SSE
reconnect with `Last-Event-ID`.

### Development environment

`docker-compose.dev.yml` adds Keycloak with an importable `slaude-dev` realm
containing one `operator` and one `superadmin` account. Local runs exercise the
real code path.

There is no authentication bypass flag anywhere in the codebase — none can be
left enabled in production.

## Rollout

PR #96 has not merged and no deployment runs header-trust auth, so this lands as
a follow-up commit series on `feat/session-control-panel` rather than as a
migration.

The panel section of `docs-new/deployment/multi-node.md` is rewritten: the
header-stripping requirement is removed, replaced by provider registration steps
for Google and Keycloak (redirect URI, scopes, client type) and the role file
format.

## Risks

| Risk | Mitigation |
|---|---|
| No revocation — a stolen refresh cookie is valid for up to 8 hours | Short access TTL (15 min); the refresh window is absolute, not sliding; role changes still take effect within one request. A Redis `jti` denylist is the additive follow-up if this proves insufficient. |
| `SLAUDE_PANEL_SECRET` disclosure allows minting any session, at any role | Required minimum length; never logged; rotating it invalidates every outstanding session, which is the intended break-glass. |
| Skipping ID-token signature verification | Sound only while the token is obtained solely from the code exchange over TLS. Documented in the code as a precondition; accepting a client-supplied bearer token would require JWKS verification. |
| Roles file edited to something malformed on a live fleet | Runtime parse failure keeps the last good config and records an error; only a boot-time failure is fatal. |
| Operators can no longer reach the panel without a provider | Accepted: the fallback was the impersonation footgun this design removes. Local development uses the Keycloak dev container. |
