# Domain memory and credentials, slice F: slices and MCP credentials follow the user

> For Claude: use superpowers:executing-plans, task by task. One task per commit. A release boundary is a hard stop: soak, check the gate, then continue.

Goal: a merged person keeps reading what both of their records wrote (memory slices) and keeps using the integrations they connected (MCP credentials), a wrong merge cannot hand one person another person's slice or tokens, and an undo cuts that access again at once. Delivered as three release candidates (rc.22 to rc.24) so that the release that first runs the new code never also changes what a turn can read. Nothing in this slice renames, moves or deletes a gbrain page, and the brain schema is untouched.

Architecture: three additive pieces and one seam. (1) `mcp_credentials.user_id`, a nullable pointer beside `account_id`; the account stays the owner (cascade, unique keys, refresh and encryption unchanged), the pointer says which user the account belongs to and is what a merge repoints. (2) `slice_aliases`, a registry in the gateway database mapping a stored slice name (`user-<slackid>`, `profile-<team>-<slackid>`) to the user it belongs to; names are never changed. It is derived from bindings by one function (`syncSlices`), so it can always be rebuilt. (3) One resolver `src/knowledge/person-slices.ts` that returns, for an acting identity, the canonical slice, the read set and the profile read set; scope code takes that result as input and stays synchronous. (4) A seam, as in slice C, that computes the user-based answer next to the legacy answer, returns the legacy one while shadowed, and counts every disagreement.

Spec: `docs/superpowers/specs/2026-11-12-domain-model-and-references.md` (slice F; "Alias table first; revisit in slice F"). This plan settles that open question: alias table, no rename (see Decisions F8). Builds on slice C (`docs/plans/2026-11-14-domain-access-slice-c.md`, rc.21): `src/domain/{merge,merge-undo,merge-limits,reconcile}.ts`, `src/refs/actor.ts`, `src/access/wired.ts`, `src/access/sites.ts`, and slice B's `users`, `bindings`, `user_aliases`.

## Findings (verified in code, they shape the plan)

1. Credentials belong to accounts, and a merge cannot normally reach them. `mcp_credentials` is owned by `account_id` or by (`agent_tenant`, `agent_persona`) (`0008_mcp_credentials.sql`, one owner enforced by CHECK). The bridge and `GET /v1/tenants/:tenant/mcp-credentials` find a person's rows through `accountForSlackUser(team, slackId)` (`src/gateway/api/mcp-credentials.ts:39`, `src/gateway/core/mcp-bridge.ts:229`, `src/agent/mcp-oauth/persist.ts:38`), that is, through `slack_identities`, which exists only after the portal link. A record that holds an account holds a verified oidc binding, and the engine refuses a loser with any verified binding (slice C task 25). So in practice the loser of a merge holds no credentials and the survivor's account is already the owner. The plan still adds the pointer and its repoint, because the spec says credentials move with the user and because reconciler repairs and future paths can break the "in practice". It must never be the thing that hands credentials to someone.
2. A credential is a bearer secret that acts as a person on third-party services, so it follows the strictest identity rule: only a Slack binding that is `verified` (the delivered portal link) resolves to credentials. An observed Slack binding that a merge joined to a user never does (Rule H below). This is also what `slack_identities` gives today, so legacy and user answers match in steady state.
3. The payload is AES-256-GCM with no associated data (`src/db/crypto.ts`: `createCipheriv`, no `setAAD`), keyed by `SLAUDE_MASTER_KEY`. Nothing in the ciphertext names an owner, so repointing `user_id` needs no re-encryption and no key change.
4. The job token's `runAs` is `user:<slackId>` and is resolved on the gateway on every call (`parseRunAs`, `resolveOwner`, `bridge` line 207). A merge between dispatch and call is therefore seen at call time. The token format stays as is in F: a node, an older gateway replica and rollback all keep working. Nodes hold no database; credentials come from the gateway route and memory scope is computed on the gateway and passed to the brain as `allowedSources` (`src/knowledge/remote/brain-client.ts:114`, `src/knowledge/server/tools.ts:38`), so the brain never computes a scope.
5. Slice names are keyed on the bare Slack id. `userSourceId(id)` is `user-` plus the lower-cased id with non-alphanumerics removed, cut to 32 (`src/knowledge/scope.ts`). It carries no workspace, so two workspaces with the same Slack id string (Slack Connect, a future second workspace) already share one slice. The registry must not paper over that: a source name claimed by two live users is a `conflict`, excluded from every union and reported.
6. The profile source is `profile-<team>-<slackid>` (or `profile-<24 hex>` when long), one per person per workspace (`profileSourceId`). Two Slack ids of one person in one workspace give two profiles.
7. Decision sites that name a person's slice (the map for tasks 11 to 17):
   - Scope: `src/knowledge/scope.ts` (`baseScope` lock-owner branch, `resolveBrainScope` profile append), `src/memory/scope.ts` (`memoryScopeFor`: the `runAs` branch and the DM branch; `withClaimLock`), `src/knowledge/gated-dispatch.ts` (`classifyBrainOp` lock-owner write `scope.sourceId === userSourceId(g.userId)` at line 111, `isOwnProfileWrite`, `turnBrainScope`), `src/knowledge/mcp-tools.ts` (profile reads at 222 and 340, the write-target label at 346), `src/knowledge/memory-browse.ts:145`.
   - Where the gate input is built: `brainGateFor` (`src/gateway/core/gateway.ts:1550`), `memoryScopeForClaims` (`src/gateway/api/memory.ts:143`), `src/background/proposal-cards.ts:260`, `gateway.ts:4337`.
   - Derived readers keyed on the slice name: `src/proactive/commitment-index.ts:40` (`runAsOf`: a commitment in a `user-` slice is run as that person; a name mismatch silently turns it into an agent-run commitment), `src/db/thread-activity.ts:46`, `src/proactive/feedback.ts:56,75`, `src/proactive/prefs.ts:62`.
   - Background passes: `src/background/pass-tools.ts` (`personSources`, `passReadSources`), `src/background/passes/nightly-review.ts:202-254` (one pass per `user-` source, owner read back from the slice name).
8. Per-agent slices (`agent-<id>`, legacy `agent`, `shared`, `public`, `kb-*`) are keyed by agent or are common. They are not in the registry and no code in this plan reads or writes them.

## Rules (what the code implements)

- Rule H (credentials need a verified Slack binding). A turn resolves person credentials only through the acting Slack binding when it is `verified`. Anything else (observed, unknown, resolver error) uses the legacy account lookup, never the agent's credentials and never another person's. A private service still never falls back to the agent (bridge section 4.2.4 unchanged).
- Rule I (a slice has one owner). A source name belongs to a user only through a `slice_aliases` row, and a name with rows for two different live users is `conflict`: excluded from reads for both, reported. The only names the registry accepts are `user-*` and `isProfileSourceId` shapes; `agent`, `agent-*`, `shared`, `public`, `kb-*` and gbrain's `default` are refused at insert.
- Rule J (what a person reads). The read set for an acting identity is: its own legacy slice, always; plus, only when the acting Slack binding is `verified`, every other active, unconflicted, readable alias of the same user. Observed ids read only their own legacy slice. The set is built only from alias rows of the acting user after alias resolution; it is validated against the registry once more before it is returned (defense in depth, task 8).
- Rule K (lock and runAs identity are unchanged). Who counts as the lock owner or the `runAs` person is still decided by `sameAt` (Rule G of slice C). Person slices are resolved for the speaker, or for the `runAs` id, after that check has passed. A thread locked by someone else gets the public-only scope with no union, as today.
- Rule L (writes cannot be lost or leaked by the resolver). A write goes to the legacy own slice unless the resolver, called fresh, positively names a canonical slice for this verified identity and `SLAUDE_SLICE_WRITE=canonical`. Any resolver error, timeout, conflict or missing row means the legacy own slice. A write is never refused because the registry is down.
- Rule M (hold). A non-own alias that a merge added becomes readable at `readable_from` (merge time plus `SLAUDE_SLICE_UNION_HOLD_MIN`, default 60). Rows registered for a user's own bindings are readable at once.

## Schema

Migration 0042, `0042_domain_memory_credentials.sql` (rc.22, both dialects, mirror in `src/db/drivers/sqlite.ts`, additive and nullable; no backfill in SQL, the reconciler does it):
```
mcp_credentials   ADD user_id TEXT NULL REFERENCES users (id) ON DELETE SET NULL; INDEX (user_id, server_key)
                  -- Postgres only: CHECK (user_id IS NULL OR account_id IS NOT NULL)  (SQLite cannot add a CHECK
                  -- without a table rebuild; the repo functions enforce it there and a test covers both dialects)
slice_aliases     (source_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
                   kind TEXT NOT NULL CHECK (kind IN ('personal','profile')),
                   team_id TEXT NOT NULL DEFAULT '',          -- profile slices only
                   binding_id TEXT,                            -- the Slack binding that names this slice
                   canonical BOOLEAN NOT NULL DEFAULT false,
                   readable_from BIGINT NOT NULL DEFAULT 0,
                   origin TEXT NOT NULL CHECK (origin IN ('reconcile','binding','merge','undo')),
                   merge_id TEXT,                              -- the user_merges row that added it, if any
                   created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
                   PRIMARY KEY (source_id, user_id))
                  INDEX (user_id); partial UNIQUE (user_id, kind, team_id) WHERE canonical
```
`slice_aliases` joins `NO_TENANT_TABLES` (a user is a person, not a tenant's row). The primary key is per (source, user) so two claimants of one name are visible as two rows, not hidden by a unique key. A DDL test on both dialects covers the partial unique index, the kind CHECK and the `ON DELETE` behaviour (the drift test sees columns only). The ledger `moved` shape gains two optional arrays, written for audit and the undo preview only, never read to undo (undo re-derives, task 5): `credentials: [{id, from, to}]` and `slices: [{source_id, from, to}]`.

## Resolver API

`src/db/slice-aliases.ts` (repo, every function takes an optional `tx`): `syncSlices(userIds, tx)` derives and upserts the rows from each user's Slack bindings (personal: `userSourceId(value)`; profile: `profileSourceId(team, value)`), removes rows whose binding no longer belongs to the user, keeps an existing canonical, else picks the oldest verified binding's slice, else the oldest, and returns the rows added, repointed and removed; `aliasesOf(userId, ctx)`; `claimantsOf(sourceId)`; `conflicts()`.

`src/knowledge/person-slices.ts`:
```ts
interface PersonSlices {
  userId: string | null;             // live id, alias resolved; null = legacy answer only
  via: "legacy" | "registry";
  own: string;                       // userSourceId(slackId): always readable, the legacy write target
  canonical: string;                 // equals own unless the registry names another
  reads: string[];                   // own first, then unconflicted readable aliases (Rule J)
  profileOwn: string | null;         // speakerProfileSource(team, slackId)
  profileReads: string[];            // profileOwn first, then aliases of the same team
  held: string[];                    // aliases not yet readable (Rule M), for logs and the console
}
personSlices(teamId: string | null, slackUserId: string, ctx?: { tx?: DbClient }): Promise<PersonSlices>   // fresh read, never throws: an error returns the legacy shape and counts
legacyPersonSlices(teamId, slackUserId): PersonSlices                                                  // pure
```
Scope code gains an optional `person?: PersonSlices` on `GateInput` and `ScopeInput`; absent means `legacyPersonSlices`. `resolveBrainScope`, `memoryScopeFor`, `classifyBrainOp` stay free of database calls, so the existing sync call sites and every existing test keep working. The slice reads are fresh by design (no cache), one indexed query per turn, because they decide whose private memory is read (compare D9 of slice C).

`src/db/mcp-credentials.ts` gains `credentialsForUser(userId)` (rows by `user_id`, then the same decrypt and shape checks as `credentialsFor`; per server the entry with the latest `expires_at`, ties by row id, so the answer is deterministic) and `ownerRowFor(userId, serverKey)` (which account owns the chosen row, so a refresh writes back to that account, never to a different one).

## Flags (every default changes nothing)

| Flag | Values | Default | Effect |
|---|---|---|---|
| `SLAUDE_CRED_OWNER` | `legacy`, `shadow`, `user` | `shadow` | `legacy`: account lookup only, no resolver. `shadow`: legacy answer returned, user answer computed and compared. `user`: user answer returned (Rule H), legacy still computed for the reverse comparison. Read on every call. |
| `SLAUDE_SLICE_SOURCE` | `legacy`, `shadow`, `alias` | `shadow` | Same three modes for the read set. `alias` adds the union (Rules J, M). |
| `SLAUDE_SLICE_WRITE` | `own`, `canonical` | `own` | `canonical` sends a merged person's new writes to the canonical slice. Honoured only when `SLAUDE_SLICE_SOURCE=alias`. |
| `SLAUDE_SLICE_UNION_HOLD_MIN` | integer minutes | `60` | Rule M. |
| `SLAUDE_MERGE_SLICES` | `on`, `off` | `on` | Merge and undo maintain the registry and the credential pointers. Inert while both source flags are `shadow` or `legacy`. `off` freezes maintenance; the reconciler repairs when turned back on. |

## Tasks

### rc.22: schema, registry, reconciler, resolver, shadow (legacy authoritative)

1. Migration 0042 and DDL tests.
   - Files: `src/db/migrations/0042_domain_memory_credentials.sql`, `src/db/drivers/sqlite.ts`, `src/db/schema.ts` (`NO_TENANT_TABLES`), `tests/db/slice-schema.test.ts`, the drift test.
   - Tests first: upgrade from 0041 with existing credentials (new column NULL, every old read still works); an older binary can still insert credentials (no `user_id`); the partial unique canonical index refuses a second canonical for one (user, kind, team); the kind CHECK; deleting a user nulls the credential pointer and cascades alias rows; the Postgres CHECK refuses `user_id` on an agent row; `SLAUDE_DB=pg` too.
2. Slice registry repo and `syncSlices`.
   - Files: `src/db/slice-aliases.ts`, `src/knowledge/scope.ts` (export `isUserSourceId`, `isPersonSliceName`, used by the repo to refuse every other kind of name), `tests/db/slice-aliases.test.ts`.
   - Tests first: one Slack binding gives one personal row with canonical true and `readable_from` 0; two Slack ids of one user (two teams) give two personal rows and two profile rows, one canonical per (kind, team); an unlinked binding removes its row; `agent-x`, `agent`, `shared`, `public`, `kb-x` and `default` are refused; two users whose ids produce one name give two rows and `conflicts()` lists the name; running twice changes nothing; the canonical is stable when an older-looking binding appears later; a bot or agent user gets no rows.
3. Reconciler passes for slices and credential pointers.
   - Files: `src/domain/reconcile.ts`, CLI `slaude domain reconcile` (new report sections, `--apply` as the existing steps), `tests/domain/reconcile.test.ts`.
   - Slices: run `syncSlices` for every user with a Slack binding (idempotent, advisory lock on Postgres, dry run counts only). This also covers merges made in rc.21, which have no registry rows, because rows derive from the bindings' current owners. Report: conflicting names (both users, masked), users with no rows, rows whose binding moved (drift).
   - Credentials: for every row with `account_id` and `user_id` NULL or different from the account's current user (account to oidc binding to alias-resolved user), set `user_id` with a compare on the old value; count accounts with no oidc binding (skipped, never invented). Never writes an agent row. The report is the gate input for rc.23 (zero drift).
   - Tests first: an account with two aliases in its user chain points at the live user; drift after a merge is repaired; a skipped account is counted; dry run writes nothing.
4. Credentials dual write.
   - Files: `src/db/mcp-credentials.ts` (`putCredential`, `putCredentialIfNewer`, `putCredentialIfAbsent` fill `user_id` from the account's user inside the same statement's transaction when it resolves, else leave NULL; they never throw because of it), `src/db/accounts.ts` (`deleteAccount` unchanged, cascade), `src/db/account-projection.ts` (after `projectLogin` or `projectLink` create or move a user for an account, `UPDATE mcp_credentials SET user_id = ? WHERE account_id = ? AND (user_id IS NULL OR user_id <> ?)`), tests.
   - Tests first: a write for an account with a user stores the pointer; a write when the resolver fails still stores the credential with NULL; a newer-only write keeps the pointer; the encrypted payload is byte-identical to before (no re-encryption); agent rows never get a pointer.
5. Merge and undo maintain the registry and the pointers.
   - Files: `src/domain/merge.ts` (inside the existing transaction and savepoint, after bindings move: `syncSlices([survivor, loser])` with `origin 'merge'`, `merge_id`, `readable_from = now + hold` for rows that are new to the survivor; repoint `mcp_credentials.user_id` loser to survivor with compare-and-set on the old value; record `moved.credentials` and `moved.slices`; after commit bump `mcp-cred-epoch` for the affected account owners via `epochOwnersFor`), `src/domain/merge-undo.ts` (after bindings move back: `syncSlices([survivor, loser])` with `origin 'undo'`, which removes the survivor's rows for the returned bindings and restores the loser's; repoint credential pointers back only where the current `user_id` equals the ledger's `to`, else list them as `skipped`; bump epochs), `src/domain/merge-limits.ts`, `tests/domain/merge-slices.test.ts`.
   - Undo does not depend on `moved.slices`: it re-derives from bindings, so merges made before rc.22 (no `slices` array) undo correctly too. `SLAUDE_MERGE_SLICES=off` skips all of this and the reconciler repairs later.
   - Replace the first undo-limit line with: "Undo moves records, grants, credential pointers and memory slice access back. Memory pages are never moved: notes written into a slice during the merge stay in that slice." Keep the console stub in sync (`merge-limits.ts` must stay import free).
   - Tests first: merge then undo restores both users' read sets exactly; a merge that fails the savepoint writes no registry or pointer change; merge of a user pair where one name conflicts adds no row for the conflicted name; chained merges (A into B into C) then undo later-first; a pointer changed after the merge is skipped and reported; epoch bump called once per affected account owner.
6. Person slices resolver and legacy twin.
   - Files: `src/knowledge/person-slices.ts`, `tests/knowledge/person-slices.test.ts`, metrics `slaude_slice_resolve_total{result}`, `slaude_slice_resolve_failures_total`.
   - Tests first (each is a Rule J row): unknown Slack id gives the legacy shape with `via legacy`; verified binding of a merged user gives own plus the other slice after `readable_from`, and `held` lists it before; an observed binding of the same user reads only its own slice; a conflicted name appears in no read set; a retired row (binding unlinked) is absent; the same Slack id string in two workspaces gives a conflict, not a union; a registry error returns the legacy shape and counts a failure; the returned set never contains an `agent-`, `shared`, `public`, `kb-` name (property test over random registry contents); profile reads stay inside the acting team.
7. Seam, flags and metrics.
   - Files: `src/slices/decide.ts` (`decidePersonSlices({site, ...})`, `decideCredentialOwner({site, ...})`), `src/config/env.ts` (the four flags above, read per call, unknown value reads as `legacy`), `src/metrics.ts` (`slaude_slice_shadow_total{site,outcome}`, `slaude_slice_decision_total{source,site,result}`, `slaude_cred_shadow_total{site,outcome}`), `tests/slices/decide.test.ts`.
   - Outcomes: `match`, `would_widen` (the registry adds slices; expected only for a merged person, tagged `merged-person-union`), `would_narrow` (the registry lacks the legacy own slice: a bug, never intended), `conflict`, `no_user`, `error`. In `shadow` the legacy value is returned, a mismatch is logged once per (site, reason) per minute with internal ids only (no Slack id, no email, no slice name beyond its kind), and a new-path error counts `error` and never changes the answer. `legacy` calls no resolver.
8. Defense in depth and the site registry.
   - Files: `src/knowledge/person-slices.ts` (`assertOwned(person, userId)` re-checks every non-own source against the registry before it can leave the resolver), `src/slices/sites.ts` (every site id and its task group, like `src/access/sites.ts`), `tests/slices/no-string-slice.test.ts`, `tests/slices/string-slice.allow.json`, `scripts/verify-slice-sites.sh`.
   - Guard: scans all of `src` for `userSourceId(`, `startsWith("user-")`, `slice("user-".length)`, `profileSourceId(` and `speakerProfileSource(` and fails on any hit not in the committed allowlist (one entry per file and pattern with a reason: legacy twin, display, pure helper, pass key). A new hit needs a reviewed line. `verify-slice-sites.sh` reads `/metrics` and prints sites with a zero count, each needing a scripted sim smoke before the flip.
9. Credentials read path through the seam.
   - Files: `src/gateway/api/mcp-credentials.ts` (`resolveOwner` returns the legacy owner and, through `decideCredentialOwner`, the user answer), `src/gateway/core/mcp-bridge.ts` (the `accountFor` and `credentialsFor` deps: add `userCredentialsFor`; the legacy account path stays the default in `shadow`), `src/agent/mcp-oauth/persist.ts` (`ownerFor`: unchanged owner, still an account), `src/gateway/core/credential-refresh.ts` (refresh writes to the owner of the row chosen, `ownerRowFor`), tests under `tests/gateway/mcp-bridge/`.
   - Under `user`: `actingUser(team, slackId, {fresh: true})`; verified Slack binding required (Rule H); `credentialsForUser`; if the result is empty or the identity is not verified, fall through to the legacy account lookup (same person by construction); a resolver error falls through to legacy and counts `fallback_legacy`. The agent identity, the private-service rule and the job-token claims are untouched.
   - Tests first (matrix): legacy and user agree for a linked person; a person with a verified Slack binding and no account gets nothing; an observed binding merged into a user that holds an account gets nothing and no agent fallback (Rule H); two accounts of one user (set up directly in the database) return the entry with the later expiry per server and refresh writes the owning account; the same Slack id in two workspaces resolves per team; resolver throws: legacy answer, never agent, never another person; epoch bump invalidates a warm session after a merge; the node projection still carries no refresh token.
10. Slice read path through the seam (scope inputs only, no behaviour change in `shadow`).
    - Files: `src/knowledge/scope.ts` (`ScopeInput.person`; lock-owner branch and DM branch read `person.reads` and `person.canonical` only when the mode is `alias`; `profileSource` stays the speaker's own, `person.profileReads` extend `allowedSources` read-only), `src/memory/scope.ts` (`runAs` and DM branches take `person`), `src/knowledge/gated-dispatch.ts` (`GateInput.person`; lock-owner write check compares `scope.sourceId` with `person.own` or `person.canonical`; `isOwnProfileWrite` still demands the sole Slack sender and still targets that sender's own profile), `src/gateway/core/gateway.ts` (`brainGateFor` and the claims path attach `person` from one `decidePersonSlices` call per turn), `src/gateway/api/memory.ts` (`memoryScopeForClaims` resolves for `claims.runAs` or the speaker, after `sameAt`), tests.
    - Tests first: with `legacy` and `shadow` every existing test in `tests/brain-scope.test.ts`, `tests/memory/*`, `tests/knowledge/*` passes unchanged; under `shadow` a seeded merged person records `would_widen` while the scope stays legacy; a lock owned by someone else yields the public-only scope with no union for a merged speaker (Rule K); a turn with mixed senders reads no profile; a DM from an allow-listed non-manager reads only that person's slices.
11. Wire group 1: derived readers.
    - Files: `src/proactive/commitment-index.ts` (`runAsOf(scope, person)` accepts the canonical or any registered alias of the scope's person, so a commitment written into a canonical slice by a merged person keeps its `run_as`), `src/db/thread-activity.ts`, `src/proactive/feedback.ts` (feedback reads the person's profile through `profileReads`, writes stay own), `src/proactive/prefs.ts` (read the newest across `profileReads`; write unchanged), `src/knowledge/memory-browse.ts` (label by kind, no id), `src/knowledge/mcp-tools.ts` (write-target label and profile reads), tests per site.
    - Tests first: a promise written by a merged person into the canonical slice is still scheduled as that person and never as the agent; after undo it is still checked as its original person or marked unowned (never as the survivor's guess); a preference stored under the old id is read after a merge and not written back to the other id.
12. Wire group 2: background passes.
    - Files: `src/background/pass-tools.ts` (`personSources` takes the resolved `person`; read-only extra sources are `person.reads` minus own and profile), `src/background/passes/nightly-review.ts` (shadow only in rc.22: log how many `user-` slices would group into one person; behaviour unchanged), `tests/background/`.
    - Tests first: a pass for one person never lists another person's source; two slices of one merged person produce one `would_group` count and, in rc.22, two passes as today; a pass whose resolver fails reads own only.
13. Console read model for operators (read only).
    - Files: `src/db/domain-read.ts`, `src/gateway/panel/api.ts` (`GET /panel/api/slice-aliases?user=` and `GET /panel/api/slice-conflicts`, both superadmin, audited on refusal), `src/web/console/pages/domain/` (a Slices section on the Users page: kind, canonical, held until, origin; no Slack id, no email).
    - Tests first: 403 and an audit row for non-superadmin; masked output; a conflict row lists no person's identity beyond a masked label.
14. rc.22 release.
    - Files: `docs/site/_content/releases/v0.46.0.md` (stable name, from the first RC), field note `domain-memory-credentials-shadow`, CLAUDE.md index line, spec amendment (slice F status, the alias decision), deploy notes.
    - Gate before rc.23 (3 days, or 200 turns per active agent, whichever is later): `would_narrow` zero; `error` below 0.1 percent; `would_widen` only with tag `merged-person-union`; every slice site has a nonzero count or a passing scripted smoke; credential `match` rate 100 percent except `no_user` for people with no binding yet; reconciler report clean (no drift, conflicts reviewed by the owner); guard test green; a merge and undo rehearsed on a restored backup copy (task 21).

### rc.23: credentials read through the user

15. Flip `SLAUDE_CRED_OWNER` default to `user`.
    - Files: `src/config/env.ts`, `tests/gateway/mcp-bridge/failure-modes.test.ts`.
    - Failure modes, tests first: registry or resolver throws: legacy account answer for that call (counted `fallback_legacy`); never the agent, never another person; `legacy` flag restores the old path with no resolver call; a person with no verified binding gets the legacy answer (usually nothing). Reverse shadow keeps comparing and counts `legacy_disagrees`.
16. Operator view of credentials by user (read only, no secrets).
    - Files: `src/gateway/panel/api.ts` (`GET /panel/api/users/:id/credentials`: server keys and expiries only, through `credentialExpiries`, superadmin), the console Users page, tests (a payload, a token or an account subject never appears in the response).
17. rc.23 release: notes, field note addendum, CLAUDE.md line. Gate before rc.24 (3 days): `legacy_disagrees` zero for credentials; every credential-backed MCP server used in the window answered through the user path at least once or through the scripted smoke; no `fallback_legacy` burst; reconciler pointer drift zero.

### rc.24: memory reads through the registry, then optional canonical writes

18. Nightly review and passes group by user.
    - Files: `src/background/passes/nightly-review.ts` (key the person map by the user's canonical Slack id when the registry names one; read the union; the per-person turn filter `ownTurns` already drops turns by other authors, and a merged person's own turns are authored by either of their ids, so extend the filter to authors resolving to the same user via `sameAt`), tests.
    - Tests first: two slices of one merged person give one pass; a turn by a different person in either slice is dropped and counted; a conflicted slice is skipped with a warning naming no person.
19. Flip `SLAUDE_SLICE_SOURCE` default to `alias`.
    - Files: `src/config/env.ts`, `tests/slices/failure-modes.test.ts`.
    - Failure modes, tests first: registry read throws or times out: the legacy own slice only, never a wider set (fail closed: nothing of another record is read on error); a held alias is absent until `readable_from`; a conflicted name is absent; a read for someone else's locked thread is public only. Reverse shadow keeps `would_narrow` at zero.
20. `SLAUDE_SLICE_WRITE=canonical` support (default stays `own`; it is turned on only after the owner decides F1).
    - Files: `src/knowledge/scope.ts` and `src/memory/scope.ts` (the write source is `person.canonical` only under `alias` and `canonical`, with a fresh resolution at write time; otherwise `person.own`), `src/knowledge/brain.ts` (no change: `ensureSource` already creates any name at first write), tests.
    - Tests first: a write by a merged person's second Slack id lands in the canonical slice and is read back by both ids; a registry error at write time lands in the id's own slice and is read back through the union; a brain error is reported exactly as today and no write is queued to another slice; after undo the second id can no longer read the canonical slice and can read its own; per-agent writes are byte-identical to before.
21. Rehearsal on a restored backup copy (never on live).
    - Files: `scripts/rehearse-slice-merge.sh` (restores a backup into a scratch database and a scratch copy of the brain home, points `SLAUDE_DB` and `SLAUDE_BRAIN_HOME` at them, refuses to run when either path is the live one), a section in the release-prep skill.
    - Steps: run `slaude domain reconcile` (report), pick two test users, merge through the engine, run a recall from each Slack id, undo, run the recall again, write the report. The script exits non-zero if the loser can read the survivor after undo or the survivor can read the loser after undo.
22. rc.24 release: notes, field note `domain-memory-credentials`, spec amendment (alias table decided, rename deferred), CLAUDE.md line, console undo-limit text. Gate to stable: 7 days on rc.24 with no unexplained `would_narrow`, no leak-test failure in CI, the owner's decisions below recorded.

## Brain side, exactly

- Where the scope is computed: `src/knowledge/scope.ts` (`resolveBrainScope`, `baseScope`) and `src/memory/scope.ts` (`memoryScopeFor`), fed by `GateInput` from `brainGateFor` and `memoryScopeForClaims`, both on the gateway. `gated-dispatch.ts` only classifies a write against a scope it is handed. The brain (local gbrain or `slaude brain-server`) receives `{clientId, sourceId, allowedSources}` and enforces them; it computes nothing and learns nothing new. No gbrain table, source row or page changes. `ensureSource` creates a canonical name at first write like any `user-` name.
- What changes in the scope value: only the contents of `allowedSources` for a verified, merged person (extra `user-*` and `profile-*` names from the registry) and, under `SLAUDE_SLICE_WRITE=canonical`, the `sourceId` for that person's writes. For everyone else the value is byte-identical to today, which a golden test pins (task 10).
- On merge: the registry repoints the loser's rows to the survivor (new rows hold until `readable_from`), the loser's own slices stay readable by the loser's id only until the loser id's binding is on the survivor, then by the survivor's verified ids. Nothing in gbrain moves.
- On undo: bindings return, `syncSlices` removes the survivor's rows for them and restores the loser's, both users' next turn reads their own names. Cached state: none for slices (fresh read), epoch bump for credentials. Pages written while merged stay in the slice they were written to (`own` mode: each in its writer's slice, so undo is clean; `canonical` mode: in the canonical slice, which stays with the survivor).
- Two Slack ids of one user: both bindings register their names; one canonical per kind (and per team for profiles). A verified id reads the union; an observed id reads only its own. A same-workspace second id never writes a profile into the first's profile: profile writes stay the sole sender's own profile (`isOwnProfileWrite` unchanged).
- Per-agent slices: not registered, not read, not written by any new code; a test asserts the scope of a trusted-channel turn, a manager turn and a cron turn is byte-identical before and after for a merged person.

## Failure modes

- Registry or resolver down: reads narrow to the legacy own slice (never wider), writes go to the legacy own slice (never lost, never refused). Counted, logged by class.
- Brain down: unchanged, the existing memory and brain failure paths apply; the resolver adds no brain call and no retry queue.
- Gateway database down: the turn already cannot run; credentials fall to the existing 503 or empty-entries answers (bridge unchanged).
- Conflicted source name: excluded from every read set and from canonical selection, reported by the reconciler and the console.
- Resolver slow: a 250 ms bound per `personSlices` call, then the legacy shape (Rule L); a counter shows how often.
- Merge or undo racing a turn: the turn used one fresh read; the next turn sees the new state. A turn that began before an undo can finish one read with the old union; the window is one turn, stated in the release note. Privileged-style freshness (no cache) keeps it to that.
- Node role: nodes never read the database. They receive credentials from the gateway route and a scope or memory result from `/v1/tools/memory` and the KB tool routes, all computed on the gateway. A test fails the build if anything under `src/node` or `src/agent` imports `src/db/slice-aliases`, `src/knowledge/person-slices` or `src/slices/*`.

## Test strategy

- Cross-person leak tests are the core (`tests/slices/leak.test.ts`, run on sqlite and `SLAUDE_DB=pg`):
  1. Property test: random sequences over four to six people, two workspaces, one to three Slack ids each, with operations link, unlink, observe, merge (proof and console), undo, delete account, add a second account, restart the resolver cache. After EVERY step, for every acting identity, assert: the read set is a subset of the names whose registry rows belong to that identity's current user (Rule J); the identity's own legacy slice is present; no name in the set is claimed by another live user; no `agent`, `shared`, `public`, `kb-` name was added by the resolver; an observed identity has no non-own name; a locked thread of another person yields exactly the public-only scope. Fixed seed, 3000 sequences, plus the shrunk failing sequence printed on failure.
  2. Scripted sequences: merge then undo then merge again; merge A into B, undo, merge B into A (refused when verified, proposal); chained merges undone later-first; unlink after merge; a link replay after undo (vetoed) reads nothing; hold window respected at the boundary (one minute before and after `readable_from`).
  3. End to end with the fake brain (`tests/memory/fake-brain.ts`): write as the loser id, merge, recall as the survivor id (found after the hold), undo, recall as the survivor (not found), recall as the loser (found); and with `SLAUDE_SLICE_WRITE=canonical` the same with the documented difference.
  4. Fault injection: registry read throws, registry write throws mid-merge (savepoint leaves nothing), resolver slow, brain write throws, epoch bump throws (merge still commits, counted).
  5. Golden table for the sites (identity by mode by context rows, each difference needs a tagged row), parity property test (Slack-only world, one workspace, `alias` equals `legacy` for every scope field when no merge exists, 5000 cases, fixed seed).
- Credentials: matrix in task 9 and 15; a test that a merge never moves a credential from an account that still has a verified binding on another user; encrypted payload bytes unchanged across merge and undo.
- Existing suites run under each flag value (`tests/brain-scope.test.ts`, `tests/memory`, `tests/knowledge`, `tests/gateway/mcp-bridge`, `tests/domain`).
- Commands: `bun test`, `SLAUDE_DB=pg bun test`, `bun run typecheck`, `bun run test:web`.

## Rollout

Per RC: backup before the version bump (`sudo /usr/local/sbin/slaude-backup`), deploy through vps-hardening, `verify` 0 FAIL, run `slaude domain reconcile` (report first, then `--apply` for the new steps), read the shadow metrics and `scripts/verify-slice-sites.sh`, then the live smoke.

| RC | Changes | Behaviour change | Rollback |
|---|---|---|---|
| rc.22 | 0042, registry, reconciler steps, dual write, merge and undo maintenance, resolver, shadow seams, console read model | none (legacy authoritative); the registry fills; merges and undo also repoint registry and pointers | `SLAUDE_SLICE_SOURCE=legacy`, `SLAUDE_CRED_OWNER=legacy`, `SLAUDE_MERGE_SLICES=off`, or redeploy rc.21 (additive columns and table are ignored by it) |
| rc.23 | credentials read through the user | none for a linked person (answers match by construction); a repaired or merged record is served from the user | `SLAUDE_CRED_OWNER=shadow` or `legacy`; rc.22 safe |
| rc.24 | slice reads through the registry, group-by-user passes, canonical write support (off) | a verified, merged person reads both of their slices after the hold | `SLAUDE_SLICE_SOURCE=shadow`; set `SLAUDE_SLICE_WRITE=own` before any rollback below rc.24 |

Rolling back below rc.24 after `SLAUDE_SLICE_WRITE=canonical` was ever on: pages already written to a canonical slice stay there and stay readable by the survivor's own id; the second id loses sight of them. Set `own` first, let a day pass, then roll back.

Stable promotion waits 7 days on rc.24 (`scripts/promote-rc.sh`). The legacy path, seams and flags are removed one stable release later.

Live smoke (after each RC, sam agent, real Slack, live model; placeholders only in any note written):
1. DM: ask the agent to remember a fact (`memory_save`), then in a new DM thread ask it to recall it; check the page landed in the person's `user-` slice and nowhere else.
2. Trusted channel: save a note (lands in the agent's own slice, as before) and recall it from another thread; a second person in the channel does not see the first person's DM fact.
3. `/1on1`: write and recall inside the lock; a bystander in the thread gets the public-only scope.
4. A credential-backed MCP call (a private service, as the linked person) through the bridge, including one forced refresh (`failedAccessTokenHash` path); the agent's own shared credential call unchanged.
5. Metrics: shadow `would_narrow` zero, `error` near zero, decision counts for every site; credentials `match`.
6. Simulated merge: only through `scripts/rehearse-slice-merge.sh` on a restored backup copy with a copy of the brain home. No merge is made on the live deployment during the smoke. Record the report (names masked) in the release PR.

## Decisions needed from the owner (recommended default first)

- F1 Where a merged person's new memory writes go: their own slice by the writing id (default `own`; undo is clean, nothing to untangle) versus the canonical slice (`canonical`; tidier, but notes written in the merged state stay with the survivor on undo). The plan ships the flag and keeps `own` until you decide.
- F2 Union hold after a merge: 60 minutes (default), 24 hours (safer against a wrong merge, slower for the person), or 0 (immediate). The hold never delays the person's own slice.
- F3 Credentials: a `user_id` pointer beside the account (default), versus making the user the owner (rebuild of the table, new unique key, changed cascade, re-pointed refresh; not recommended, no gain while the verified-loser rule holds).
- F4 Slice names that two live users produce (the same Slack id string in two workspaces): report only and exclude from unions (default), versus fix by adding the workspace to new names (a rename, so a later slice).
- F5 Observed Slack bindings joined to a user: no union and no credentials, own legacy slice only (default, Rules H and J). The alternative needs the deferred workspace-trust slice first.
- F6 Profiles: read the union, keep writing the sole sender's own profile (default); versus a canonical profile (needs a page merge, out of scope).
- F7 Nightly review: one pass per user over the union (default, task 18), versus one pass per Slack id as today.
- F8 Rename on merge: not in F, and not before the alias table has soaked on a stable release. A rename needs a brain-side page move, which this slice forbids. Record "alias table, rename deferred" in the spec.
- F9 Retention of registry rows for a deleted user: cascade with the user (default); the reconciler rebuilds from bindings.
- F10 Console exposure of slice names: kind and canonical flag only, never a name or a Slack id (default).

## Risks

- A wrong merge exposes the loser's private slice to the survivor. Mitigation: merges only on proof and never with a verified loser (slice C), the hold (F2), the notice (update its text to mention memory), undo cuts access at once, `SLAUDE_AUTO_MERGE=off`, `SLAUDE_SLICE_SOURCE=shadow`.
- A site left on the legacy name after the flip (a commitment turned into an agent-run one, a pass reading one id only). Mitigation: the full-tree guard, the site registry and per-site smoke, reverse shadow, the commitment test.
- A source name shared by two people already exists in the data. The registry makes it visible; it does not fix it (F4). Until fixed, those two people share a slice exactly as today.
- Credentials: a stale pointer after a path not covered by the engine. Mitigation: the legacy fallback is the same person, the reconciler repairs drift, `legacy_disagrees` is a gate.
- Undo cannot move pages: stated in the limits text and the release note; `own` mode makes it nearly vacuous.
- One more indexed query per turn and one per credential call. Mitigation: measured in shadow, bounded at 250 ms, falls back to the legacy shape.
- Warm sessions hold a stale tool list after a credential change. Mitigation: the existing credential epoch is bumped for the affected accounts on merge and undo.
- The sqlite mirror cannot carry the Postgres CHECK on `mcp_credentials`. Mitigation: repo-level enforcement plus a test on both dialects.
