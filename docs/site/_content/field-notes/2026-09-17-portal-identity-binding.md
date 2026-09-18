# Portal identity: binding a person to a Slack user, provably

**Date:** 2026-09-17

Phase 2 of the control-plane work gives slaude a notion of a *person* that is
independent of Slack: an account, authenticated by the same identity provider
the operator panel already uses, with zero or more Slack identities bound to it.
The binding is what phases 3 and 4 need — per-user MCP credentials and a 1:1
that runs as the person rather than as the agent both start from "which account
is this Slack user?".

The whole design turns on one question: how does the gateway know that the
person signing in at the portal is the same person behind a Slack user id?

## A binding must be proven, not asserted

The obvious shape is to let the signed-in user type their Slack user id, or to
match on email address. Both are assertions.

Typing an id proves nothing at all: anyone can read a colleague's user id out of
a profile link and claim it. Matching on email is worse than it looks, because
it silently delegates the binding to whatever the workspace admin typed into a
Slack profile field, and to whether the identity provider's `email` claim is
verified. Neither is under slaude's control, and a wrong binding is not a
cosmetic error — it means one person's messages run with another person's
credentials.

So the binding is proven by *delivery*. The agent sends an onboarding link to
one Slack user, ephemerally. Only the person holding that Slack session sees it.
Redeeming it while signed in to the portal joins the two identities, and the
join is sound because each half was demonstrated rather than claimed: the
provider authenticated the account, and Slack delivered the link.

That is why `sayEphemeral` refuses rather than degrading. A surface that cannot
post privately gets an explicit refusal; a silent fallback to a channel post
would put the proof in front of everyone in the room and turn the binding back
into an assertion.

## What the token carries, and why

The link is a short-lived signed token holding the team id, the Slack user id, a
type claim and a jti. Fifteen minutes, HS256 over the panel's existing signing
secret.

**The Slack user id comes from the token, never from the request body.** The
redeem handler reads it out of the verified claims and ignores anything the
browser sends. That is the single property the rest of the design rests on: the
holder of a link cannot change whose identity it binds.

**The team id is in the token too**, and is used verbatim when writing the
binding row. Without it, a link minted in one workspace could bind a colliding
user id in another — Slack ids are unique per workspace, not globally.

**The type claim separates it from every other token signed with the same
secret.** Panel sessions, portal sessions and onboarding links all come out of
one secret, so the type is checked before the field shape is. Getting that order
wrong is not a vulnerability, but it does make a mis-presented token report
"malformed" when the real answer is "that is a token of another kind" — and a
confusing diagnostic is how a real bug hides.

**Single use falls out of the data model, not a ledger.** The binding table's
primary key is (team id, Slack user id), and the insert refuses to rebind an
existing row to a different account. A replayed link therefore cannot take over
a Slack identity that is already connected; it can only re-assert the binding
that already exists. No redemption ledger, no cleanup job, no window where a
revoked token still works because the ledger write lost a race.

## Redeeming is a POST behind a custom header

The portal authenticates with a cookie, and the browser attaches that cookie to
any request to the origin, including one a cross-site page forges. So the cookie
alone cannot prove same-origin intent.

The concrete attack, if redeeming were a GET: an attacker mints a link for their
*own* Slack user, then gets a signed-in victim to load it — an image tag in an
email is enough. The victim's browser redeems it, and the attacker's Slack
identity is now bound to the victim's account. Every message the attacker sends
in Slack then runs on the victim's connected integrations. The direction is the
surprising part; the victim is the one whose browser did the work.

Redeeming is therefore a POST carrying a custom header. An HTML form cannot set
one, a CORS "simple request" cannot set one, and a cross-origin `fetch` that
sets it is forced into a preflight this surface never answers with an
allow-origin. `GET /portal/link` renders a confirmation page and binds nothing.

## No role check, on purpose

The panel refuses an identity that appears in no operator role list. The portal
does the opposite: any identity the provider authenticates gets an account.

That is intended, and it is safe because an account grants nothing on its own.
It is an empty container until a Slack identity is bound to it, and binding
needs a link only that Slack user can see. Onboarding unlocks connected tools;
it never gates the agent. Gating sign-in would mean an operator maintaining an
allowlist of everyone who might ever talk to an agent, which is the onboarding
friction this phase exists to remove.

The account is re-resolved from the database on every request rather than
trusted from the token's claims, the same way the panel re-resolves roles per
request. A deleted account stops working at the next request instead of at the
next refresh.

## Two surfaces, one secret

Portal and panel share an issuer, a client, a public URL and a signing secret.
What separates an end-user session from an operator session is the token type
plus the cookie path — `portal_at` on `/portal` against the panel's own cookie
on its own path. A portal cookie can never be presented as an operator
credential because the type check rejects it before anything looks at roles.

The one thing an operator must not miss when enabling it: the identity provider
client needs `<public url>/portal/auth/callback` registered as a *second*
redirect URI. Without it, every portal login fails at the provider, and slaude
never sees the request, so there is nothing in its logs to explain the failure.
