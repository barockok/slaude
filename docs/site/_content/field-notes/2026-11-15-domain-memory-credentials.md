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

## What ships in rc.25 (part one: bookkeeping, shadow, report)

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
  The value `union` is honoured too (below).
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
  account's user; slice names two live users both produce, masked. `--fill-pointers`
  fills empty pointers only, with a compare on the old NULL. The reconciler's own
  projection passes `recordPointer: false` so the report is honest.

## What ships in rc.25 (part two): `SLAUDE_PERSON_SLICES=union`, reads only

Nothing is enabled by default: the flag stays `off`. Enabling is a configuration
change and is reversed by setting it back; there is no code change to make.

- **Where the union is honoured.** The gateway attaches the speaker's
  `person` (own slice first, then the verified extras) to the gate input
  (`brainGateFor`), and the job token's `runAs` person to the memory scope
  (`memoryScopeForClaims` and the mono memory provider). Three places read it, all
  for READS only: the KB scope's lock-owner branch (`src/knowledge/scope.ts`), and
  the memory scope's `runAs` and direct-message branches (`src/memory/scope.ts`).
  `gated-dispatch.ts` is unchanged apart from the field on `GateInput`: a write is
  classified against the writer's own slice and never looks at `person`. The write
  target (`sourceId`, the memory `write` scope) is the own slice in every case.
- **Defence in depth.** The scope sites re-check what they are handed
  (`extraPersonReads`): the union must be for that very own slice, and only
  `user-<alnum>` names pass, so a wrong or hostile `person` can add nothing but a
  person slice.
- **Rule S.** A thread locked by someone else still gets the public-only scope
  with no union, and the resolver is never called for the lock owner's id (a test
  spies on it).
- **Rule T.** Any resolver error, the 250 ms bound, a failing acting-user lookup,
  a synchronous throw or an unreadable tombstone table returns nothing, and the
  scope is the legacy own slice. `tests/slices/failure-modes.test.ts` runs each,
  at every site, and checks the write target.
- **The release gate: the cross-person leak property test**
  (`tests/slices/leak.test.ts`, both dialects). Random sequences of real
  operations against the real tables (observe, link, unlink, relink to another
  account of the same person, console merge, undo, tombstone add and remove,
  deleting an account, purging a user, a second Slack id for one person, the same
  Slack id string in two workspaces) with a ground truth of which human owns
  which id. After every step, for every Slack identity, it asserts the own slice
  is first; every other name is a plain `user-` name; an unverified acting binding
  reads only its own slice; every extra name is produced by a verified Slack
  binding of the same user as the (verified) acting binding and by the same
  human; no other live user holds a binding that produces the name; no tombstone
  covers it; a thread locked by another person gives exactly the public-only scope;
  and a write target is never a union member. A second set of tests proves the
  checker is not vacuous (a planted leak of an observed id, a non-person name and
  a tombstoned name each fail it). Seeds are fixed and the failing prefix of the
  sequence is printed; the seed count is `SLAUDE_LEAK_SEEDS` (default 400 on
  sqlite, 150 on Postgres; the gate run used 1500 and 600).
- **Scripted scenarios** (`tests/slices/union-scenarios.test.ts`) for each leak
  the review found: an observed id console-merged into a verified one is not
  readable by the survivor; the observed id proves itself and the union appears
  only then; unlink cuts access on the next read; unlink then relink to another
  account moves the id and gives the first person nothing; a merge of verified
  into verified is refused; undo of a proof merge cuts the survivor's access, the
  loser keeps its own slice and the replay is vetoed; the same id string held by
  two users is excluded; tombstones (a name, and `*`) are honoured. An end-to-end
  run with the fake brain writes as one id, links both, recalls as the other, then
  unlinks and no longer recalls, with writes only ever in the writer's own slice.
- **Parity.** With the flag unset, `off`, or `shadow`, every scope decision is the
  rc.21 one (frozen copies, 3000 random inputs). With `union`, over 5000 random
  worlds: a person with one verified id, or none verified, is byte-identical to
  rc.21; with a union only the verified extras are added, to reads only, and the
  per-agent, shared, public and kb sources never differ.

### Review fixes before the union ships

An independent adversarial review of the whole branch found no leak for a correctly
proven link, and these problems, all fixed:

- **A link changes meaning, retroactively.** The link token is a 15 minute bearer
  token redeemable in any portal session, so a link redeemed by the WRONG person
  would give the account's other verified ids the linked id's whole slice at once.
  Mitigation: a **hold** on the ADDED binding. An extra slice joins a union only when
  that binding's own `verified_at` is older than `SLAUDE_PERSON_SLICES_HOLD_HOURS`
  (default 24, `0` disables), read from the binding row (a binding with no
  `verified_at` is held). A new link under shadow or union writes an audit event
  (`slice.union_link`, account ids only). During the window the owner can notice, and
  the operator can unlink, undo a merge, or tombstone the name. The leak test has a
  wrong-human link (ground truth: the humans differ) and asserts the slice is
  unreadable during the hold and readable only after it, and that a tombstone then
  revokes it.
- **Unlink revocation was fail-open.** `projectUnlink` is swallowed on failure, so a
  verified binding could outlive its `slack_identities` row, and the resolver read
  bindings only. Rule P2: both the acting binding and each added one must have a row
  in the authoritative link table for an account of the same user. A test unlinks with
  a failing projection and the union is cut on the next read.
- **Tombstones were keyed on the reader's user record**, so relinking the ids to
  another account (a new user) ended the revoke. Added source-level rows
  (`slice-tombstone add --source user-x --all-readers`): no reader's union may include
  that slice. The leak test judges tombstones with an independent reading of the table.
- **Credential bookkeeping cost.** The dual write added three reads and an update to
  every person credential write, including token refresh. It is now behind
  `SLAUDE_CREDENTIAL_POINTERS` (default off), runs after the write has committed in the
  background and is never awaited; the in-transaction update on login and link uses a
  short lock timeout on Postgres. `reconcile --apply` alone writes nothing again; the
  explicit flag is `--fill-pointers` (with the credential flag on it also repairs drift).
  A merge undo restores the pointers from the ledger, guarded.
- **Costs.** The slice report is a CLI report (the boot reconcile skips it and prints
  a pointer); the per-row alias walk is gone. In union mode one resolver run is shared
  by the scope and the gate of one call (a 300 ms window, dropped on any link, unlink,
  merge, undo or tombstone change, failures never shared). The shadow's in-flight slot
  is held until its queries finish, so `MAX_INFLIGHT` bounds database load. The claim
  check compares exact stored values (no `LOWER()`), on the normalised slice name.
- **The runAs site** resolves in the lock's workspace when a lock exists (else the
  turn's), and the mono `memory_thread_history` path now passes the runAs person like
  the others. Rule S for runAs, exactly: `runAs` is the speaker (or there is no
  speaker) and, when a lock exists, the lock owner's; `memoryScopeFor` returns nothing
  for any other runAs, so a union is only ever read in those cases. The union is never
  resolved for the lock owner when the speaker is someone else.
- **Smaller:** the parity proof now runs the real gate construction end to end under
  every mode; `extraPersonReads` re-checks the flag; `memory_about` says in its
  description that it lists the asking id's own, the agent's and the shared stores
  (union members are reached by search and recall); masked source names show prefix and
  length only (no hash of an enumerable id); `--by` is self-asserted so the OS user is
  recorded too; `slice-tombstone remove` needs a `--reason`; the reconciler wording no
  longer says "nothing reads them" (the union ignores a verified binding that has no
  link, and says so).

### Enabling it

1. Deploy rc.25 with the flag unset. Behaviour is rc.21's.
2. Set `SLAUDE_PERSON_SLICES=shadow`. Read `slaude_person_slices_shadow_total`
   and `slaude_person_slices_ms` for at least three days, or 200 turns per active
   agent, against the gate below.
3. Decide `SLAUDE_PERSON_SLICES_HOLD_HOURS` (the default 24 is the recommendation: it is the window to catch a mistaken link) and review the masked `would_widen` count (each one should be a person who really
   linked two ids), the reconciler report, and record the owner decisions below.
4. Set `SLAUDE_PERSON_SLICES=union`. Roll back by setting it back to `shadow` or
   `off`; the next read is the legacy one. A turn that started before an unlink or
   an undo can finish one read with the old union (one gate construction).

### What is not proven

- The property test models people, ids and accounts; it cannot prove that a
  person's claim to a Slack id is true. A wrong link (a person proving control of
  an id that is not theirs) is the one way left to widen memory. The link token, the
  verified-only rule, the 24 hour hold, the audit event, tombstones (per reader and
  source-level) and undo are the mitigations; after the hold the slice IS readable
  until someone revokes it.
- Nothing here exercises a real brain, real Slack or a live model. The fake brain
  enforces `allowedSources` the way the real engine does, but that is a model.
- Resolver cost is measured only in shadow on a live deployment (the p95 gate).
  The property test says nothing about latency.
- The same Slack id string in two workspaces already shares one slice today; this
  work reports it and never widens it, but does not fix it.
- Tools that list or browse memory (`memory_about`, the memory browser) still
  read their old sets: an added slice is readable through search and recall, not
  yet through every listing.
- Nightly passes, proactive feedback and thread activity stay on the own slice
  by design (one pass per Slack id).

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
`slaude domain reconcile` (report first, then `--fill-pointers` for the pointer fill), read
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
`SLAUDE_PERSON_SLICES=shadow` (recommended: on the rc.25 deploy day), whether
tombstones need a console control sooner than a later slice (recommended: CLI
first), when a credential read flip may be revisited (only after the
verified-without-link report has been clean for a stable release and per-server
fallback is built), and what to do with names claimed by two users (review each;
no code change here).
