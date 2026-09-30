# Phase 4 — portal onboarding

**Date:** 2026-09-30
**Elaborates:** §7 of `2026-09-17-control-plane-and-onboarding-design.md`
**Depends on:** phase 2 (accounts, signed links, `sayEphemeral`), phase 3 (the
gateway-owned credential store, `runAs`)

## 1. What this finishes

Setup leaves the conversation. A person opens the portal, sees the integrations
this deployment offers, authorizes the ones they want, and is done. Later, when
they open a 1:1 with any agent, those credentials are simply present.

Phases 2 and 3 built everything underneath: an account proven to own a Slack
identity, and a credential store keyed on that account which a node reads as
access tokens only. What is missing is the place a person actually goes, and the
nudge that sends them there.

## 2. The problem the original spec did not anticipate

§7 assumed the existing connect flow needed only "a non-Slack surface and an
identity resolution step". That is true of the OAuth machinery and false of its
**state**.

Both existing connect modes keep the pending flow in one process's memory:

- **Paste-back** holds it in a `Map` keyed by channel, thread and user
  (`pendingPaste`), settled when the person pastes the callback URL into the
  thread.
- **Loopback** blocks on a listener bound inside one pod and resolves the
  in-flight promise there.

With one gateway both work. With two, the callback can land on the replica that
did not start the flow: the browser redirect is routed by the ingress, and a
pasted URL arrives on whichever replica took that Slack event. The flow is then
unknown and the connect fails.

Phase 4 must not inherit that, because the portal's whole shape is a browser
redirect coming back to "a gateway".

## 3. Decisions

### 3.1 The portal carries its own flow state, in the browser

The portal runs its own OAuth round trip, and the provider redirects to
`/portal/oauth/callback` on the deployment's public URL, so whichever replica
receives the callback can finish it. What differs from the panel's login is
where the in-flight state lives.

The panel keeps its login flow entirely in a signed cookie. That cannot work
here: finishing an MCP connect needs the **client secret** issued by dynamic
registration, and a signed cookie's payload is base64, readable by the person in
their own browser. Phase 3 put real effort into keeping secrets off every
machine but the gateway; shipping one to the browser to save a table would undo
that.

So the flow is split:

- A **single-use row** holds what the exchange needs — client id, client secret,
  PKCE verifier, token endpoint, server name and URL, the OAuth `state`, and the
  account it belongs to. The payload is encrypted with the same AES-256-GCM seam
  as the credential store, expires after ten minutes, and is deleted the moment
  it is used.
- A **signed cookie** holds only that row's opaque id. It binds the flow to the
  browser that started it, so a leaked authorization URL cannot be completed
  from somewhere else, and it carries no secret.

The cookie is `HttpOnly`, `Secure`, `SameSite=Lax` and scoped to the callback
path. `SameSite=Lax` still sends it on the provider's top-level redirect, which
is the one request that needs it.

The row lives in the database rather than Redis so a single-process `mono`
deployment works unchanged, and `pending_gates` is not reused: it requires a
session id, which a portal flow has none of, and stores its payload in plain
text.

### 3.2 The Slack-side connect is left as it is

`/mcp connect` in Slack keeps its current behaviour and its current limitation.
Moving its pending state to shared storage is the same class of fix and worth
doing, but it is not what phase 4 is for, and doing it here would mean touching
the paste-back and loopback paths that phases 0 and 3 just stabilised. It is
recorded as follow-up work instead.

### 3.3 A person's integrations apply where the session runs as them

Phase 3's rule is unchanged: a turn uses a person's credentials only when it
runs as that person, which today means inside their 1:1 (and a cron job created
there). In a channel thread the session runs as the agent and uses the agent's
own identity.

That is not obvious from a page that says "connected", so the portal says it
plainly on the integrations page. Changing the rule would change the security
model and belongs to its own design, not to this one.

### 3.4 The portal is a React app, and the image must build it

The portal page is a React app under `src/gateway/portal/web`, built by Vite,
mirroring the panel's arrangement and served under `/portal` with the same
SPA fallback and traversal guard. The two static servers share one
implementation parameterised by root and prefix rather than being copied.

**This surfaces an existing defect.** Neither the Dockerfile nor CI builds the
panel's web app, and its `dist/` is gitignored, so the deployed image serves
Vite's *source* shell — HTML referencing `/src/main.tsx`, which a browser cannot
run. The panel's UI has therefore never worked in the container; nothing
exercised it there.

So phase 4 adds a frontend build stage to the image and a CI check that the
apps build. Both panel and portal are built and copied into the runtime image.
Fixing the panel is a side effect, and a welcome one.

## 4. Surface

```
GET    /portal                          the app shell (React, served statically)
GET    /portal/api/integrations         what this deployment offers + my status
POST   /portal/api/integrations/:name/connect    → { authorizeUrl }, sets the flow cookie
GET    /portal/oauth/callback?code&state         completes it, clears the cookie
DELETE /portal/api/integrations/:name            disconnect
```

`GET /portal/api/integrations` lists the operator-configured HTTP MCP servers —
the same source `/mcp` uses in Slack — and, for each, whether this account holds
a credential and when it expires. It never returns a token.

Mutating routes keep phase 2's anti-CSRF rule: a custom header no cross-origin
form or simple request can set, refused before any work happens.

The connect and disconnect handlers resolve the owner from the **portal session's
account**, never from anything the request names. `POST …/connect` refuses a
server this deployment does not configure.

## 5. Storage

One new table, `portal_oauth_flows`: id, account id, encrypted payload, expiry,
creation time. Single use — deleted on completion — and swept on expiry, so it
never accumulates. It holds an in-flight authorization for at most ten minutes
and nothing after that.

The credential itself is nothing new. A completed portal connect writes through phase 3's store with an
account owner, exactly as a 1:1 `/mcp connect` does, so a credential connected
in the portal and one connected in Slack are the same row. Disconnect deletes
that row, scoped to the caller's own account.

## 6. The 1:1 entry check

When someone opens a 1:1 and their Slack identity is not linked to an account,
the gateway posts the phase 2 onboarding link ephemerally — the same mint, the
same delivery, the same privacy. When they are linked, nothing is posted.

Onboarding unlocks connected tools; it never gates the agent. A person who
ignores the link still gets a working 1:1, just without their own integrations.

No nudge for a linked person with no integrations connected. That is a normal
state, not a problem to interrupt someone about.

## 7. Failure modes

**The flow cookie or its row is missing or expired at the callback.** Ten
minutes passed, the person started in another browser, or the row was already
used. The callback says so and offers to start again. Nothing is written, and a
replayed callback finds no row because the first use deleted it.

**The `state` does not match the cookie.** Refused outright, nothing written.
This is the forgery case, and it is why state lives in the signed cookie rather
than only in the URL.

**The account was deleted mid-flow.** The guard re-resolves the account per
request, as phase 2 does, so the callback refuses rather than writing a
credential nobody owns.

**The provider rejects the exchange.** Reported as a failure to connect, with
the provider's status but never its body, following phase 3's rule that an
error_description can name a token.

**Two tabs, two flows, same server.** Each has its own cookie, and the cookie is
overwritten by the second. The first callback then fails the state check and the
second succeeds. One credential, no partial state.

## 8. Acceptance criteria

1. A connect started on one gateway replica completes on the other.
2. A credential connected in the portal is the same stored row a 1:1 `/mcp
   connect` would have written, and is used by that person's next 1:1 turn.
3. Disconnecting removes only the caller's own credential.
4. The integrations list never contains a token, and neither does any error.
5. A callback with no cookie, an expired cookie or row, a mismatched state, or a
   replay of an already-used flow writes nothing.
10. No client secret, refresh token or verifier ever reaches the browser, in a
    cookie or anywhere else.
6. Connect and disconnect are refused without the anti-CSRF header.
7. Opening a 1:1 unlinked posts the onboarding link ephemerally; opening it
   linked posts nothing; neither blocks the turn.
8. The built portal and panel apps are present in the container image, and the
   portal's shell loads from it.
9. With `SLAUDE_PORTAL` unset, every portal route 404s exactly as before.
