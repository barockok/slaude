---
title: "Domain records: users, bindings and boundaries become rows"
date: 2026-11-14
---

# Domain records: users, bindings and boundaries become rows

**Date:** 2026-11-14

## Problem

Typed references (slice A) gave `agent.yaml` a grammar for naming people and
channels, but nothing stood behind it. A Slack id lived in `slack_identities`,
in grant subjects, in session rows and in audit actors, each spelled its own
way, and an email address in a definition had nothing to resolve to. Access,
sessions and audit cannot move to internal ids until there are records for them
to point at. Slice B stores the records and fills them. It changes no reader:
nothing reads a record for access yet (slice C does), so the risk sits in the
write paths and the backfill. The design is in
`docs/superpowers/specs/2026-11-12-domain-model-and-references.md`.

## What changed

### Four tables (migration 0038)

`users`, `bindings`, `boundaries` and `user_aliases`, on both dialects. A user
is a person, bot or agent with no identity of its own. A binding ties a user to
one identity on a service. A boundary is a place (a channel, a group, a dm).
`user_aliases` maps an old user id to the user it became.

- A binding is unique per `(service, kind, workspace, value)`. A Slack id is
  only unique inside a workspace, so the workspace is part of the key, and a
  CHECK refuses a Slack binding or boundary whose workspace is empty. A Slack
  record is never written without the workspace it was seen in.
- A binding is `declared` (named in a definition), `observed` (seen acting) or
  `verified` (proven by a portal link or a sign-in). State never downgrades:
  every write is insert-or-ignore on the unique key, then a re-read that only
  raises the state. Two writers racing on one key converge on one row.
- There is no `merged_into` column. `user_aliases` is the only record of a
  merge, so a merged user keeps no pointer that could disagree with it.
- The tables carry no tenant id (they are deployment-global like accounts), so
  they are listed in the no-tenant allowlist.

### The adopt rule

When a verified binding (a portal link or a sign-in) targets a value that a
different user already holds as `observed` or `declared`, the bindings move to
the account's user and the other user id goes to `user_aliases`. This is the
only merge in this slice, and it applies only to an unverified record: it is a
person proving they are someone the system had merely seen. Two verified
records for one value is a conflict, not a merge. It is reported and left for
the console work in slice C.

### The projection shares the accounts transaction

`accounts` and `slack_identities` stay the authority. Bindings are a projection
kept in step with them in the same transaction: link, unlink, login and
account deletion write the binding where they write the account. The
projection runs under a savepoint. If it fails it rolls back to the savepoint,
logs, and lets the account write commit, so a login never fails because a
record could not be written. The cost is that a projection can be missing, which
is what the reconciler repairs.

### A reconciler, not a migration step

Backfill is an idempotent reconciler (`slaude domain reconcile`), run at
gateway boot after Slack auth and by hand. Three facts about this codebase make
a migration step the wrong place:

- The migration runner executes SQL once, and the backfill needs code: email
  normalisation, per-tenant workspace resolution and conflict detection.
- The sqlite path returns early and does not run the Postgres migration
  routines, so a data step there would run on one dialect only.
- Deploys roll. An old replica keeps writing accounts and sessions without a
  projection for a while after the schema changes. A one-shot backfill misses
  those rows; a reconciler that runs on every boot picks them up.

It reads accounts and verified Slack identities first, then the Slack ids in
grants, sessions and audit actors that are not yet bound. A Postgres advisory
lock keeps two runners apart and every write is the same insert-or-ignore, so a
rerun changes nothing. The workspace comes from the tenant's installed Slack app
on Postgres and from the live auth (or `SLAUDE_SLACK_TEAM_ID`) on sqlite. A row
with no team id, a grant subject or an audit actor is attributed only when the
tenant has exactly one workspace. Otherwise it is skipped and counted. Two
accounts with one normalised email keep one binding and list the other as a
conflict. A run that wrote something writes one summary audit event, never one
per row, and a run that wrote nothing writes none.

### First sight

An observed record is created wherever a session or audit row is written, not
only when a message is admitted. The first design keyed observation on "the
first message from an unknown user", but sessions and audit rows are keyed on
the actor whether or not the message was admitted, and the later slices key on
refused actors as much as admitted ones. A refused user with no record would
leave an audit row that points at nothing.

The seams are the session writer, the audit writer and a pre-admission point in
the gateway, after the self-echo drops and before the blocked, not-granted and
ignore gates. That last one matters: a message refused at a gate never reaches
the session or audit writers, so without it the refused actor would be the one
case left unrecorded. Observation is fire and forget behind a per-process LRU,
so the hot path adds no query, a failed write is logged and never blocks a turn,
and the audit write it causes runs inside a guard so the audit seam never
observes its own output. Observed never overrides a stronger state and creates
no link to an account.

### Sync creates declared records

`applySync` ensures the records an `agent.yaml` references inside its own
transaction, as `declared`, and lists them in the sync report. A dry run
(`?dryRun=1`) reports `wouldCreate` and writes nothing. `?dryRun=1&strict=1`
(or `strict=1` on a real sync) refuses with a 422 that names the references
that would create a record, so a typo in a user id is caught before it becomes
an empty record. Strict is off by default, because nothing can verify a declared
email before slice C. A short Slack reference means the tenant's one workspace:
a tenant with several refuses it and asks for the workspace to be written, and a
tenant with no connected workspace warns and skips the Slack records rather
than refusing the sync, since a deployment that has not connected Slack yet
should still be able to sync. Sync never deletes a record. It is Postgres only,
so a sqlite deployment gets records from first sight and the reconciler.

### The console is read only

The console gains Users and Boundaries pages and their API, superadmin only.
They show the preferred binding, the state mix and an unmatched flag, and mask
every email and phone number, because a record page is a poor place to leak the
address the audit trail was built to keep out of rows. Conflict resolution and
undo wait for slice C.

## Why it matters

Slice C can move access onto internal ids because every Slack id that matters
already has a record, including the ones that were refused. The backfill is a
command an operator can rerun and compare against the source tables, so a wrong
count is visible rather than buried in a migration.

## Upgrade note

The first boot after the upgrade runs the reconciler. It is safe to run again
(`slaude domain reconcile --dry-run` shows what it would do). Nothing reads
records for access in this release.
