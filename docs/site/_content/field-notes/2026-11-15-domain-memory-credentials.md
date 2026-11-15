---
title: "Domain memory and credentials: a verified-only union computed at read time, and a credential pointer nothing reads"
date: 2026-11-15
---

# Domain memory and credentials: a verified-only union computed at read time, and a credential pointer nothing reads

**Date:** 2026-11-15

## Problem

A person with two Slack ids (two workspaces, or a work and a personal account)
has two private memory slices, `user-<id>`, and today each id reads only its own.
Slice F set out to let a person who has proven control of both ids read both,
and to record which user each MCP credential belongs to. The first draft of the
plan folded both into one design: a stored registry of slices per user and a
credential read that followed a new user pointer. An adversarial review broke
it in four places, and what is shipped is what survived.

## What the review found

1. **An observed binding must contribute nothing.** The merge engine refuses a
   loser that holds a verified binding, so a merged-away record's Slack binding
   is observed or declared, never verified. A union built from "every Slack
   binding of the survivor" would let the survivor read an id nobody had proven
   after a console merge. The merge notice is sent to a binding picked as the
   proof, else a verified one, else one the survivor already held, else the
   oldest seen, so the person who owns the observed id is not necessarily told.
   Identity checks already follow the symmetric rule (two bindings are one
   person only when both are verified); the slice rule is the same rule on both
   sides of the union.
2. **A best-effort projection must not override the authoritative link.**
   Credential lookups use `slack_identities` through `accountForSlackUser`. The
   binding projection is swallowed on failure and left for the reconciler, and
   the reconciler walked `slack_identities` toward bindings only: it never
   reported a verified Slack binding that has no `slack_identities` row. After an
   unlink whose projection failed, a user-based credential read would have kept
   serving the unlinked account's tokens. So the credential read flip was cut.
3. **Nothing would have maintained a stored registry** on link, unlink, account
   deletion or first sight, so an alias table goes stale in the unsafe
   direction.
4. **Undo does not cut derived copies.** The nightly pass writes its pages into
   the person's slice. Redirecting writes to a canonical slice, or grouping the
   passes by user, would copy one id's material into the other id's slice where
   undo cannot reach it.

## What ships in rc.22

Behaviour is identical to rc.21. Everything new is bookkeeping, a report, or a
flag that defaults off.

- **Migration 0052** (additive, nullable). `mcp_credentials.user_id` is a pointer
  from a person's credential row to the user its account maps to, with
  `ON DELETE SET NULL` and an index. On Postgres a CHECK refuses a pointer on an
  agent row (`user_id IS NULL OR account_id IS NOT NULL`); SQLite cannot add a
  CHECK without a rebuild, so the one module that writes the pointer
  (`src/db/credential-pointers.ts`) puts `account_id IS NOT NULL` in every
  statement, and a test covers both dialects. `slice_tombstones` is the operator
  revoke table, with no foreign key so it survives a merge deleting the user row.
  The numbering skipped 0042 to 0051 because other slices took those.
- **The pointer is never read for a decision.** Credentials keep resolving
  `slack_identities -> account -> mcp_credentials`. The pointer is written after
  a credential write and by a login or a link (best effort, never throws, never
  touches the payload bytes), repointed by a merge, and compared by the
  reconciler. A guard test (`tests/slices/credential-pointer-guard.test.ts`)
  fails when any source file other than the pointer module names the column next
  to the table, and when anything but four bookkeeping modules imports the
  module. If a later slice wants a read path it has to start by editing that
  test, and it must verify at read time (account, oidc binding, live user) and
  fall back per server, because rows from before this release hold NULL.
- **A merge repoints pointers before it deletes the loser row.** The delete fires
  `ON DELETE SET NULL`, so the step runs first, under its own savepoint: a
  failure rolls back that step only, is logged by error class, and the merge goes
  on (a link merge never fails because of a pointer). The ledger gains an
  optional `moved.credentials` (audit only). `SLAUDE_MERGE_POINTERS=off` skips
  it. Undo does not repoint; the reconciler repairs after an undo, and the undo
  limits text now says memory is read through verified bindings (so undo cuts
  that access at once) and credential records were never moved.
- **Operator tombstones.** `slaude domain slice-tombstone add <user-id>
  <source|*> --reason <text>`, `remove`, `list`. The source is a `user-` slice
  name or `*` (no union at all). A reason is required, the change is audited as
  the operator, and the output prints no Slack id (a name shows as its prefix,
  its length and a short hash to compare with what you typed). A read matches the
  live user id plus the `user_aliases.old_id` values that point at it, so a
  tombstone keyed on a merged-away id still applies to the survivor. The union
  that honours them ships in the next release; the table and CLI ship now so the
  revoke exists before the first union does.
- **The resolver and the shadow seam.** `personSlices` (`src/knowledge/person-slices.ts`)
  computes, for the acting Slack id, which `user-` slices that person could read
  under a union:
  - Rule P: only when the acting binding is verified, and it adds only the slices
    of the same user's other Slack bindings that are themselves verified.
  - Rule Q: a name any binding of a different live user (any state, any
    workspace) also produces is dropped.
  - Rule R: only `user-<alnum>` names, validated on the way out against the
    verified bindings, so `agent`, `shared`, `public`, `kb-` and `profile-` names
    cannot come out of this path.
  - Rule T: any error, the 250 ms bound or a tombstone read failure gives the
    legacy own slice and counts a failure, never a wider set.
  - Rule S: a lock is not a key. It is resolved for the speaker or the job
    token's `runAs` person only, never for the lock owner's id.
  Under `SLAUDE_PERSON_SLICES=shadow` the gateway runs it beside the legacy scope
  in the background (never awaited, at most 16 at once) and counts the outcome:
  `match`, `would_widen` (a verified second id exists, expected for a person who
  linked two ids), `would_narrow` (the own slice is missing from the union: a bug),
  `no_user`, `error`, `dropped`. A disagreement is logged once per site and
  reason per minute with counts only. With the flag unset or `off` nothing runs.
  The value `union` is reserved: it reads as `off` in this release.
- **The guard** (`tests/slices/no-string-slice.test.ts` and
  `tests/slices/string-slice.allow.json`) scans all of `src` for `userSourceId(`,
  `startsWith("user-")`, `slice("user-".length)`, and the credential-account
  lookups. Each hit must be a reviewed allowlist entry with a reason. The sites
  deliberately left on the old reading are the credential lookups (authoritative
  link), the write paths (writes stay on the writer's own slice), and the
  background passes (one nightly pass per Slack id).
- **The reconciler report** (every run, read only): verified Slack bindings with
  no `slack_identities` row and the reverse (the direction the old pass never
  checked), per team; credential rows whose pointer is empty or differs from the
  account's user; slice names two live users both produce, masked. `--apply`
  fills empty pointers only, with a compare on the old NULL. The reconciler's own
  projection passes `recordPointer: false` so the report is honest.

## Safety proofs

- With the flag unset, `off`, `shadow`, `union` or garbage, every scope decision
  equals rc.21's: `tests/slices/parity.test.ts` runs 3000 random scope inputs
  through the frozen rc.21 copies of `src/knowledge/scope.ts` and
  `src/memory/scope.ts` (byte-identical to the released files; a test keeps them
  identical to the source) and compares. Random credential pointers and flags
  never change what a credential or account read returns, and neither does a
  merge that repoints them.
- The shadow never throws into a caller: a resolver that throws, throws
  synchronously or hangs, and a metrics failure, are all tested.
- A node never touches the database: nothing under `src/node` or `src/agent`
  imports the resolver, the seam, the tombstone repo or the pointer module, and a
  node-role process calling the seam gets the legacy answer without opening a
  database.

## Known limits

- A merge of an observed record into a verified one does not unify memory. The
  observed id's slice is not readable by the survivor until that id is proven by
  a portal link of its own. That is the intended safe result.
- Slice names carry no workspace, so the same Slack id string in two workspaces
  already shares a slice today. This release reports it (names claimed by two
  users) and never widens it.
- The union is not cached (at most three indexed reads per call), so a read
  concurrent with an unlink can see the old set once.
- The reconciler's boot pass now runs three more read queries over `bindings`.

## Gate before the union is honoured (next release)

Three days with `SLAUDE_PERSON_SLICES=shadow` on the live deployment, or 200
turns per active agent: `would_narrow` zero; `error` below 0.1 percent; resolver
p95 under 10 ms and no timeout burst; every `would_widen` is a person who really
linked two ids (the owner reviews the masked count); the reconciler report's
verified-without-link and doubly-claimed sections reviewed, each item explained or
fixed; the guard test green.

## Live smoke (sam agent, real Slack, live model; any note written uses placeholders only)

1. DM: ask the agent to remember a fact, then recall it in a new DM thread. The
   page is in that person's own `user-` slice and nowhere else.
2. Trusted channel: save a note (the agent's own slice, as today) and recall it
   from another thread. A second person in the channel cannot see the first
   person's DM fact.
3. `/1on1`: write and recall in the lock. A bystander gets the public-only scope.
4. With `SLAUDE_PERSON_SLICES=shadow`: check `would_narrow` is zero and read the
   `slaude_person_slices_ms` histogram.
5. A credential-backed MCP call as the linked person through the bridge,
   unchanged by this release. If the freehire connector needs re-auth, use another
   configured server, or skip this step and say so in the release PR.
6. Simulated merge, only on a restored backup copy (documentation only, no script
   in this release): restore a backup into a scratch database and a scratch copy
   of the brain home, point `SLAUDE_DB` and `SLAUDE_BRAIN_HOME` at them, refuse to
   run when either path is the live one, merge two test users through the engine,
   recall from each id, undo, recall again. No merge is made on the live
   deployment.

Rollout per release candidate: back up before the version bump
(`sudo /usr/local/sbin/slaude-backup`), deploy, `verify` with 0 FAIL, run
`slaude domain reconcile` (report first, then `--apply` for the pointer fill), read
the shadow metrics, then the smoke above.

## Rollback

Set `SLAUDE_PERSON_SLICES=off` (or leave it unset): rc.21 reads at once. Redeploying
rc.21 is safe: the column and the table are additive and ignored. No page ever
moved, so nothing needs undoing in the brain.

## Decisions settled and left open

Writes always stay on the writer's own slice. An alias table is dropped and a
slice rename is deferred indefinitely (the spec's "alias table first" is
superseded by this note). A profile union, nightly grouping by user, console pages
and any credential read flip are deferred. Open for the owner: when to set
`SLAUDE_PERSON_SLICES=shadow` (recommended: on the rc.22 deploy day), whether
tombstones need a console control sooner than a later slice (recommended: CLI
first), when a credential read flip may be revisited (only after the
verified-without-link report has been clean for a stable release and per-server
fallback is built), and what to do with names claimed by two users (review each;
no code change here).
