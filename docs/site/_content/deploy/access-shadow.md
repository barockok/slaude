---
title: Reading the access shadow metrics
description: How to read the access shadow mismatch metric, which settings control it, and what "ready to flip" means before access decisions move to internal ids.
---

# Reading the access shadow metrics

From rc.19 every access decision (admission, manager and approver roles,
approval card clicks, one-on-one lock owner checks and the rest) goes through
one seam. The seam always returns the answer the string-based code gave before.
Beside it, it computes the answer based on internal user ids and compares the
two. This page tells you how to read that comparison and when the comparison
says it is safe to let the new answer decide. The design is in the
[domain access shadow field note](../field-notes/2026-11-14-domain-access-shadow.md).

Nothing about who is admitted changes while you read these numbers.

## The setting

`SLAUDE_ACCESS_SOURCE` (see the [configuration reference](../reference/configuration.md#domain-records)):

| Value | Behaviour |
|-------|-----------|
| `shadow` (default) | Return the legacy answer; compute and compare the internal-id answer. |
| `legacy` | Legacy only. No resolver call and no comparison. Use it to switch the comparison off. |
| `internal` | Reserved for the flip. In rc.19 it behaves as `shadow`. |

## The metrics

| Metric | Labels | Meaning |
|--------|--------|---------|
| `slaude_access_shadow_total` | `site`, `outcome` | One comparison. `outcome` is `match`, `mismatch`, `new_error`, `no_team` or `dropped`. |
| `slaude_access_decision_total` | `source`, `site`, `result` | One decision through the seam. `source` is the path whose answer was returned (`legacy` in rc.19). |
| `slaude_actor_resolve_total` | `result` | Acting-user lookups: `found`, `unseen`, `cached` or `error`. |
| `slaude_actor_resolve_failures_total` | none | Lookups that failed on a database error. |

`site` is a stable id such as `gateway.admit` or `gateway.connect_card.role`.
The full list is `src/access/sites.ts`.

### Mismatches

A `mismatch` means the internal-id answer differs from the legacy answer at
that site. Some differences are intended, because they are exactly what the new
path is for. The closed list of intended differences is: an email grant now
active, an email grant pending, a user reference now active, a workspace grant
now checking its team, a Slack entry now checking its team, and a grant reached
through another binding of the same person. In rc.19 none of these can be
created from a definition or the console, so on a deployment that has not hand
edited grants you expect no mismatches at all.

Each mismatch is also logged once per site, persona and reason per minute, as
`[access] shadow mismatch site=... persona=... reason=... user=...` with
internal ids only. Use the reason to tell an intended difference from a defect.

Example queries:

```promql
# Mismatches by site over the last day
sum by (site) (increase(slaude_access_shadow_total{outcome="mismatch"}[1d]))

# Share of comparisons where the new path errored
sum(increase(slaude_access_shadow_total{outcome="new_error"}[1d]))
  / sum(increase(slaude_access_shadow_total[1d]))

# Sites with no decision in the last 3 days
count by (site) (slaude_access_decision_total) unless
  count by (site) (increase(slaude_access_decision_total[3d]) > 0)
```

Other outcomes: `new_error` means the new path threw (the legacy answer was
still returned); `no_team` means the call carried no workspace, so no
comparison was made; `dropped` means the comparison was skipped to protect the
request. A high `unseen` share in `slaude_actor_resolve_total` means many
speakers have no record yet; the first message from a person is answered by the
legacy path, and the record is created as the gateway observes them.

## What "ready to flip" means

The flip is the later release that makes the internal-id answer the one
returned. Do not flip until all of these hold, after at least three days or 200
admission decisions per active agent:

1. Mismatches are zero, except those you can match to an intended difference.
2. `new_error` is below 0.1 percent of comparisons.
3. Every site id has a nonzero decision count, or a passing scripted smoke.
4. The workspace grant section of `slaude domain reconcile` is clean (zero
   rows, or each fixed or deleted).
5. The unproven email demotion has been applied
   (`slaude domain reconcile --demote-unproven-emails --apply`), and the
   report then shows none.
6. The link token ledger is live: redeeming the same link twice is refused.

### Checking every site

Production traffic may never reach rare sites. Run the scripted smoke, which
drives each site on a fake workspace and prints its decision count:

```sh
scripts/verify-access-sites.sh
```

Sites it reaches show a count. Sites it cannot reach are listed as "live only"
with the reason; for those, read `slaude_access_decision_total` on the
production `/metrics`. The script exits nonzero when a site neither counted nor
is listed.

## Rolling back

Set `SLAUDE_ACCESS_SOURCE=legacy` and restart to stop the comparison. It is
safe at any time, because the legacy answer is the one already in force. Going
back to rc.18 is safe while no email grants exist, and none can be created in
rc.19.

## Flipping to internal (rc.20) and back

Set `SLAUDE_ACCESS_SOURCE=internal` only after the gate above holds. The default
stays `shadow`. Email and user references (agent.yaml, stored grants, the console
form) are accepted only while the source is `internal`.

Failure behaviour under `internal`: when the user records cannot be read in time
(`SLAUDE_ACCESS_TIMEOUT_MS`, default 1500) ordinary access uses the legacy result
for that call and every privileged answer is refused. Watch
`slaude_access_decision_total{source="fallback_legacy"}` and
`slaude_actor_resolve_failures_total`.

**Before flipping back to `shadow` or `legacy`: delete the email and user grants
and agent.yaml references, or accept that email denies stop applying.** While
they exist and the source is not `internal` they are inactive, so a person who
was blocked only by an email entry is admitted again. The gateway logs this at
boot and `slaude domain reconcile` prints the count of stored grants with a typed
subject.

Limits to know: sites with no workspace on the call (heartbeat and digest
recipients, the background managers) use the soul's Slack ids, so a manager
named only by email gets no such DMs and `/soul` refuses them. On the default
persona, only managers can be named by email for approvals; scope-matched and
env-list approvers stay Slack ids.
