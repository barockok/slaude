---
title: "Domain access, merging: records join on proof, are announced, and can be undone"
date: 2026-11-14
---

# Domain access, merging: records join on proof, are announced, and can be undone

**Date:** 2026-11-14

## Problem

After rc.20 a grant by email works only when one user record holds both the
verified email and the Slack account. Two records for one person (one made from
a Slack message, one from a sign-in) had no way to become one except the slice B
adopt rule, which handled only an unverified record and left every other case
as a log line. A wrong join is worse than a missing one, because it hands one
person the access of another. So merging needed three things together: an
engine that refuses what it cannot be sure of, a notice to the person, and an
undo that works from its own record rather than from the audit trail.

## The tables (migration 0041)

- `user_merges` is the merge ledger. One row per merge: kind (`proof` or
  `console`), survivor, loser, state (`applied` or `undone`), actor, the proof
  it rested on, `moved` (JSON), `undo_until`, undo fields and `notice_state`
  (`pending`, `sent`, `failed`, `skipped`). A partial unique index allows one
  `applied` row per loser.
- `merge_proposals` holds pairs a human decides: `user_a`, `user_b` (stored in
  id order), a reason (`conflict` or `two-emails`), a state (`open`,
  `dismissed`, `merged`) and evidence. A pair and reason is unique, so
  re-detecting the same conflict does not pile up rows.
- `merge_vetoes` holds the pairs an undo forbade, keyed on two hashed identity
  keys (sha256 of `slack:<team>/<id>`, `oidc:<issuer>#<subject>` or `email:<address>`),
  stored in sorted order and unique per pair. Keys are values, not binding ids,
  so a veto survives an unlink and a binding re-created with a new id, and the
  table holds no address and no Slack id.

`moved` stores ids and prior values, never a binding value: the loser's own row
data, each binding and grant with its `from` and `to`, the states the merge
itself raised (`raised`, with the old state and `verified_at`), aliases added and
repointed, the binding ids the proof rested on, and the two lists the notice and
console need (`activated`, `inactive_privileged`). The ledger is the undo
authority because audit retention can purge audit rows; the `user.merged` audit
event carries the same ids as the readable record.

## mergeUsers

`mergeUsers` runs in one transaction.

- **Idempotent through aliases.** Both ids resolve through `user_aliases`
  first. Two ids that name one live record are a no-op that returns the ledger
  row of the merge that joined them, so a replayed proof or a merge of A into B
  racing B into A gives one applied row.
- **Ordered locks.** Both user rows are locked in ascending id order (`FOR
  UPDATE` on Postgres; an immediate write transaction on sqlite, with a no-op
  write per row inside a caller's transaction). Then both ids are re-resolved and
  re-read, so a concurrent merge, link or unlink is seen, not overwritten.
- **Compare-and-set under a savepoint.** Bindings, stored grant subjects and
  aliases move with updates that name their expected owner. If the rows changed
  differ from the rows read, everything done is rolled back to the savepoint and
  the call reports `stale`. Nothing partial is ever written.
- **Refuse and propose.** For every kind, console included, the engine refuses
  and writes a proposal instead when: the loser holds any verified binding; either
  record is a bot or an agent; two different verified emails would land on one
  record; a veto names a pair with one key on each record; or, for a proof
  merge, `SLAUDE_AUTO_MERGE` is off.
- **Survivor rule.** The record holding the verified email wins. Otherwise the
  older record wins, ties broken by id.
- **raised, activated, inactive_privileged.** A merge never raises a binding
  state, except the proof path's own adopt, and that is written to `raised` so
  undo can reverse exactly it. The engine diffs the grants that reach the
  survivor before and after (stored grants by user id, soul entries by resolving
  references, under the same Rules A and B as access). `activated` lists grants
  that became active. `inactive_privileged` lists manager and approver grants
  that stay inactive because the Slack binding is not verified.

After the commit the engine emits the `user.merged` audit event, invalidates the
actor cache and queues the notice. With a caller's transaction the events are
returned for the caller to emit after its own commit.

## Proof paths go through the engine

Three callers reach the engine: the portal link (a delivered link proves the
Slack account), a login with a proven email (proves the email), and
`adoptBinding`, which keeps its signature and now calls `mergeUsers` with kind
`proof` for the unverified-holder case. Reconcile writes a proposal for a
conflict (the same email with a different verified Slack account in one
workspace, or two verified emails) instead of only reporting it. Linking a Slack
identity refuses a vetoed pair. Aliases such as `a+x@` against `a@` are never
merged and have no page.

`SLAUDE_AUTO_MERGE=off` turns every automatic merge into a proposal; nothing
moves. It is read on every call.

## The notice

After commit, `merge-notice` sends through the gateway's own outbound path, the
Slack app the workspace already has. A node never sends, and a process with no
gateway (the CLI) has no sender.

- One DM to the person: what was linked, how many grants became active, which
  privileged grants stay inactive and why (with a fresh portal link when the
  Slack binding is unverified), and who to tell.
- When a privileged grant activates, one DM to that persona's manager.
- Masking: an email appears only as `a***@example.com`, and no Slack id or value
  of the other record is repeated, because a wrong merge may have joined two
  different people.
- Single attempt. `notice_state` becomes `sent` or `failed`; `skipped` means
  `SLAUDE_MERGE_NOTICE` is off, the process is a node, or there was nobody to
  tell. A failure never reverts the merge and is never retried; the console shows
  it and the `user.merge_notice` audit event says which DM failed.

## Undo

Undo is allowed while the merge is `applied` and before `undo_until`, seven days
after the merge. It runs in one transaction from the ledger row.

What it restores: the loser record with its original id; each ledger binding and
grant, but only when its current owner still equals the ledger's `to`; the
aliases the merge repointed, and it drops the loser's own alias; and a binding
state, but only for entries in `raised`, only when the binding went back to the
loser and is still verified with the recorded `verified_at`. Undo never lowers
any other binding. Anything that changed since is left as it is and returned in
a `skipped` list with the reason. A dry-run preview returns the same lists.

What it does not do: credentials and memory slices never moved, so undo does not
touch them; items changed after the merge are not reverted; past the window undo
is refused; a merge that a later merge chained onto must be undone later-first;
a deleted account is not restored.

A proof merge that rested on a Slack link also removes the `slack_identities`
row the proof rested on (the link row only; the Slack binding goes back to the
loser and the account stays), so the person is no longer linked to the account.
It then inserts a veto on the pair the ledger recorded at merge time: the Slack
key (or, for a login merge, the raised email's key) with the account's sign-in
key. The engine and the link flow refuse the pair until an operator lifts it
from the Merges page (`POST /panel/api/merge-vetoes/:id/lift`, a reason is
required, audited). The pair comes from the ledger, so the veto holds even when
the person unlinked before the undo.

### Known gap: an unproven login can squat an address

A login whose token did not prove the email leaves an `observed` email binding
on the account's record. If the real owner of that address later proves it, the
engine sees a loser that holds a verified binding (the squatter's sign-in) and
refuses, and the console cannot resolve it because approving never merges a
record that holds a verified binding. Nothing resolves it automatically. The
proposal shows a hint, and the operator either dismisses it or demotes or deletes
the squatting account with the existing account flow (deleting it removes its sign-in binding) and then approves.

## What a merge claims about access

A merge links records. Authorization changes only while `SLAUDE_ACCESS_SOURCE`
is `internal`, so under `shadow` or `legacy` the ledger records `activated` as
empty (the would-be list is kept as `would_activate`), the person is told that
access is unchanged and no manager is told. Under `internal`, activation counts
only genuinely new reach (the reach of both records before the merge is
subtracted) and a privileged grant needs the acting Slack binding itself to be
verified (Rules A and D).

## Console and API

Two pages, Merges and Proposals, and these routes, all superadmin only (a
non-superadmin gets 403 and an audit row for the refusal):

- `GET /panel/api/merges`, `GET /panel/api/merges/:id`
- `POST /panel/api/merges/:id/undo-preview`, `POST /panel/api/merges/:id/undo`
  (a reason of at least three characters is required)
- `GET /panel/api/merge-proposals`
- `POST /panel/api/merge-proposals/:id/approve`, `POST .../:id/dismiss`
- `GET /panel/api/merge-vetoes`, `POST /panel/api/merge-vetoes/:id/lift`

Every POST carries the panel's anti-CSRF header check, as the grant POST does.
Mutations are audited as the operator. Answers never carry a full address or a
Slack id; masking happens in the read layer so a caller cannot forget it.

Approving a proposal runs the engine with kind `console` and keeps every refusal
above, including the verified-loser refusal: a verified-versus-verified conflict
is settled by unlinking or deleting the losing account first, then approving.
Approval uses a typed confirmation echo of the whole outcome. The first call runs
the merge inside a transaction it rolls back and answers with which record
survives and which is merged away (masked labels), how many bindings and stored
grants move, the grants it would activate and the privileged ones that stay
inactive. The merge happens only when that same object is sent back in `confirm`;
a different one (the world changed, or the direction flipped) is refused with the
current one, and an empty grant list is not a blind approval. Refusals,
mismatches and refused undo previews are audited.

## Metrics

`slaude_user_merges_total{kind,result}`, `slaude_user_merge_undo_total{result}`
and `slaude_merge_notice_total{result}`.
