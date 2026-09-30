# Two connect defects that only one gateway could hide

Phase 4 routed the portal around a defect it did not fix: `/mcp connect` in
Slack keeps its pending flow in one process. Closing that turned up a second
defect sitting next to it, and fixing the first one first made the second
cheaper.

## A provider's error body was reaching Slack

`gateway.ts` posts `(e as Error).message` into the thread when a connect fails.
Both the token exchange and dynamic client registration built that message by
embedding the provider's JSON body:

```ts
throw new Error(`token exchange failed (status ${res.status}): ${JSON.stringify(body)}`);
```

An OAuth `error_description` is free text the provider chooses, and it can name a
credential. So this was not a log-only leak with a log-only audience — it was
channel-visible, to everyone in the thread.

What makes it interesting is *why* it survived phase 4. Phase 4 hardened the
exchange in `client.ts` and left `token-exchange.ts` alone, because the two were
separate copies of the same function with the same name. One path kept the rule,
the other never heard about it. Deleting the duplicate was most of the fix; both
connect paths now redeem a code through one implementation.

**A rule enforced in one of two copies is not enforced.**

## The pending flow could not survive the hop

Paste-back mode parks a flow and waits for the person to paste the callback URL
into the thread. That flow lived in a `Map` keyed by channel, thread and user,
and the `Map` belongs to one process. With two gateways the paste arrives at
whichever replica took that Slack event, and a replica that never ran the
connect finds nothing — the message falls through to the model as ordinary text.

It is now a row, encrypted the same way phase 4's portal flow is, keyed on the
same `channel:thread:user` binding the `Map` used. That binding is what makes a
bystander's paste land on a different key and find nothing, so it was worth
keeping exactly.

### peek and take are separate, and that is the point

The portal consumes its flow on a state mismatch: a browser redirect is one
shot, and a mismatched state means that authorization is no longer trustworthy.

Slack is not that. A person pastes into a thread and can paste the wrong thing,
and the message has always said so — *paste the URL from the same authorize step,
or rerun `/mcp connect`*. Reading the old code showed that advice had never been
true: the entry was deleted before the state was compared, so the retry it
invited could not work.

So the state check reads without consuming, and only the path that actually
exchanges takes the row — a single `DELETE … RETURNING`, so one of several
concurrent pastes wins and the rest say nothing.

## What this costs

Paste-back mode now requires `SLAUDE_MASTER_KEY`. The parked flow holds the
registered client secret and the PKCE verifier, so it is encrypted at rest, and
the key stops being a gateway-role requirement and becomes a requirement of this
mode. A `mono` deployment using paste-back without one would have been broken by
this change, so the connect refuses up front with a message naming the variable
rather than failing at the paste with nothing to explain it. Loopback mode is
untouched and needs no key.

## A test that proved nothing

The first version of the cross-replica test built two gateways over one database
and handed the paste to the second. It passed — and it passed just as happily
when the store was replaced with a module-level `Map`, because two gateways in
one process share module state. It could not tell durable storage from a
variable, which is the entire claim.

Asserting on the row instead fixed it: after the connect there is one row under
that key, and after the completion there is none. That mutation now fails, as it
should have from the start.

**Two objects in one process are not two replicas.** A test that can only be run
where the bug cannot occur is decoration.

## Still open

Loopback mode stays per-process, and cannot sensibly be otherwise: the browser
is sent to a listener bound inside one pod, so the flow has to finish where it
started. That is the local and same-host mode, where there is one process
anyway. Paste-back is the mode k8s deployments use, and it is the one that
needed this.

## A harness that reported the wrong thing

Verifying this on the cluster failed 5 of 12, then 9 of 12, then — after I
checked by hand — turned out to have been passing all along.

`probe()` threw away stderr and printed nothing when its `kubectl exec` failed,
and `field()` turned empty input into an empty string. So a failed exec reached
the assertion as a *value*, and came out as `only  of 6 completed on the
survivor`. The empty space where the number should be was the only clue. Every
turn had in fact completed; the probe simply could not be reached while the
apiserver was restarting.

Worse, every call into the cluster was unbounded, so an apiserver that stopped
answering mid-run hung the script instead of failing it — 34 minutes inside
`probe cron` with nothing printed.

Both are now fixed: calls are bounded by `PROBE_TIMEOUT`, a failed probe says why
on stderr and returns non-zero with no stdout, and `expect_value` reports
**COULD NOT MEASURE** separately from a wrong number. The run is 12 of 12.

**A test that cannot tell "I could not measure" from "I measured zero" will
eventually report the second when it means the first.** That is strictly worse
than no result: a red result gets debugged, and this one sent me looking for a
delivery bug that did not exist. It is the third misleading failure this
particular harness has produced, which is the actual signal — the earlier two
were a placeholder model string and a cleanup racing its own retries.
