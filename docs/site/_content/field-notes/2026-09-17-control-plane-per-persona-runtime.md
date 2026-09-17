---
title: "Per-persona runtime bundles, and two credential paths that disagreed"
date: 2026-09-17
---

Three related defects, found by reading the code rather than by an incident.
All three share a shape: a value that is threaded correctly through one path and
dropped on another, so the system is right in the configuration you test and
wrong in the configuration you deploy.

## The credential home two paths disagreed about

MCP OAuth credentials live under a config home. When a named persona owns the
session, the home nests under the persona, so isolation is per persona and per
user. Connect passed the persona. Disconnect did not.

For a named persona that meant disconnect resolved the flat user home, found
nothing there, and reported that the server was not connected — while a working
token stayed at the persona-nested path and was read again on the next session
boot. The person believed access was revoked. It was not. That is a false
revocation, and false revocation is worse than no revocation, because it stops
the person looking further.

The same missing argument had an opposite twin. In loopback mode the
token-persist call also dropped the persona, so the token was written where no
session ever reads it: connect reported success and the integration silently
never worked.

The two are mutually exclusive by deployment mode. Paste-back deployments got
the false revocation; loopback deployments got the dead token. A named-persona
deployment always had one of them, and neither branch had any test.

The fix is not "pass the argument in both places". It is to remove the ability
to disagree: one function resolves the home, both paths call it, and the
persona normalization that was copy-pasted at three call sites is now one
function too.

## The bundle that was resolved per tenant

Nodes fetch a runtime bundle from the gateway to boot a session. The query
selected one persona per tenant by name order, and the node cached the result
under the tenant alone.

With more than one persona in a tenant, every session on that node ran on
whichever persona sorted first. That is invisible in a single-persona
deployment, which is what every test and every local run is.

Two things were wrong and they are not equally serious, which took a mutation
test to establish.

The **gateway-side resolution** was the correctness defect. The route carried no
persona, so the bundle genuinely could not be the right one. Fixed by selecting
the requested persona and adding a route that names it, with the job token
checked against both dimensions rather than the tenant only.

The **node-side cache key** is an efficiency property, not a correctness one.
Every fetch sends an entity tag and revalidates, so even a colliding key returns
the correct bundle: the gateway resolves from the URL, not from the node's
cache. What a colliding key actually costs is thrash — alternating personas
evict each other, and every read pays a full body instead of a not-modified.

That distinction matters because the first draft of the acceptance test asserted
correctness and passed with the cache key deliberately broken. A test that
cannot fail is not evidence. Rewriting it to count revalidations made it fail on
the mutation, which is what earned it the right to stay.

## The announcement nobody made

Every node subscribed to a config-reload channel. Nothing in the source ever
published to it; only tests did. A subscriber with no publisher is a trap,
because it reads as a working mechanism.

Combined with a persona registry memoized at boot in both the gateway and every
node, adding an agent meant restarting all of them. There is now one
announcement point, and a superadmin-gated endpoint that calls it. A failed
publish is reported rather than thrown: the local invalidation has already
happened and revalidation still converges every node, so a broker blip must not
fail the config write that triggered it.

## Two things worth keeping

**Credentials cannot move into the database.** An earlier design proposed
fetching them from the gateway per turn. The agent's own child process owns the
credential file at runtime and rewrites it on token refresh, so a pulled copy
means refreshed tokens die with the pod, and any provider that rotates refresh
tokens on use invalidates whatever the database still holds. Database storage
only works if the gateway is the sole writer, and it is not. The shared volume
is the destination, not a stepping stone. That reframes the whole boundary:
state the agent writes stays on the volume, state it only reads is served by the
gateway.

**A literal NUL byte in a source file is nearly invisible.** Writing one in
place of an escape left the code compiling and the tests passing, while git
reclassified the file as binary and grep went silent on it. Silent grep is how
the broken mutation check went unnoticed in the first place. Worth a repository
scan rather than trust.
