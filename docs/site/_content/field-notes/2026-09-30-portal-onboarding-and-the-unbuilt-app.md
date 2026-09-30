# Portal onboarding, and the app that was never in the image

Phase 4 is the part a person actually touches: open the portal, authorize the
integrations you want, and your next 1:1 simply has them. Phases 2 and 3 had
already built the account and the credential store underneath. What was missing
was the page, the nudge that sends you to it — and, it turned out, a working
front end in the container.

## The spec's assumption about state was wrong

§7 of the control-plane design said the existing connect flow needed only "a
non-Slack surface and an identity resolution step". That is true of the OAuth
machinery and false of its **state**.

Both Slack-side connect modes keep the pending flow in one process:

- **paste-back** in a `Map` keyed by channel, thread and user, settled when the
  person pastes the callback URL back into the thread;
- **loopback** on a listener bound inside one pod, resolving an in-flight promise
  there.

With one gateway both work. With two, the callback can land on the replica that
did not start the flow — the browser redirect is routed by the ingress, and a
pasted URL arrives on whichever replica took that Slack event. The flow is then
unknown and the connect fails. The portal's whole shape is a browser redirect
coming back to "a gateway", so it could not inherit that.

## The cookie could not hold the flow

The obvious fix is the panel's: keep the login flow entirely in a signed cookie
and let any replica verify it. That does not work here, and the reason is worth
stating precisely.

Finishing an MCP connect needs the **client secret** dynamic registration issued.
A signed cookie's payload is base64 — signed, not encrypted — so it is readable
by whoever holds the cookie, which is the person's own browser and anything with
access to it. Phase 3 spent real effort keeping secrets off every machine but the
gateway. Shipping one to the browser to avoid creating a table would have undone
that quietly.

So the flow is split. A single-use row holds client id, client secret, PKCE
verifier, token endpoint, server config and the OAuth `state`, encrypted with the
same AES-256-GCM seam as the credential store and expiring in ten minutes. The
cookie holds that row's opaque id and nothing else — a test asserts the decoded
payload's exact key set, because "nothing else" is the property, not an
implementation detail.

`takeFlow` is a single `DELETE … RETURNING`, not a read then a delete. Single use
is what makes a replayed callback find nothing, so exactly one of several
concurrent callers must win it; and the account is in the `WHERE`, so one
person's callback can neither read nor consume another's flow. A state mismatch
consumes the flow too: that authorization is no longer trustworthy, and leaving
it retryable would be a gift.

## Two things the flow row had to carry to be correct

**The token endpoint, pinned at connect.** The same defect phase 3 fixed for
refresh: re-running discovery against the MCP server at the callback would let a
server that has since turned hostile name where the authorization code is sent.

**The whole server config, not just its URL.** `oauthKey` hashes type, url *and*
headers. A config rebuilt from the URL alone files the credential under a key no
session ever reads — a connect that reports success while nothing works. This was
caught by reading `oauthKey` rather than by a test, which is why there is now a
test that would have caught it.

## The panel UI had never worked in a container

Deciding the portal should be a React app like the panel raised an obvious
question: how does the panel's app get into the image? It does not.

`dist/` is gitignored, and neither the Dockerfile nor CI ever built it. The
gateway's static server falls back to the source directory when there is no
`dist/index.html`, so a deployed image served Vite's **source** shell — HTML
referencing `/src/main.tsx`, which a browser cannot run. The panel's UI has
therefore never worked in the container since it was written. Nothing observed it
because nothing in the unit suite runs from the image, and the Playwright suite
runs against a local Vite dev server.

Phase 4 adds a web build stage (the full dependency tree, since vite and
react-dom are dev dependencies and the existing deps stage is `--production`), a
CI step that typechecks and builds both apps, and an assertion in
`verify-ha.sh` that the served shells reference hashed assets rather than a
`.tsx` entry — the only place the defect is visible.

## What is deliberately left

**`/mcp connect` in Slack keeps its per-process flow.** Moving it to shared
storage is the same class of fix and worth doing, but it would mean touching the
paste-back and loopback paths that phases 0 and 3 just stabilised. The deploy
docs now say to prefer the portal on a multi-replica deployment.

**`token-exchange.ts` still echoes the provider's body into its error.** The
shared-loopback path, not the portal's; the portal's own exchange does not. Same
leak class as the one phase 3 closed, and a test currently asserts the current
behaviour.

**Where a person's credentials apply is unchanged.** A turn uses them only when
it runs as that person. Changing that would change the security model and needs
its own design; what phase 4 adds is that the page says so instead of letting
"connected" imply more than it means.

## A test bug worth naming

`tests/gateway/portal/link-command.test.ts` built Slack event ids as
`` `${Date.now()}.1` ``. Two of its tests run inside the same millisecond, so the
second message was dropped by the gateway's dedup and the assertion failed on a
missing ephemeral post — a failure that reads exactly like `/link` posting
nothing. It reproduced on `main`, predating this work. Event ids now carry a
sequence.
