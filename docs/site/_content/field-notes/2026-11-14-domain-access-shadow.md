---
title: "Domain access, shadow: the new authority path runs beside the old one"
date: 2026-11-14
---

# Domain access, shadow: the new authority path runs beside the old one

**Date:** 2026-11-14

## Problem

Slice B stored users, bindings and boundaries. Access still compares Slack id
strings in many places: admission, roles, approver lists, lock owners, soul
field readers. To let a grant name an email or an internal user, those places
must ask "which user is this, and what do they hold" instead of "is this the
same string". Switching every site at once is not testable, so rc.19 builds the
new path, wires every site to it, and keeps the old answer in charge. Nothing
in this release changes who is admitted or who may approve. The plan is
`docs/plans/2026-11-14-domain-access-slice-c.md`.

Review of slice B found four defects that had to be fixed before any shadow
work, because the new path trusts what slice B recorded.

## Fixes that come first

### An email counts as verified only with proof

The sign-in code took whatever claim the identity setting named as the person's
identity, and rejected only an explicit `email_verified: false`, and only when
that claim was the email. A token with the flag absent passed, and the string
became a verified email binding. Now an email binding is `verified` only when
the token had `email_verified === true` and a real email claim. An account row
records this in `email_proven`. A login without proof, or an identity that is
not an email, projects an `observed` email binding that never moves a binding
away from another user, and a later login with proof raises it.

rc.18 has the exposure: its verified email bindings were never proven. It was
data only, because nothing reads email bindings for access yet. The reconciler
reports the count per issuer, never an address, and
`slaude domain reconcile --demote-unproven-emails` names the section on
purpose; it changes nothing without `--apply`, which sets those bindings back
to `observed`. The next login with proof raises them again. This is report, then
demote, and the gateway's boot reconcile never demotes.

### A link token is single use

The portal link token relied on the `slack_identities` primary key for single
use, but unlinking deletes that row, so the same token could relink within its
lifetime. Redeeming now inserts the token id (`jti`) into a ledger
(`link_token_uses`) inside the link transaction, insert-or-ignore, and a second
use gets the existing "link already used" refusal. Two concurrent redeems
produce one link. The reconciler purges expired ledger rows.

### Legacy readers ignore non-Slack subjects

`usersWithRole` and `approversFor` returned every user grant's subject, so an
email subject would come back as an approver id to message and to match clicks.
Worse, an approval allowlist holding only non-Slack approvers is empty, and an
empty default chain means anyone may click. The legacy readers now keep only
ids that look like Slack user ids, and grant creation refuses a non-Slack
subject ("not supported until the access flip"). Email and user references stay
refused at compile, as before.

## The acting user

`src/refs/actor.ts` resolves the acting user from (workspace, Slack user id):
the user holding that Slack binding, after alias resolution, with a short cache
for ordinary checks and a `fresh` option that bypasses it. The same id in two
workspaces is two users. An unseen id returns null; a database error throws.

Authority and identity of a speaker are different questions. Grants answer the
first. `sameUser(a, b)` answers the second, under Rule G: true for the same
Slack binding, or for two different Slack bindings of one user when both are
verified. An observed binding never joins a verified one, and two observed
bindings are the same person only if they are the same binding. This keeps an
unproven binding that landed on a record from becoming "the lock owner" or "the
initiator" of someone else.

## References and grants

Compile keeps each typed Slack reference as an `accessEntries` item (the
reference with its workspace, the field it came from, role, deny, dm-only and
channel scope) next to the legacy id arrays, which still hold the bare ids.
Stored grants gain `subject_ref` and `subject_user_id` for Slack subjects. A
grant's `subject_kind` and `subject_id` stay authoritative.

## The pure authority engine

`src/access/authority.ts` decides admit, role, approvers and deny from grants
and the acting user's bindings, with no I/O. Two tests pin it:

- A golden decision table lists identity, grant and context rows with the
  legacy answer, the new answer and, where they differ, a tag from a closed
  list of intended differences: `email-grant-now-active`,
  `email-grant-pending`, `user-ref-now-active`,
  `workspace-grant-team-checked`, `slack-entry-team-checked` and
  `grant-via-other-binding`. Any other difference fails the test, and a new
  difference needs a new tagged row.
- A parity property test builds random Slack-only worlds with one workspace
  (fixed seed, 5000 cases) and requires the new answer to equal the legacy one
  for admit, role and approvers, with no allowance list.

## The shadow seam

`src/access/decide.ts` is the single entry for a decision, taking a `site` id.
`SLAUDE_ACCESS_SOURCE` picks the mode, read on every call:

- `legacy`: the string path only, no resolver call.
- `shadow` (default): the legacy answer is always returned. The new path runs
  inside a try. A disagreement counts
  `slaude_access_shadow_total{site,outcome="mismatch"}` and is logged once per
  site, persona and reason per minute, with internal ids only. A new-path
  error counts `new_error` and never changes the answer.
- `internal`: reserved for the flip. In rc.19 it behaves as `shadow`.

An unknown value reads as `legacy`. Every returned answer also counts
`slaude_access_decision_total{source,site,result}`, and the resolver counts
`slaude_actor_resolve_total{result}` and `slaude_actor_resolve_failures_total`.

## Wired sites and the guard

79 decision sites go through the seam, in six groups: gateway admission and
roles, approval and permission cards, soul-field readers, knowledge and memory,
one-on-one, remote and environment owner compares, and background and display.
`src/access/sites.ts` lists every site id. Each group has a test that runs the
site under every source mode and with a broken resolver and a broken engine,
and asserts the answer stays the legacy one.

A full-tree guard, `tests/access/no-string-authority.test.ts`, scans all of
`src` (not a file list) for the string-compare patterns that make a Slack id
authority, and fails on any hit that is not a registered site or an entry in
`tests/access/string-authority.allow.json`. Each allowlist entry names the file,
the pattern and a reason (the legacy branch in the seam, a display, a storage
key, a restriction that fails toward blocking). A new hit needs a reviewed line.
The full-tree scan found sites the first map missed, and they are wired.

## Reconciler additions

The reconciler (see the [domain records](2026-11-14-domain-records.md) note)
gains these steps, all idempotent, dry-run aware and never writing a user for a
bot or a Slackbot id (a bot id is skipped as `bot`):

- grant subject refs: fills `subject_ref` and `subject_user_id` for Slack
  grants, under slice B's single-workspace rule, otherwise skipped and counted;
- lock teams: fills `one_on_one_locks.team_id` for old rows when the tenant has
  one workspace;
- workspace-grant mismatch report: lists every stored workspace-kind grant
  whose subject is not a team the tenant is connected to;
- the unproven email report and the optional demotion described above;
- expired link-token ledger rows purged.

## Team on one-on-one locks

A Slack id is unique only inside a workspace, and a lock row had no team. The
migration adds `one_on_one_locks.team_id`; a new lock stores it, and `roleOf`
and the proposal-card gate take the workspace. A lock with no team reads as the
tenant's single workspace, and as unknown otherwise, where the decision uses the
legacy result.

Migration `0040` is additive: `agent_grants.subject_ref` and `subject_user_id`,
`one_on_one_locks.team_id`, `accounts.email_proven` and the `link_token_uses`
table. An older binary can still insert.

## Proving every site is reached

`scripts/verify-access-sites.sh` drives each site through its real code path
under `shadow` (functions and a gateway on a fake Slack), prints each site with
its decision count, and lists sites no script reaches as "live only" with the
reason, so an operator reads those on the production metrics. It exits nonzero
when a site neither counted nor is listed.

## What has not changed

No live decision uses the new path. With the default `shadow`, every answer is
the legacy one, an email grant still does nothing, a workspace grant still
admits as before, and nothing reads an email or user reference for access.
The new work is observable only through the metrics and the reconciler report.

## Gates before rc.20 (the flip)

rc.20 may flip the default only when all of these hold, after at least three
days or 200 admission decisions per active agent:

- mismatches are zero except the intended tags;
- `new_error` is below 0.1 percent of shadow comparisons;
- every site id has a nonzero decision count or a passing scripted smoke;
- the guard test is green;
- the workspace-grant report is clean;
- the unproven email demotion has been applied;
- the link-token ledger is live.

The three review items must be shipped and verified: email proof, the rule that
the acting Slack binding itself must be verified before any privileged answer,
and the legacy reader fix for non-Slack grants. The operator steps are in
[Reading the access shadow metrics](../deploy/access-shadow.md).
