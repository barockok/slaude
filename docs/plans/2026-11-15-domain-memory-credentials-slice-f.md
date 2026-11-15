# Domain memory and credentials, slice F (minimal safe version)

> Release labelling (updated): slice F ships as ONE release, rc.25 (slice D is rc.23, slice E rc.24). The rc.22 and rc.23 headings below are the task order (bookkeeping, shadow and report first, the union second); both are in rc.25, with `SLAUDE_PERSON_SLICES` defaulting to `off`.

> For Claude: use superpowers:executing-plans, task by task. One task per commit. A release boundary is a hard stop: soak, check the gate, then continue.

Goal: let a person who has proven control of two Slack ids read the private memory slice of both, and record which user each MCP credential belongs to, without any new way for one person to read another person's slice or use another person's tokens. This replaces an earlier draft that an adversarial review broke (a registry that unioned unproven slices, a credential read flip driven by a best-effort projection, a registry nothing maintained). What survives is the smallest part that is safe: a read-time union of verified Slack bindings for memory reads, and a bookkeeping pointer on credentials.

Spec: `docs/superpowers/specs/2026-11-12-domain-model-and-references.md` (slice F; "Alias table first; revisit in slice F"). This plan settles it: no alias table and no rename; revisit only after a stable release (F8). Builds on slice C (`docs/plans/2026-11-14-domain-access-slice-c.md`, rc.21).

## What this slice does and does not do

- Does (rc.22): add `mcp_credentials.user_id` as bookkeeping (never a read path), dual write it, repoint it on merge, report drift; compute the user-based memory read set next to the legacy one and count disagreements (legacy authoritative).
- Does (rc.23): behind `SLAUDE_PERSON_SLICES=off|shadow|union` (default `off`), let `union` add the other verified Slack ids' `user-` slices to the speaker's memory READ set.
- Does not, deferred behind a later gate: any credential read flip, any slice registry, canonical (redirected) writes, profile unions, nightly grouping by user, console pages, a rehearsal script (documentation only). Nothing renames, moves or deletes a gbrain page; the brain schema is untouched; writes stay on the writer's own slice always.
- Consequence to state plainly: a merge of an observed record into a verified one does not unify memory. The observed id's slice is not readable by the survivor until that id itself is proven by a portal link. That is the intended safe result.

## Review findings, verified in code

1. Observed bindings must contribute nothing (critical). The engine refuses a loser that holds a verified binding (`src/domain/merge.ts:231`), so a loser's Slack binding is observed or declared, never verified. A union derived from "every Slack binding of the survivor" would make an unproven id's slice readable by the survivor after a console merge. The notice goes to a Slack binding picked as the proof, else a verified one, else one the survivor already held, else the oldest seen (`src/domain/merge-notice.ts:173-178`), so the person who owns the observed id is not necessarily told. Identity checks already follow the symmetric rule: two bindings are one person only when BOTH are verified (`src/refs/actor.ts:156-162`, Rule G of slice C). Rule P below applies the same rule to slices, on the reader side and the slice side.
2. A best-effort projection must not override the authoritative link. Credential lookups use `slack_identities` through `accountForSlackUser` (`src/gateway/core/mcp-bridge.ts:229`, `src/gateway/api/mcp-credentials.ts:39`, `src/agent/mcp-oauth/persist.ts:38`). The binding projection is swallowed on failure and left for the reconciler (`src/db/account-projection.ts:25-37`, `guardedProjection`), and the reconciler iterates `slack_identities` toward bindings only: it never reports a verified Slack binding that has no `slack_identities` row (`src/domain/reconcile.ts:336-380`). After an unlink whose projection failed, a user-based credential read would keep serving the unlinked account's tokens. So the credential read flip is cut. Credentials keep resolving `slack_identities` to account.
3. Nothing maintains a registry on link, unlink, account deletion or first sight, so a stored alias table goes stale in the unsafe direction. Dropped. The union is computed at read time from the acting user's current verified Slack bindings, so unlink, undo and merge change access by moving bindings, with no rows to maintain.
4. Undo does not cut derived copies. The nightly pass writes its pages into the person's slice (`src/background/pass-tools.ts:117-122`, `passWriteSource`). Redirecting writes to a canonical slice, or grouping passes by user, would copy one id's material into the other id's slice where undo cannot reach it. Cut: writes always go to the writer's own slice (F1), one nightly pass per Slack id stays (F7).
5. Operators need a revoke that outlives the 7-day undo window (`src/domain/merge-limits.ts`). Added as a tombstone table the read-time union honours (task 4).
6. Merge ordering. The loser's row is deleted at `src/domain/merge.ts:285` (`DELETE FROM users`), which fires `ON DELETE` actions; credential pointers are repointed before that statement (task 3).
7. Credential and slice-name sites that keep reading the old way, and why (all go on the guard allowlist, task 5): `src/gateway/core/gateway.ts:3187` and `src/gateway/portal/onboarding-nudge.ts:38` (`accountForSlackUser`, authoritative link); `src/gateway/core/credential-import.ts:118` (`accountIdsForSlackUserAnyTeam`, a bare Slack id across teams: left alone, never switched to users); `src/gateway/core/mcp-cred-epoch.ts:88` (`epochOwnersFor` lists the account's `slack_identities`; after a proof undo the link row is already deleted at `src/domain/merge-undo.ts:266`, so a bump misses that id; this fails closed and no new bump is added because no credential read changes); `src/brain-migrate/remap.ts:21` and `src/gateway/panel/api.ts:372` (classify names only; no new names exist); `src/knowledge/mcp-tools.ts:230` (compares `scope.sourceId` with `userSourceId(g.lockedUser)`; writes stay own, so it stays exactly as strict as today).
8. Runtime facts the design depends on. `brainGateFor` runs per tool call (`src/gateway/core/gateway.ts:1548-1550`), so the resolver is on a hot path and must be cheap, bounded and fail closed. `sameAt` is plain string equality unless `SLAUDE_ACCESS_SOURCE=internal` (`src/access/wired.ts:209`); the union therefore does not depend on `sameAt`: it is resolved only for the speaker's own id with `actingUser(..., {fresh: true})` and never for the lock owner's id. The brain receives `allowedSources` from the gateway and computes no scope (`src/knowledge/remote/brain-client.ts:114`, `src/knowledge/server/tools.ts:38`). The credential payload is AES-256-GCM without associated data (`src/db/crypto.ts`), so a pointer needs no re-encryption and keys are unaffected.
9. Where scope is computed (the only places reads change): `src/knowledge/scope.ts` (`baseScope` lock-owner branch, own slice at the `userSourceId(i.userId)` line), `src/memory/scope.ts` (`memoryScopeFor`: the `runAsUser` branch and the DM branch), fed by `GateInput` from `brainGateFor` and `memoryScopeForClaims` (`src/gateway/api/memory.ts:143`). `src/knowledge/gated-dispatch.ts` only classifies writes against a scope it is handed and does not change.

## Rules

- Rule P (a slice joins a union only when proven, on both sides). The union for an acting Slack id is built only when the acting binding is `verified`. It then adds the `user-` slice of each OTHER Slack binding of the same user whose own state is `verified`. An observed or declared binding, on either side, contributes and receives nothing: that id reads only its own legacy slice. (Verified Slack bindings arise only through the delivered portal link, or the proof merge's own raise; a merge never raises any other binding, so every member of a union was proven by its owner.)
- Rule Q (names claimed twice are excluded). A candidate name is dropped when any binding of a different live user, in any state and any workspace, produces the same `userSourceId`. Slice names carry no workspace (`src/knowledge/scope.ts`, `userSourceId`), so the same Slack id string in two workspaces already shares a slice today; this slice reports it (F4) and never widens it.
- Rule R (only person slices). Candidates are `user-*` names only (`^user-[a-z0-9]+$`). The result is validated before it is returned: every added name must be produced by a verified Slack binding of the acting user. `agent`, `agent-*`, `shared`, `public`, `kb-*`, `profile-*` and anything else never enter through this path.
- Rule S (a lock is not a key). A thread locked by someone else gets the public-only scope with no union. The union is never resolved for `lockedUser`, only for the speaker or the job token's `runAs` person, and only after the existing lock checks pass.
- Rule P2 (added after the review, rc.23). Both the acting binding and each added binding must also have a row in `slack_identities` for an account whose user is the same user, and the added binding must be older than `SLAUDE_PERSON_SLICES_HOLD_HOURS` (default 24) by its own `verified_at`.
- Rule S for `runAs` (clarified): `runAs` is the speaker or there is no speaker, and with a lock it is the lock owner's; `memoryScopeFor` returns nothing for any other `runAs`. The runAs person is resolved in the lock's workspace when a lock exists.
- Rule T (fail closed on read, never lose a write). Any resolver error, timeout (250 ms) or tombstone read failure returns the legacy own slice and counts a failure; never a wider set. Writes are not touched by this slice.
- Rule U (credentials). A credential read stays `slack_identities -> account -> mcp_credentials`. The `user_id` pointer is bookkeeping; if a later slice reads it, it must verify at read time (account -> oidc binding -> live user) and fall back per server, not per result, because rc.21-era rows have NULL pointers.

## Schema

Migration 0051 (renumber at build time: the latest on main is 0041 and slice D takes 0042 to 0050). `0051_domain_memory_credentials.sql`, both dialects, mirror in `src/db/drivers/sqlite.ts`, additive and nullable:
```
mcp_credentials  ADD user_id TEXT NULL REFERENCES users (id) ON DELETE SET NULL; INDEX (user_id)
                 -- Postgres only: CHECK (user_id IS NULL OR account_id IS NOT NULL). SQLite cannot add a CHECK
                 -- without a rebuild; repo functions enforce it there and a test covers both dialects.
slice_tombstones (user_id TEXT NOT NULL, source_id TEXT NOT NULL,   -- a user- name, or '*' for no union at all
                  created_by TEXT NOT NULL, reason TEXT NOT NULL, created_at BIGINT NOT NULL,
                  PRIMARY KEY (user_id, source_id))
```
`slice_tombstones` has no foreign key (it must survive a merge deleting the user row; a read matches the live id plus its `user_aliases.old_id` values) and joins `NO_TENANT_TABLES`. DDL tests on both dialects (the drift test sees columns only). The ledger `moved` JSON gains an optional `credentials: [{id, from, to}]`, audit only.

## Flags (all default off, nothing changes until set)

| Flag | Values | Default | Effect |
|---|---|---|---|
| `SLAUDE_PERSON_SLICES` | `off`, `shadow`, `union` | `off` | `off`: no resolver call. `shadow`: legacy scope returned; the union is computed and compared (rc.22). `union`: the union is returned for reads (rc.23). Read on every call; unknown reads as `off`. |
| `SLAUDE_MERGE_POINTERS` | `on`, `off` | `on` | A merge repoints credential pointers (inert, bookkeeping). `off` skips it; the reconciler repairs. |

## Resolver

`src/knowledge/person-slices.ts`:
```ts
interface PersonSlices { own: string; reads: string[]; via: "legacy" | "union"; dropped: { conflict: number; tombstoned: number } }
personSlices(teamId: string | null, slackUserId: string): Promise<PersonSlices>   // fresh, bounded, never throws
legacyPersonSlices(slackUserId: string): PersonSlices                             // pure: own only
```
Steps: `actingUser(team, id, {fresh: true})`; null or not verified: legacy. Else list the user's Slack bindings in state `verified` other than the acting one; map each to `userSourceId(value)`; drop the acting user's own name; apply Rule Q with one query on `bindings` (`service = 'slack'`, `LOWER(value)` in the candidate values, `user_id <> ?`); apply tombstones (`user_id IN (live id + old ids)`, a `*` row drops everything); Rule R validation; return own first. No cache: at most three indexed reads per call, measured in shadow (gate: p95 under 10 ms). Scope inputs get an optional `person?: PersonSlices`, so `resolveBrainScope`, `memoryScopeFor` and `classifyBrainOp` stay synchronous and free of database calls; absent means legacy. `gated-dispatch.ts` is not edited.

## Tasks

### rc.22: pointer, report, shadow (behaviour identical to rc.21)

1. Migration 0051 and DDL tests.
   - Files: `src/db/migrations/0051_domain_memory_credentials.sql`, `src/db/drivers/sqlite.ts`, `src/db/schema.ts` (`NO_TENANT_TABLES`), `tests/db/memory-credentials-schema.test.ts`.
   - Tests first: upgrade with existing credentials (pointer NULL, every old read unchanged); an older binary can still insert credentials; deleting a user nulls the pointer; the Postgres CHECK refuses a pointer on an agent row and the repo refuses it on SQLite; tombstone key uniqueness; `SLAUDE_DB=pg`.
2. Credentials dual write (bookkeeping only).
   - Files: `src/db/mcp-credentials.ts` (`putCredential`, `putCredentialIfNewer`, `putCredentialIfAbsent` set `user_id` from account -> oidc binding -> alias-resolved user when it resolves, else leave NULL, and never throw because of it; agent rows never get one), `src/db/account-projection.ts` (after a login or link creates or moves an account's user, a guarded `UPDATE` of that account's rows), tests.
   - Tests first: pointer stored; resolver failure still stores the credential; payload bytes identical to before; no read path in `src/` selects by `user_id` for a decision (a grep test, allowlist empty).
3. Merge repoints pointers before the loser row is deleted.
   - Files: `src/domain/merge.ts` (a guarded step that runs before the `DELETE FROM users` at line 285: `UPDATE mcp_credentials SET user_id = survivor WHERE user_id = loser`, rows counted, recorded as `moved.credentials`; a failure inside the step is caught, logged by class and the merge continues, so a link merge never fails because of pointers; skipped when `SLAUDE_MERGE_POINTERS=off`), `src/domain/merge-undo.ts` (no change: the reconciler repairs pointers after an undo; stated in the limits text), `src/domain/merge-limits.ts` (add: "Memory slices are read through verified Slack bindings, so undo cuts that access at once; memory pages are never moved. Credential records were never moved."), `tests/domain/merge-pointers.test.ts`.
   - Tests first: pointers follow the survivor; the order (pointer repointed while the loser row still exists, no `SET NULL` side effect); injected failure leaves the merge applied with pointers for the reconciler; merge and undo leave credential rows, payloads and `slack_identities` untouched.
4. Operator tombstones (CLI only, console deferred).
   - Files: `src/db/slice-tombstones.ts`, `src/cli/` command `slaude domain slice-tombstone add|list|remove` (user id, source name or `*`, reason required, audited as operator, output shows no Slack id), tests.
   - Tests first: add, list, remove; reason required; `*` accepted; the audit row exists; a tombstone keyed on a merged-away user id still matches through `user_aliases`.
5. Person slices resolver, shadow seam, metrics, guard.
   - Files: `src/knowledge/person-slices.ts`, `src/slices/decide.ts` (`decidePersonSlices({site, ...})`), `src/config/env.ts` (the two flags), `src/metrics.ts` (`slaude_person_slices_shadow_total{site,outcome}`, `slaude_person_slices_failures_total`, `slaude_person_slices_ms`), `src/slices/sites.ts`, `tests/knowledge/person-slices.test.ts`, `tests/slices/no-string-slice.test.ts` with `tests/slices/string-slice.allow.json`.
   - Wiring: `brainGateFor` and `memoryScopeForClaims` call `decidePersonSlices` once per gate construction and attach `person`; `baseScope`'s lock-owner branch and `memoryScopeFor`'s `runAsUser` and DM branches read `person.reads` for `allowedSources` and still write to `person.own`. In `shadow` the legacy scope is returned. Outcomes: `match`, `would_widen` (a verified second id exists; expected, tagged `verified-second-id`), `would_narrow` (own slice missing: a bug), `no_user`, `error`. Mismatches are logged once per (site, reason) per minute with counts only (no Slack id, no name).
   - Tests first (each row is a rule): unknown id and observed acting id give legacy; verified acting id with an observed second id gives own only (the review's console-merge case); verified with verified gives own plus the other; two users producing one name drop it for both; a tombstone drops one name, `*` drops all; resolver throws or exceeds 250 ms gives legacy and counts a failure; the output never contains a non-`user-` name; a lock owned by another person gives public-only for a merged speaker; with `off` and `shadow` every existing test in `tests/brain-scope.test.ts`, `tests/memory/*`, `tests/knowledge/*` passes unchanged.
   - Guard: the full-tree scan (as slice C task 18) over `src` for `userSourceId(`, `startsWith("user-")`, `slice("user-".length)`, `accountForSlackUser(`, `accountIdsForSlackUserAnyTeam(`, `epochOwnersFor(`; any hit outside the allowlist fails, and each allowlist entry carries a reason (the sites in finding 7, and `src/background/*`, `src/proactive/*`, `src/db/thread-activity.ts` as "own slice by design, not unioned").
6. Reconciler report (read only except pointer fill).
   - Files: `src/domain/reconcile.ts` (new report sections, `--apply` fills NULL pointers only), `tests/domain/reconcile.test.ts`.
   - Report: (a) every verified Slack binding with no `slack_identities` row, and every `slack_identities` row with no verified binding (the direction the current reconciler never checks), counted per team, no ids printed; (b) credential rows whose pointer is NULL or differs from the account's current user; (c) source names claimed by two live users (Rule Q), masked. Never alters bindings, links or credentials; the fill sets `user_id` with a compare on the old value.
   - Tests first: each case above; dry run writes nothing; idempotent.
7. rc.22 release.
   - Files: `docs/site/_content/releases/v0.46.0.md` (stable name), field note `domain-memory-credentials-shadow`, CLAUDE.md index line, spec amendment (alias table dropped, rename deferred).
   - Gate before rc.23 (3 days with `SLAUDE_PERSON_SLICES=shadow` on the live deployment, or 200 turns per active agent): `would_narrow` zero; `error` below 0.1 percent; p95 resolver time under 10 ms and no timeout burst; every `would_widen` is a person who really linked two ids (the owner reviews the masked count); reconciler report (a) and (c) reviewed and each item explained or fixed; guard test green.

### rc.23: verified-only union for memory reads, behind a flag

8. Honour `union` in the three scope sites, plus the leak property test as the release gate.
   - Files: `src/config/env.ts` (the `union` value is accepted; the default stays `off`), `src/knowledge/scope.ts`, `src/memory/scope.ts`, `tests/slices/leak.test.ts` (sqlite and `SLAUDE_DB=pg`), `tests/memory/person-union.test.ts` (fake brain).
   - Leak property test (the gate): random sequences over four to six people, two workspaces, one to three Slack ids each, with operations link, unlink, relink, observe, merge (proof and console), undo, delete account, tombstone add and remove. After EVERY step, for every acting identity, assert: the read set contains its own legacy slice; every other name is a `user-` name produced by a verified binding that the acting user holds now; an observed acting identity has no other name; no name is claimed by another live user; no `agent`, `shared`, `public`, `kb-`, `profile-` name was added; a thread locked by another person yields exactly the public-only scope; a tombstone removes the name on the next read. Fixed seed, 3000 sequences, shrunk failing sequence printed on failure.
   - Scripted sequences: console merge of an observed record into a verified one (no union); proof merge raising one id (union only for verified ids); unlink then read (access gone); undo then read (survivor loses the other id's slice, loser keeps its own); link replay after undo (vetoed, no union); same Slack id string in two workspaces (excluded); a merge of verified user A into B refused (proposal), so no union appears.
   - End to end with the fake brain: write as id L, link both ids to one account, recall as id S finds it; unlink S or undo, recall as S does not; write as S is only ever in S's own slice.
   - Fault injection: resolver throws, resolver slow, tombstone table unreadable: own slice only, write still lands in the writer's own slice.
9. Failure modes and flag-off parity.
   - Files: `tests/slices/failure-modes.test.ts`, `tests/slices/parity.test.ts`.
   - Tests first: with `off` and with `union` for a person who has one verified id, every scope field is byte-identical to rc.21 (5000 random worlds, fixed seed); per-agent, shared and public sources never differ; the node role guard (nothing under `src/node` or `src/agent` imports `src/knowledge/person-slices`, `src/slices/*` or `src/db/slice-tombstones`).
10. rc.23 release.
    - Files: release notes, field note `domain-memory-credentials`, CLAUDE.md line, console undo-limit text from task 3.
    - Gate to enable on the live deployment: the property test green in CI on both dialects for a full week of commits; shadow clean for 3 more days; the owner has recorded the decisions below. Enabling is a configuration change (`SLAUDE_PERSON_SLICES=union`), not a code change, and is reversed by setting it back.

## Node role, failure modes, rollback

- Nodes never read the database. Credentials come from the gateway route unchanged; memory scope and KB scope are computed on the gateway and passed to the brain as `allowedSources`. Task 9 adds an import guard.
- Resolver or tombstone read failure: reads narrow to the legacy own slice (never wider). Writes are untouched and cannot be lost or leaked by this slice. Brain down: the existing failure paths apply; the resolver adds no brain call.
- A turn that started before an unlink or undo can finish one read with the old union; the window is one gate construction and is stated in the release note.
- Rollback: `SLAUDE_PERSON_SLICES=off` restores rc.21 reads at once. Redeploying rc.21 or rc.22 is safe: the column and table are additive and ignored. No page ever moved, so nothing needs undoing in the brain.

## Rollout

Per RC: backup before the version bump (`sudo /usr/local/sbin/slaude-backup`), deploy through vps-hardening, `verify` 0 FAIL, run `slaude domain reconcile` (report first, then `--apply` for the pointer fill), read the shadow metrics, then the live smoke.

| RC | Changes | Behaviour change | Rollback |
|---|---|---|---|
| rc.22 | 0051, pointer dual write, merge repoint, tombstone CLI, resolver and shadow, reconciler report, guard | none (flag default `off`; `shadow` is opt-in and returns legacy) | set the flag `off`, or redeploy rc.21 |
| rc.23 | `union` honoured, leak property test | none until the flag is set to `union`; then a person with two verified ids reads both slices | flag `off` |

Live smoke (sam agent, real Slack, live model; any note written uses placeholders only):
1. DM: ask the agent to remember a fact, then recall it in a new DM thread; the page is in that person's own `user-` slice and nowhere else.
2. Trusted channel: save a note (the agent's own slice, as today) and recall it from another thread; a second person in the channel cannot see the first person's DM fact.
3. `/1on1`: write and recall in the lock; a bystander gets the public-only scope.
4. With `SLAUDE_PERSON_SLICES=shadow`: check `would_narrow` is zero and the resolver time metric.
5. A credential-backed MCP call as the linked person through the bridge, unchanged by this slice. If the freehire connector needs re-auth, use another configured server, or skip this step and say so in the release PR.
6. Simulated merge: only on a restored backup copy (documentation item in the release-prep skill, no script in this slice): restore a backup into a scratch database and a scratch copy of the brain home, point `SLAUDE_DB` and `SLAUDE_BRAIN_HOME` at them, refuse to run when either path is the live one, merge two test users through the engine, recall from each id, undo, recall again. No merge is made on the live deployment.

## Decisions (recommended default first; F2, F6 to F10 follow the review)

- F1 Writes: always the writer's own slice; no canonical write flag. Settled.
- F2 Hold after a merge: dropped. Justification: a slice joins a union only through a Slack binding that is itself `verified`, which only the delivered portal link (or the proof merge's own raise) produces, so each member was proven by the person who controls that id; a hold would not protect an unproven binding (the case that needs protecting is excluded by Rule P) and would need a clock on a merge ledger field. If the owner wants a delay anyway: 24 hours measured from the binding's `verified_at`, recorded in the ledger's `raised`; not planned.
- F3 Credentials: a `user_id` pointer, bookkeeping only, never a read path; no read flip in this slice. Settled.
- F4 A name claimed by two live users: report and exclude (Rule Q). A rename to add a workspace is a later slice.
- F5 Observed or declared bindings: no union on either side. Settled.
- F6 Profile union: deferred (profiles are read in public channels, `resolveBrainScope`); profile writes unchanged.
- F7 Nightly review: one pass per Slack id, unchanged.
- F8 Alias table: dropped; rename deferred indefinitely.
- F9 Revoke after the undo window: operator tombstones (CLI now; console control deferred).
- F10 Console shows slice kind only, never a name or a Slack id; no console page in this slice.

Remaining owner decisions:
- D-a When to set `SLAUDE_PERSON_SLICES=shadow` on the live deployment (recommended: on rc.22 deploy day) and `union` (recommended: only after the rc.23 gate and one review of the masked `would_widen` count).
- D-b Whether the optional 24 hour delay on the binding's `verified_at` is wanted anyway (recommended: no).
- D-c Whether tombstones need a console control sooner than a later slice (recommended: CLI first).
- D-d When a later slice may revisit a credential read flip (recommended: only after the reconciler's verified-binding-without-link report has been clean for a stable release, and per server fallback is built).
- D-e What to do with the names the report lists as claimed by two users (recommended: review each; no code change in F).

## Risks

- A wrong link, not a wrong merge, is now the only way to widen memory: a person proves control of a Slack id that is not theirs. Mitigations: the link is a delivered signed single-use token, the verified-only rule, the leak test, `off`, tombstones, undo vetoes a replay.
- A site that should be unioned stays on the legacy own slice (a person misses a note, no leak). Accepted for F; the guard lists each one with its reason.
- Hot-path cost: up to three indexed reads per gate construction. Bounded at 250 ms with a legacy fallback; the shadow gate measures it.
- The union is not cached, so a read concurrent with an unlink can see the old set once; stated above.
- Same Slack id string across workspaces already shares a slice; this slice reports it and never widens it.
- The SQLite mirror cannot carry the Postgres CHECK on `mcp_credentials`; repo enforcement and a test on both dialects cover it.
