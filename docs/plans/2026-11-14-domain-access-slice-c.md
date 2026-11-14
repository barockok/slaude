# Domain access, slice C: authority on internal ids

> For Claude: use superpowers:executing-plans, task by task. One task per commit. A release boundary is a hard stop: soak, check the gate, then continue.

Goal: admission, roles, approval and the 1on1 lock decide by internal user id instead of by Slack id string, so `email:` in an ACL works through the portal link, records merge on proof, and a wrong merge can be undone. Delivered as three releases (rc.19 to rc.21) so that no release both changes who is trusted and is the first to run the new code. The workspace email trust (`trustProfileEmail`) is NOT in this plan: it is deferred to its own later slice, after C is stable (see Deferred).

Architecture: one pure decision module `src/access/authority.ts` computes admit, role and approvers from effective grants plus a resolved acting user. A thin seam `src/access/decide.ts` runs the legacy string path and the new path, returns whichever `SLAUDE_ACCESS_SOURCE` names, and logs and counts every disagreement. rc.19 hardens identity proof and ships the seam with the legacy path authoritative. rc.20 flips it and only then allows email grants. rc.21 adds the merge engine, notice, undo and console. Migrations are additive and nullable.

Spec: `docs/superpowers/specs/2026-11-12-domain-model-and-references.md`. Builds on slice B (`docs/plans/2026-11-14-domain-records-slice-b.md`, rc.18): `src/db/domain.ts` (`adoptBinding`, `user_aliases`, `resolveUserId`), `src/refs/resolve.ts`, `src/db/account-projection.ts`, `src/domain/{reconcile,first-sight,sync-refs}.ts`, `src/db/domain-read.ts`.

## Defects found in review (verified in code, fixed first)

1. A "verified email" is not verified today. `src/gateway/panel/auth/oidc.ts:154` takes whatever claim `cfg.userClaim` names as the identity (it need not be an email), and `oidc.ts:161` rejects only `email_verified === false` and only when `userClaim` is `email`; a token with the claim absent passes. `src/gateway/portal/auth-routes.ts:119` stores that string as the account email (`upsertAccount`, `src/db/accounts.ts:47-66`), and `projectLogin` (`src/db/account-projection.ts:77-88`) adopts it as a `verified` email binding. rc.18 already has this exposure. Effect today: data only (nothing reads bindings for access), but an attacker who controls an identity claim could squat a verified binding for a victim's address, and from rc.20 that binding would activate the victim's email grants. Fixed in rc.19, before any shadow work (tasks 1 and 5).
2. `sameUser` by "one user record" is unsafe once an observed Slack binding can sit on a record that also holds a verified one. The comparison sites are `src/access/permission-auth.ts:29-30` (initiator and lock owner), `gateway.ts:2060`, `2333`, `2760`, `3185` (1on1 lock owner), `src/memory/scope.ts:53` and `src/knowledge/gated-dispatch.ts:104-110` (lock owner against speaker). The rule is below (Rule G).
3. Email grants break the legacy readers. `usersWithRole` (`src/access/role.ts:50`) collects every user grant's `subjectId` and `approversFor` (`role.ts:155-158`) returns them, so `email:a@example.com` would come back as an approver id to DM and to match clicks. Worse, an approval allowlist with only non-Slack approvers is empty, and an empty default-persona chain means anyone may click (`approval-gate.ts` `#resolveApprovers`, chain size 0). Therefore: no non-Slack grant or non-Slack access ref is accepted anywhere until rc.20, and the legacy readers drop non-Slack subjects in rc.19.
4. A link token can be replayed after an unlink within its TTL. `src/gateway/portal/link-token.ts:22` (`LINK_TTL_SEC = 900`) and its header comment rely on the `slack_identities` primary key for single use, but `unlinkSlackIdentity` (`src/db/accounts.ts:138`) deletes that row, so the same token relinks. Fixed with a single-use ledger (task 3).
5. `admit()` ignores the subject and the team for kind "workspace": `src/access/admission.ts:34` and `src/access/role.ts:34` test only `g.subjectKind === "workspace"`. Any workspace grant admits everyone in every workspace. Fixed at the flip, after a reconciler report (D12).
6. `one_on_one_locks` has no team column (`src/db/migrations/0003_gateway_state.sql:66`), `roleOf` takes no team, and `src/background/proposal-cards.ts:254` builds its gate with `teamId: null`. A Slack id is only unique in a workspace, so the flip needs the team plumbed to every decision (task 12).
7. The first map missed decision sites (now listed below and wired in tasks 13 to 18).

## Decision map (every place a Slack id string is authority)

Core (pure, string equality on `subjectId === userId`): `src/access/admission.ts` `admit`; `src/access/role.ts` `roleFromGrants`, `isDenied`, `usersWithRole`, `approversFor`, `roleOf`; `src/access/grants.ts` `deriveSoulGrants`; `src/persona/agent-def.ts` `slackId()` (strips the workspace, refuses non-Slack schemes); `src/access/permission-auth.ts` `canDecidePermission`.

Sites, by task group:
- Gateway: `gateway.ts` `isManagerOf` (851), `/mcp connect` lock check (2057-2065), connect-card click (2332-2336), 1on1 speaker gate (2756-2760), slash 1on1 (3002-3060), `/mcp` in a lock (3183-3191), heartbeat and manager compares (2932, 2943), `/soul` (3085-3121), cron roles (3342), admission (4212), connect notification target `soulDataFor(...).manager.userId` (4750), `proposalManagers` (961), `backgroundManagers` (916), managers list (1636).
- Approval and cards: `approval-gate.ts` allowlist `approvers.has(userId)` (215, 249), `#resolveApprovers` (321-349, includes the soul manager list at 347 and the env list), `isDenied` (177); `permission-gate.ts` `mayDecide` (913).
- Soul-field readers: `src/gateway/slack/model-auth.ts:13-16` (`canChangeModel`), `ingest-auth.ts:15-16` (`canTriggerIngest`), `src/soul/overrides.ts:9-10,57` (dm and block lists, self-lockout guard), `src/soul/per-persona.ts:147-159` (per-persona versus default manager, approver, dm and blocked fallback), `src/gateway/core/surface-mcp.ts:175`, `src/gateway/slack/mcp-tools.ts:580`.
- Knowledge and memory: `src/knowledge/gated-dispatch.ts:104-110,249` (lock owner, `managers.includes(r.by)`), `src/knowledge/mcp-tools.ts:228`, `src/knowledge/scope.ts:47,149` (`userSourceId`, lock owner), `src/memory/scope.ts:53-82`, `src/background/proposal-cards.ts:248-254`.
- 1on1, remote, env: `src/remote/active.ts:32`, `src/gateway/core/remote-command.ts:47`, `src/gateway/core/env-command.ts:172,289,362,531`, `src/agent/oauth-home.ts:155-167` (a storage key, see below).
- Background and display: `src/background/scheduler.ts:528` `personaManager`, `digest.ts`, `src/proactive/rule-tool.ts:66`, `src/mandate/index.ts`, `src/gateway/panel/settings-view.ts`, `src/gateway/portal/my-agents.ts`.
- Restrictions kept on strings on purpose (an ignore or a deny fails toward blocking): `src/gateway/slack/ignore-gate.ts:7` (`Ignores.findActiveForUser`). Storage keys kept on Slack ids until slice F: `userSourceId`, `oauth-home` config dir, `runAs` (`src/agent/credential-owner.ts`, resolved to an account by `accountForSlackUser`). Credentials belong to an account, so a user merge in C moves none.
- Stored grants: `src/db/agent-grants.ts` (`SUBJECT_ID_RE` accepts Slack ids only), panel API `src/gateway/panel/api.ts` (createGrantSchema), `src/web/console/lib/grants.ts`.
- Identity link: `link-token.ts`, `src/gateway/portal/api.ts:322-340` (redeem), `src/db/accounts.ts` (`linkSlackIdentity`, `unlinkSlackIdentity`), `account-projection.ts` (`projectLink` adopts the Slack binding to the account's user).
- Audit actor ids and session initiators stay Slack ids in C (rows are never rewritten; sessions are slice D).

## Rules (what the code implements)

Binding strength: a Slack binding is `verified` only through the delivered portal link. An email binding is `verified` only when the OIDC token had `email_verified === true` and a real email claim (task 1). Otherwise it is `observed`. A binding named in a definition is `declared`.

- Rule A (authority). The acting user is the user holding the Slack binding for (team, Slack user id). Ordinary access (member, deny, channel grants, dm) flows from grants naming any binding of that user in the states Rule B allows. Privileged access (manager, approver) flows only when the acting Slack binding itself is verified, and for an `email:` entry the email binding must be verified too.
- Rule B (entries). `slack:user:T0EXAMPLE/U0EXAMPLE`: the acting Slack binding matches, any state (the gateway verified Slack's signature; today's behaviour). `email:x`: a verified email binding held by the acting user. `user:<id>`: the acting user after alias resolution. A `declared` binding never matches.
- Rule C (deny). A deny applies from observed or verified bindings, never from declared (D11), and a Slack deny applies even to an observed binding. A resolver failure never removes a deny.
- Rule D (privileged). The acting Slack binding itself is verified. Direct `slack:user:` privileged entries keep today's behaviour until `SLAUDE_PRIVILEGED_NEEDS_VERIFIED` is turned on (D2); `email:` and `user:` privileged entries always need it.
- Rule F (outputs need Slack ids). Approver lists are used to notify and to match clicks. The new path returns user ids and `slackIdsFor(userId, teamId)` gives the ids to DM. An approver with no Slack binding in the workspace is listed in the console as pending.
- Rule G (same person). `sameUser(a, b)` is true when both are the same Slack binding (same team and id), or when they are two different Slack bindings of one user and BOTH are verified. An observed binding never joins a verified one for identity checks (initiator, lock owner, permission cards, memory and knowledge lock scope). Two observed bindings are the same person only if they are the same binding. Authority from grants (Rule A) and identity of a speaker (Rule G) are different questions and use different functions.

## Schema

Migration 0040, `0040_access_internal_ids.sql` (rc.19, both dialects, mirror in `drivers/sqlite.ts`):
```
agent_grants        ADD subject_ref TEXT NULL, ADD subject_user_id TEXT NULL; INDEX on subject_user_id
one_on_one_locks    ADD team_id TEXT NULL            -- filled at lock time; old rows NULL
accounts            ADD email_proven BOOLEAN NOT NULL DEFAULT false   -- the token had email_verified === true and an email claim
link_token_uses     (jti PK, team_id, slack_user_id, used_at, expires_at)   -- single use ledger, purged after expiry
```
`subject_kind` and `subject_id` stay authoritative through rc.19. Nothing writes `subject_ref` for a non-Slack subject until rc.20.

Migration 0041, `0041_user_merges.sql` (rc.21):
```
user_merges      (id PK, created_at, kind 'proof'|'console', survivor_id, loser_id, state 'applied'|'undone',
                  actor TEXT, proof JSON, moved JSON, audit_event_id NULL, undo_until BIGINT,
                  undone_at NULL, undone_by NULL, notice_state 'pending'|'sent'|'failed'|'skipped')
                 UNIQUE (loser_id) WHERE state = 'applied'
merge_proposals  (id PK, created_at, user_a, user_b, reason 'conflict'|'two-emails', state 'open'|'dismissed'|'merged',
                  evidence JSON, resolved_by NULL, resolved_at NULL, UNIQUE (user_a, user_b, reason))   -- pair stored in id order
merge_vetoes     (id PK, slack_binding_id, oidc_binding_id, created_by, created_at, merge_id,
                  UNIQUE (slack_binding_id, oidc_binding_id))
```
Ledger `moved` shape (ids and prior values, never a binding value):
```
{ "loser": {"id","kind","display_name","created_at"},
  "bindings": [{"id","from","to"}],
  "raised": [{"binding_id","from_state","to_state","verified_at"}],   -- states the merge itself raised
  "grants": [{"id","persona","from","to"}],
  "aliases_added": ["<old_id>"], "aliases_repointed": [{"old_id","from","to"}],
  "proof_binding_ids": {"slack","oidc"},                              -- the link the proof rested on (proof kind)
  "activated": [{"persona","role","source","entry","privileged"}],
  "inactive_privileged": [{"persona","role","entry"}] }
```
The ledger is the undo authority because `SLAUDE_AUDIT_RETENTION_DAYS` can purge audit rows; the `user.merged` audit event carries the same ids as the readable record (D14). The four new rc.21 tables join `NO_TENANT_TABLES`; unique keys, the partial unique index and CHECKs get tests on both dialects (the drift test sees columns only).

## Resolver API

`src/refs/actor.ts`:
```ts
interface ActingUser {
  userId: string;                 // live id, alias resolved
  slackBinding: { id: string; state: State };
  verified: boolean;              // slackBinding.state === "verified"
  emails: { address: string; verified: boolean }[];
}
actingUser(teamId, slackUserId, ctx?: { tx?: DbClient; fresh?: boolean }): Promise<ActingUser | null>
slackIdsFor(userId, teamId): Promise<string[]>
sameUser(a: ActorKey, b: ActorKey): Promise<boolean>     // Rule G
```
Read only, never creates (first sight does). Null means no binding yet: callers use the legacy string result for ordinary access. A per-process 5 s cache serves ordinary checks and is invalidated in process on link, unlink, merge, undo and grant change. Privileged checks pass `fresh: true` and read the database every time (D9). A database error throws `ActorResolveError`.

## Tasks

### rc.19: proof hardening, schema, shadow (legacy authoritative)

1. Hotfix: an email binding is verified only on proof.
   - Files: `src/gateway/panel/auth/oidc.ts` (return `emailProven: claims.email_verified === true` and the address only from the `email` claim, normalised by the slice A rule; keep the identity string for the roles file as is), `src/gateway/portal/auth-routes.ts:119`, `src/db/accounts.ts` (`upsertAccount` takes `emailProven`, stores `accounts.email_proven`), `src/db/account-projection.ts` (`projectLogin`: when proven, `adoptBinding` as today; when not proven or the identity is not an email, `ensureBinding` the email as `observed` and never move it from another user; a held verified binding is untouched), `tests/gateway/oidc.test.ts`, `tests/db/account-projection.test.ts`.
   - Tests first: claim absent, false, or true; `userClaim` set to a non-email claim (no email binding at all); a verified binding held by another user is never taken; a later login with proof raises observed to verified; email change deletes only a verified old binding of this user.
   - Note in the release: rc.18 has the exposure; it was data only.
2. Migration 0040.
   - Files: `src/db/migrations/0040_access_internal_ids.sql`, `src/db/drivers/sqlite.ts`, `tests/db/access-schema.test.ts`, drift test.
   - Tests first: upgrade from 0039 with existing grants, locks and accounts (new columns NULL or default); an older binary can still insert; `SLAUDE_DB=pg` too.
3. Link token single use.
   - Files: `src/db/link-token-uses.ts`, `src/gateway/portal/api.ts` (redeem inserts the `jti` with insert-or-ignore inside the link transaction; a second use returns the existing "link already used" 400), `src/gateway/portal/link-token.ts` header comment, `tests/gateway/portal-link.test.ts`.
   - Tests first: redeem, unlink, replay within the TTL is refused; two concurrent redeems of one token produce one link; expired rows purged by the reconciler.
4. Legacy readers ignore non-Slack subjects, and creation refuses them.
   - Files: `src/access/role.ts` (`usersWithRole`, `approversFor` return only ids matching the Slack user regex), `src/db/agent-grants.ts` (`create` unchanged for Slack subjects, a `subject` ref other than `slack:` is refused with "not supported until the access flip"), `src/gateway/panel/api.ts`, `src/persona/agent-def.ts` (email and user refs stay refused at compile, existing message), `tests/access/role.test.ts`, `tests/db/agent-grants.test.ts`.
   - Tests first: a row inserted by hand with `subject_id = 'email:a@example.com'` never appears in `usersWithRole`, `approversFor`, the approval allowlist or the panel approver list, and never makes the default chain empty.
5. Report and demote unproven email bindings.
   - Files: `src/domain/reconcile.ts` (new step), CLI `slaude domain reconcile --demote-unproven-emails [--apply]`, `tests/domain/reconcile.test.ts`.
   - Existing verified email bindings with `source = oidc-login` cannot be proven after the fact (`email_proven` did not exist). Default run only reports the count per issuer; `--apply` demotes them to observed, and the next login with proof raises them again. Safe to apply in rc.19 because nothing reads email bindings for access yet. Run the report on the live deployment and apply before task 8 is released.
6. Resolver `actingUser`, `slackIdsFor`, `sameUser` (Rules A to G inputs).
   - Files: `src/refs/actor.ts`, `src/db/domain.ts` read helpers, `tests/refs/actor.test.ts`.
   - Tests first: unknown id gives null; observed and verified; alias old id; the same U id in two workspaces is two users; `sameUser` same binding true, two verified bindings of one user true, observed plus verified false, two observed on one user false; cache invalidation; `fresh` bypasses the cache; database error throws. Metrics `slaude_actor_resolve_total{result}`, `slaude_actor_resolve_failures_total`.
7. Compile records references (Slack only in rc.19).
   - Files: `src/persona/agent-def.ts`, `agent-schema.ts` plus regenerated `docs/site/schemas/agent.schema.json`, `src/soul/data.ts` (optional `accessEntries`, default `[]`), `src/domain/sync-refs.ts`, `tests/persona`.
   - `slackId()` still returns the bare id; `accessEntries` additionally keeps each `slack:` reference with its workspace and the field, role, deny, dm-only and channel scope. Email and `user:` refs stay refused (defect 3). Tests first: golden comparison of the legacy arrays against the current compiler on the existing fixtures.
8. Grants carry a subject reference (Slack subjects only).
   - Files: `src/access/grants.ts` (`Grant.subject`, `deriveSoulGrants` also emits from `accessEntries`), `src/db/agent-grants.ts` (fills `subject_ref`, `subject_user_id` for Slack grants), tests.
9. Authority engine, golden table, parity.
   - Files: `src/access/authority.ts` (`admitInternal`, `roleInternal`, `usersWithRoleInternal`, `isDeniedInternal`), `tests/access/authority.test.ts`, `tests/access/golden-decision-table.test.ts`.
   - Golden table written first: identity x grants x context rows with `legacy`, `new` and an `intended` tag from a closed list (`email-grant-now-active`, `workspace-grant-team-checked`, `email-grant-pending`); any other difference fails. Identities: unseen; observed; verified with verified email; two Slack ids of one person (one verified, one observed); alias old id; same U id in another workspace; guest; declared-only email. Grants: soul manager by Slack, soul approver by email, channel-scoped approver, stored member by Slack and by email, deny by Slack and by email, trusted channel, dm-only, workspace grant for the right and for another team. Contexts: DM, channel, scoped channel, no channel.
   - Parity property test: random Slack-only worlds with one workspace, `new` equals `legacy` for admit, role and usersWithRole, no allowance list, fixed seed, 5000 cases.
10. Shadow seam.
    - Files: `src/access/decide.ts` (`decideAdmit`, `decideRole`, `decideApprovers`, `decideSame`, each taking a `site` id), `src/config/env.ts` (`SLAUDE_ACCESS_SOURCE=legacy|shadow|internal`, default `shadow`, read per call), `src/metrics.ts` (`slaude_access_shadow_total{site,outcome}`, `slaude_access_decision_total{source,site,result}`), `tests/access/decide.test.ts`.
    - `shadow`: legacy is returned; the new path runs inside a try; a mismatch is counted and logged once per (site, persona, reason) per minute with internal ids only; a new-path error counts `new_error` and never changes the answer. `legacy` calls no resolver.
11. Reconciler pass for grants, locks and the workspace report.
    - Files: `src/domain/reconcile.ts`, `tests/domain/reconcile.test.ts`.
    - Fill `subject_ref` and `subject_user_id` for Slack grants (single-workspace rule from slice B, otherwise skipped and counted). Fill `one_on_one_locks.team_id` for old rows when the tenant has one workspace. REPORT every stored workspace-kind grant whose `subject_id` is not a team in the tenant's `slack_apps`; the report must be clean (zero rows, or each row fixed or deleted by the operator) before the flip. Idempotent, advisory lock on pg, dry run lists counts, never writes a user for a bot or `USLACKBOT`.
12. Team plumbing.
    - Files: `src/db/one-on-one.ts` (`lock` stores `team_id`; `find` returns it), `src/access/role.ts` (`roleOf(persona, userId, channelId, teamId?)`, `isManagerOf`), `src/background/proposal-cards.ts:254` (take the team from the card payload or the click event instead of `teamId: null`), `src/knowledge/gated-dispatch.ts`, callers in `gateway.ts`, tests.
    - A lock row with `team_id` NULL is read as "the tenant's single workspace" and as unknown otherwise (decisions then use the legacy result). Tests first: a lock taken in one workspace is not owned by the same U id in another.
13. Wire group 1: gateway admission, roles, locks (`gateway.ts` sites in the map), through `decide.ts` (shadow). Tests first per site: with `legacy` existing tests pass unchanged; with `shadow` a seeded email grant for a linked user records `mismatch` with its tag while the decision stays legacy.
14. Wire group 2: approval and permission cards (`approval-gate.ts`, `permission-auth.ts`, `permission-gate.ts`). `canDecidePermission` uses `decideSame` for initiator and lock owner (Rule G), then the role. Old card rows with a bare Slack `initiator` still resolve.
15. Wire group 3: soul-field readers (`model-auth.ts`, `ingest-auth.ts`, `soul/overrides.ts` and `/soul` in `gateway.ts:3085-3121`, `per-persona.ts:147-159`, `surface-mcp.ts`, `mcp-tools.ts:580`). `canChangeModel` and `canTriggerIngest` become `decideRole`-based; the override self-lockout guard compares by `sameUser`.
16. Wire group 4: knowledge and memory (`gated-dispatch.ts`, `knowledge/mcp-tools.ts`, `knowledge/scope.ts`, `memory/scope.ts`, `proposal-cards.ts`). Lock-owner checks use `decideSame` (Rule G); `userSourceId` stays a Slack-id storage key (slice F).
17. Wire group 5: 1on1, remote, env, oauth home (`remote/active.ts`, `remote-command.ts`, `env-command.ts`, `oauth-home.ts`). `oauth-home` stays keyed by the Slack id; only the owner comparison moves.
18. Wire group 6: background and display (`scheduler.ts`, `digest.ts`, `rule-tool.ts`, `mandate/index.ts`, `settings-view.ts`, `my-agents.ts`), plus the registry and guard below.
    - Guard: `tests/access/no-string-authority.test.ts` scans ALL of `src` (not a file list) for `\.userId ===`, `=== userId`, `userId !== `, `locked_user`, `lockedUser (!|=)==`, `managers.includes`, `\.manager\.userId`, `backupManager\.userId`, `approvers.has`, `dmAllowedUsers`, `blockedUsers`, and fails on any hit not in a committed allowlist file (`tests/access/string-authority.allow.json`, entry per file and pattern with a reason: legacy branch in `decide.ts`, display, storage key, restriction). A new hit needs a reviewed allowlist line.
    - Site registry: `src/access/sites.ts` lists every site id; each increments `slaude_access_decision_total{site}`. `scripts/verify-access-sites.sh` reads `/metrics` and prints sites with a zero count; each needs a scripted smoke through the sim gateway (`tests/sim`) before the flip.
19. rc.19 release: `docs/site/_content/releases/v0.46.0-rc.19.md`, field note `domain-access-shadow`, CLAUDE.md index line. Deploy order: apply task 5 report on the live deployment first.
    - Gate before rc.20 (3 days or 200 admission decisions per active agent): mismatches zero except intended tags; `new_error` below 0.1 percent; every site id has a nonzero decision count or a passing scripted smoke; guard test green; workspace-grant report clean; task 5 demotion applied; link jti ledger live.

### rc.20: flip, then email grants

20. Flip and failure modes.
    - Files: `src/access/decide.ts`, `src/config/env.ts` (default `internal`; `SLAUDE_PRIVILEGED_NEEDS_VERIFIED`, default off), `tests/access/failure-modes.test.ts`, `admission.ts` and `role.ts` workspace grants now compare the team (D12, after the report).
    - `internal` returns the new result and still computes legacy (reverse shadow, outcome `legacy_disagrees`).
    - Failure modes, tests first: `actingUser` throws: ordinary admission uses the legacy string result for that call (a Slack deny still applies); every privileged answer (manager, approver, approver click, `/mcp connect` global, 1on1 override, heartbeat commands, kb-admin approval) is refused, never taken from legacy; counted as `source="fallback_legacy"` and `slaude_actor_resolve_failures_total`. `actingUser` returns null: legacy for ordinary; privileged refused only for `email:` and `user:` entries. Grants read failure: unchanged (soul-derived only). Privileged checks always read fresh (D9).
21. Approver and click paths on user ids (`approval-gate.ts`, `permission-auth.ts`). The allowlist becomes user ids plus `slackIdsFor`. A click with no resolvable user is refused. Tests first: an approver by email with a verified Slack binding can click; with an observed binding cannot; a denied clicker is refused whatever list names them.
22. Allow email and user references (only now). Files: `src/persona/agent-def.ts` and schema (lift the refusal for the access user fields), `src/db/agent-grants.ts` and the panel create API (`subject` ref, declared binding, `subject_ref`, `subject_user_id`), `src/web/console/lib/grants.ts` and the grants page (state shown: `active`, `pending: no verified email binding`, `pending: Slack binding not verified`). Same superadmin guard and audit. Tests first: an unlinked user gets nothing; after login with `email_verified` true and the portal link the same user is admitted.
23. rc.20 release.
    - Gate before rc.21 and prerequisite for the flip (all must hold): tasks 1, 3 and 4 shipped in rc.19; per-site decision counts above zero or scripted smoke per site; every missed site wired (tasks 13 to 18); workspace-grant report clean; guard test passing.
    - Rollback: `SLAUDE_ACCESS_SOURCE=shadow` (legacy authoritative again) is safe. Rollback to rc.19 is safe (legacy readers filter non-Slack subjects). Rollback to rc.18 is NOT safe once email grants exist: rc.18 `usersWithRole` returns `email:...` strings as approver ids and can leave an approval allowlist empty. Delete email grants and email refs from definitions before going below rc.19.

### rc.21: merge engine, notice, undo, console

24. Migration 0041 and tests (partial unique, pair uniqueness, upgrade).
25. Merge engine `src/domain/merge.ts`.
    - `mergeUsers({survivorId?, loserId, kind, actor, proof})` in one transaction. Resolve both ids through aliases (same record: idempotent no-op, return the ledger row). Lock both user rows in ascending id order (`FOR UPDATE` on pg, `BEGIN IMMEDIATE` on sqlite), re-resolve, re-read. REFUSE and write a proposal instead (every kind, console included, as in slice B's `adoptBinding`) when the loser holds ANY verified binding, when either record is a `bot` or `agent`, when two different verified emails would land on one record, or when a veto exists for the (Slack binding, oidc binding) pair. Survivor: the record holding the verified email, else the older, ties by id. Move bindings with compare-and-set (rows changed must equal rows read, else roll back to a savepoint), repoint `agent_grants.subject_user_id`, repoint aliases, add the loser alias, delete the loser, compute `activated` and `inactive_privileged` by diffing grants that reach the survivor before and after (stored rows by user id, soul `accessEntries` by resolving refs, Rules A and B with the Slack binding's state), record every state the merge raised in `raised`, write the ledger. After commit: audit `user.merged`, invalidate caches, queue the notice. A merge never raises a binding to verified except the proof path's own adopt (recorded in `raised`).
    - Tests first: merge twice is a no-op; A into B and B into A concurrently give one applied row; merge racing `adoptBinding`, link and unlink; a chain A to B to C resolves old ids; survivor rule; a verified loser gives a proposal; bot refused; veto honoured; savepoint rollback leaves no partial move; same on pg with two connections.
26. Route proof paths through the engine and detect conflicts.
    - Files: `src/db/domain.ts` (`adoptBinding` calls `mergeUsers` kind `proof` for the unverified-holder case, same signature), `src/db/account-projection.ts`, `src/domain/reconcile.ts` (conflicts write `merge_proposals`), `src/db/accounts.ts` (`linkSlackIdentity` refuses a vetoed pair). `SLAUDE_AUTO_MERGE=off` makes every automatic merge a proposal. Reasons are only `conflict` (same email, different verified Slack account in one workspace) and `two-emails`; aliases (`a+x@` against `a@`) are never merged and have no page.
27. The Slack notice. `src/domain/merge-notice.ts`. After commit, one DM to the person: what was linked (email masked to `a***@example.com`), how many grants became active, which privileged grants stay inactive and why (with a fresh portal link when the binding is unverified), and who to tell. When a privileged grant activates, also DM that persona's manager (D7). Single attempt: `notice_state` becomes `sent` or `failed`, failures are visible in the console and never revert the merge. No retries. Tests first: sent once per merge; no raw Slack id of another person and no unmasked email; a failed send keeps the merge.
28. Undo `src/domain/merge-undo.ts`.
    - Allowed while `applied` and before `undo_until` (D1). One transaction: lock the survivor, recreate the loser row with its original id from the ledger, move back each ledger binding and grant only when its current owner equals the ledger's `to` (anything changed since is left and listed as `skipped` with the reason), restore aliases, restore a binding's state only for entries in `raised` and only if it is still verified with the recorded `verified_at` (undo never lowers any other binding), and for a proof merge ALSO remove the `slack_identities` row for `proof_binding_ids` (link row only, the binding goes back to the loser) so the person is no longer linked to the account. Insert a veto keyed on (Slack binding id, oidc binding id of the account), not on an email binding; `linkSlackIdentity` refuses that pair until an operator lifts the veto. Set `undone`, audit `user.merge_undone` with moved and skipped ids, invalidate caches. A dry-run preview returns the same lists.
    - Limits stated in the console and release note: records and grants only (credentials and memory slices never moved); items changed after the merge are not reverted; past the window undo is refused; a merge that later merges chained onto must be undone later-first; a deleted account is not restored.
    - Tests first: round trip; post-merge unlink stays unlinked and is reported; replay of a link after undo is refused by the veto and by the jti ledger; past the window; chained; concurrent undo and merge.
29. Console API and pages (no alias page). `src/gateway/panel/api.ts`, `api-types.ts`, `domain-read.ts`, `src/web/console/pages/domain/` (Merges, Proposals). All routes behind `requireSuperadmin`, audited as operator, with the grant POST's origin protection: `GET /panel/api/merges`, `GET /panel/api/merges/:id`, `POST /panel/api/merges/:id/undo-preview`, `POST /panel/api/merges/:id/undo` (reason required), `GET /panel/api/merge-proposals`, `POST .../:id/approve`, `POST .../:id/dismiss`. Approve runs `mergeUsers` kind `console` with a typed confirmation listing the grants it would activate; it keeps the any-verified refusal and never raises a binding state (D5). A verified conflict is resolved by first unlinking or deleting the losing account (existing flows), then approving. Tests first: 403 and an audit refusal for non-superadmin, reason required, stale proposal refused, emails masked.
30. rc.21 release (release note, field note `domain-access-merging`, spec amendment, CLAUDE.md line). Gate: a merge and undo rehearsed on a restored backup copy; notice text and window signed off (D1, D7).

## Deferred (own later slice, after C is stable)

Workspace profile email trust is out of this plan: the `trustProfileEmail` setting and its `workspace_settings` table, the `users:read.email` scope and manifest change, the Slack profile eligibility check, the observed-joined-to-verified trust merge, its notice and the `joined_by` tracking. It starts only after rc.21 has soaked on a stable release, and it must be planned against Rules A, D and G (a trust-joined observed Slack binding gets ordinary access only, and is never the same person as a verified binding for identity checks). The spec text for it stays valid; nothing in C writes or reads it. Also cut from C: the alias candidates page, the `other-workspace` proposal reason, a `joinedBy` field on the resolver, and notice retries.

## Test strategy

- Parity: task 9's property test and the existing suites (`tests/access`, `tests/approval-gate.test.ts`, gateway tests) run with each `SLAUDE_ACCESS_SOURCE` value.
- Golden table is the specification of intended differences; a new difference needs a new tagged row.
- Concurrency (two connections on pg, two processes on one sqlite file): merge versus merge, link, unlink, undo and grant create; cache checked after invalidation; link replay.
- Failure injection: resolver throws, database read throws mid merge, notice send throws.
- Security: a declared or unproven email never grants; an observed Slack binding never counts as the lock owner or initiator of a verified one; non-Slack subjects never reach a legacy list; privileged flag on and off; undo by non-superadmin refused.
- Commands: `bun test`, `SLAUDE_DB=pg bun test`, `bun run typecheck`, `bun run test:web`.

## Rollout

Per RC: backup before the version bump (`sudo /usr/local/sbin/slaude-backup`), deploy through vps-hardening, `verify` 0 FAIL, Slack smoke with the sam agent (DM, channel, approval card click, `/1on1`), read the shadow metrics and the site-count script.

| RC | Changes | Behaviour change | Rollback |
|---|---|---|---|
| rc.19 | email proof hotfix, jti ledger, legacy readers filter, 0040, resolver, shadow, site wiring | email bindings verified only on proof; replayed links refused; nothing else | `SLAUDE_ACCESS_SOURCE=legacy`, or redeploy rc.18 (safe while no email grants exist) |
| rc.20 | flip, click paths, email and user refs allowed, console grant state | email grants work for verified users; workspace grants compare the team | `SLAUDE_ACCESS_SOURCE=shadow`; rc.19 safe; rc.18 unsafe once email grants exist |
| rc.21 | merge engine, notice, undo, console | automatic proof merges are logged, announced and undoable | `SLAUDE_AUTO_MERGE=off`, undo recent merges, or rc.20 |

Stable promotion waits 7 days on rc.21 with no unexplained mismatch (`scripts/promote-rc.sh`). The legacy path, shadow seam and flags are removed one stable release later.

Acceptance on the live deployment after rc.20: an `email:` member grant does nothing for an unlinked or unproven user; after a login with `email_verified` true and the portal link the same user is admitted and the audit shows source `internal`; a manager grant by email works only once the Slack binding is verified; unlinking removes access at once on privileged paths and within 5 s on ordinary ones.

## Decisions needed from the owner (recommended default first)

- D1 Undo window: 7 days (alternative 72 hours).
- D2 Direct `slack:user:` manager and approver entries: keep today's behaviour at the flip, report unverified privileged people, turn on `SLAUDE_PRIVILEGED_NEEDS_VERIFIED` when the count is accepted. Strict alternative: require the portal link from rc.20 (can lock out a manager who never linked).
- D5 Console merges: the any-verified refusal applies to every kind including console; the operator approves a typed list of grants; the merge never raises a binding state. A verified-versus-verified conflict is resolved by unlinking or deleting the losing account first. This reads the review's "keeps the any-verified refusal" strictly; the alternative is a console-only override for verified losers.
- D6 Aliases: never merged, no page in C; revisit later.
- D7 Notice: the person, plus the persona's manager when a privileged grant activates.
- D8 Two verified emails on one side: a proposal, never automatic.
- D9 No cache on privileged checks (a database read per privileged decision); 5 s cache for ordinary checks.
- D10 Resolver outage: ordinary falls back to legacy, privileged fails closed.
- D11 A deny applies from observed or verified bindings, never from declared.
- D12 Workspace grants compare the team, fixed at the flip, after the reconciler report is clean.
- D13 Audit actors and session initiators stay Slack ids until slice D.
- D14 The ledger, not the audit row, is the undo authority (retention can purge audit).
- D16 Hotfix demotion (task 5): apply `--demote-unproven-emails` to existing verified email bindings in rc.19 (default), versus leaving them until the person logs in again (they would stay "verified" without proof, so not recommended).

## Risks

- A site left on strings after the flip. Mitigation: the full-tree guard test, the site registry and per-site smoke, reverse shadow.
- A wrong merge grants someone else's access. Mitigation: merges only on proof, never with a verified loser, privileged needs the verified Slack binding, notice to the person and the manager, ledger, veto, `SLAUDE_AUTO_MERGE=off`.
- Undo cannot restore what changed after the merge; stated and reported per item.
- Emails verified before rc.19 were never proven (report then demote). Until the demotion is applied the exposure from rc.18 remains data only.
- An identity provider that omits `email_verified` leaves users unverified and email ACLs inert; the console shows pending state so it is visible, and the operator can fix the provider mapping.
- Lock rows without a team are read as the single workspace or unknown; a second workspace added before the backfill gets legacy results for old locks.
- Cross-replica staleness of ordinary checks (5 s), same as grants today.
- First-sight gap: an unseen actor gets the legacy result for ordinary access; the metric sizes it.
- Doubled computation during shadow; the new path adds one cached binding read per ordinary decision.
