# Domain access, slice C: authority on internal ids

> For Claude: use superpowers:executing-plans, task by task. One task per commit. A release boundary is a hard stop: soak, check the gate, then continue.

Goal: admission, roles, approval and the 1on1 lock decide by internal user id instead of by Slack id string, so `email:` in an ACL works through the portal link, records merge on proof, and a wrong merge can be undone. Delivered as four releases (rc.19 to rc.22) so that no release both changes who is trusted and is the first to run the new code.

Architecture: one pure decision module `src/access/authority.ts` computes admit, role and approvers from effective grants plus a resolved acting user. A thin seam `src/access/decide.ts` runs the legacy string path and the new path, returns whichever `SLAUDE_ACCESS_SOURCE` names, and logs and counts every disagreement. rc.19 ships the seam with the legacy path authoritative. rc.20 flips it. rc.21 adds the merge engine, notice, undo and console. rc.22 adds the opt-in workspace email trust. Every migration is additive and nullable, so an older binary keeps working on the new schema (rollback is a redeploy or an env change).

Spec: `docs/superpowers/specs/2026-11-12-domain-model-and-references.md` (slice C, Users and bindings, Merging, Creation on reference). Builds on slice B (`docs/plans/2026-11-14-domain-records-slice-b.md`, shipped in rc.18): `src/db/domain.ts` (`adoptBinding`, `user_aliases`, `resolveUserId`), `src/refs/resolve.ts`, `src/db/account-projection.ts`, `src/domain/{reconcile,first-sight,sync-refs}.ts`, `src/db/domain-read.ts`.

## What the code does today (the map)

Authority is decided on raw Slack id strings in these places. Each is a task input; none may be missed, because a site left on strings after the flip silently ignores an email grant or a merge.

Decision core (pure, all string equality on `subjectId === userId`):
- `src/access/admission.ts` `admit()`: deny, manager, DM needs member, channel needs channel grant or stored member or "workspace" grant. Note `g.subjectKind === "workspace"` ignores `subjectId` and the event's team, so any workspace grant admits everyone in every workspace. This is a latent bug; the new path compares the team (an intended difference, see D12).
- `src/access/role.ts` `roleFromGrants`, `isDenied`, `usersWithRole`, `loadGrants` (5 s cache, soul-only on read failure), `approversFor`, `roleOf`.
- `src/access/grants.ts` `deriveSoulGrants`: soul fields (manager, backupManager, approvers, channelOverrides, trusted and allowed channels, dmAllowedUsers, blockedUsers) are bare Slack id strings. `src/persona/agent-def.ts` `slackId()` strips a `slack:` reference to its id (dropping the workspace) and refuses every other scheme ("cannot be resolved yet").
- `src/access/permission-auth.ts` `canDecidePermission`: `clicker === initiator`, `clicker === lockOwner`, then roleOf. Callers: `src/gateway/slack/permission-gate.ts` `mayDecide` (initiator comes from the stored gate payload, a Slack id).

Callers that hold a Slack id and ask the core:
- `src/gateway/core/gateway.ts`: `preTurnDropReason` admission (about line 4212, after `observeSlackUser`), `isManagerOf` (line 851, used by the brain gate, 1on1 lock, `/mcp connect`, heartbeat commands), cron slash role (3342), `proposalManagers` (961), 1on1 lock compares `locked_user !== userId` (2065, 3039, 1223 runAs vs lock), `userId !== managerId` and `userId !== soul.manager.userId` (2932, 2943, 3085), `backgroundManagers` (916), `usersWithRole` for managers (1636).
- `src/gateway/slack/approval-gate.ts`: `#resolveApprovers` builds a `Set<string>` of Slack ids, click handler tests membership and `isDenied` (177, 321 to 329).
- `src/gateway/slack/mcp-tools.ts` `isManagerOrApprover` (580), `src/gateway/core/surface-mcp.ts` (175, `who !== soul.manager.userId`), `src/gateway/core/env-command.ts` (289, owner or manager), `src/background/proposal-cards.ts` (248, `managers.includes(by)`), `src/background/scheduler.ts` `personaManager` (528), `src/background/digest.ts` (recipient), `src/proactive/rule-tool.ts` (66), `src/mandate/index.ts` (approvers shown in the prompt), `src/gateway/panel/settings-view.ts` and `src/gateway/portal/my-agents.ts` (display of who holds what).
- Stored grants: `src/db/agent-grants.ts` (`subject_kind` user, channel, workspace; `subject_id` validated as a Slack id by regex), panel API `src/gateway/panel/api.ts` (createGrantSchema, POST and DELETE under superadmin), console `src/web/console/lib/grants.ts`.
- Identity link: `src/gateway/portal/link-token.ts` (ephemeral signed link, team bound), `src/gateway/portal/api.ts` (redeem, calls `linkSlackIdentity`), `src/db/accounts.ts` (`slack_identities` PK (team, slack user); `projectLink` adopts the Slack binding onto the account's user). OIDC login runs `projectLogin` (verified email binding via `adoptBinding`).
- Credentials: `src/agent/credential-owner.ts` `runAs` is `user:<slackUserId>`; `src/gateway/api/mcp-credentials.ts` and `src/agent/mcp-oauth/persist.ts` map it to an account through `accountForSlackUser(team, id)`. Credentials belong to an account, not a user record, so a user merge in this slice moves none (that is slice F).
- Audit actor ids and session initiators stay Slack ids (rows are never rewritten; sessions are slice D). C adds the resolved user id only to the new access and merge events.

Things that already help: slice B records observed users at first sight (`observeSlackUser` runs before admission), `ensureBinding` is race safe, `adoptBinding` does the unverified-holder merge, the reconciler runs at boot under an advisory lock.

## Model decisions (the rules the code must implement)

Binding strength, stated once. A Slack binding is `verified` only through the delivered portal link. An email binding is `verified` only through an OIDC login. A binding the gateway saw is `observed`. A binding named in a definition is `declared`.

- Rule A (authority). The acting user is the user holding the Slack binding for (team, slack user id). Ordinary access (member, deny, channel and workspace grants, dm) flows from every grant that names any binding of that user, in the allowed states below. Privileged access (manager, approver) flows only when the acting Slack binding is `verified`, and, for an `email:` entry, when that email binding is `verified` too.
- Rule B (what each entry needs). `slack:user:T/U` entry: the acting Slack binding matches, any state (the gateway verified Slack's signature; this is today's behaviour). `email:x` entry: the email binding must be `verified` and held by the acting user. `user:<id>` entry: the acting user equals it (after alias resolution). A `declared` binding never matches anything.
- Rule C (deny wins, and applies early). A deny entry applies when it names any binding of the acting user in state observed or verified, and a Slack deny applies even when the binding is only observed. A resolver failure never removes a deny.
- Rule D (privileged needs the portal). A privileged entry written as `email:` or `user:` needs a verified Slack binding on the acting user (the person has done the portal link). A privileged entry written as a direct `slack:user:` reference keeps today's behaviour until the flag `SLAUDE_PRIVILEGED_NEEDS_VERIFIED` is turned on (D2). Merges never make a privileged grant active on their own except by the proof path, which is the case where the Slack binding is verified by construction.
- Rule E (workspace trust is ordinary only). A user joined to an email record by `trustProfileEmail` keeps an observed Slack binding. Rule A therefore gives that person ordinary access only, and manager and approver stay inactive until the portal link verifies the binding. No special flag is needed: the weaker binding state is the whole mechanism.
- Rule F (outputs need Slack ids). `usersWithRole` and approver lists are used to notify and to match clicks. The new path returns user ids, and a reverse lookup (`slackIdsFor(userId, teamId)`) yields the Slack ids to DM. An approver with no Slack binding in the workspace cannot be notified or click; that is listed in the console as "pending".

## Schema

Migration 0040, `0040_access_internal_ids.sql` (on both dialects, mirror in `drivers/sqlite.ts`):

```
agent_grants   ADD subject_ref     TEXT NULL     -- canonical ref as written: slack:user:T0EXAMPLE/U0EXAMPLE, email:a@example.com, user:<id>
               ADD subject_user_id TEXT NULL     -- users.id, filled by the reconciler and at create; alias resolved at read
CREATE INDEX idx_agent_grants_subject_user ON agent_grants (subject_user_id)
```
`subject_kind` and `subject_id` stay and stay authoritative in rc.19. For a non-Slack entry `subject_id` holds the canonical ref string (an old binary sees an id that never matches, so a rollback only loses the email grants, and never widens). The create validator (`SUBJECT_ID_RE`) accepts the new shapes only through the new `subject` field.

Migration 0041, `0041_user_merges.sql`:

```
user_merges      (id PK, created_at, kind 'proof'|'profile-email'|'console'|'alias',
                  survivor_id, loser_id, state 'applied'|'undone', actor TEXT,   -- actor: 'system' or an operator id
                  proof JSON,          -- which proof: {slackBinding, emailBinding, via}
                  moved JSON,          -- the ledger, shape below
                  audit_event_id NULL, undo_until BIGINT, undone_at NULL, undone_by NULL,
                  notified_at NULL, notice_state 'pending'|'sent'|'failed'|'skipped')
                 UNIQUE (loser_id) WHERE state = 'applied'
merge_proposals  (id PK, created_at, user_a, user_b, reason 'conflict'|'two-emails'|'alias'|'other-workspace',
                  state 'open'|'dismissed'|'merged', evidence JSON, resolved_by NULL, resolved_at NULL,
                  UNIQUE (min(user_a,user_b), max(user_a,user_b), reason))   -- store the ordered pair in two columns
merge_vetoes     (id PK, slack_binding_id, email_binding_id, created_by, created_at, merge_id,
                  UNIQUE (slack_binding_id, email_binding_id))
```
`moved` ledger shape (ids and prior values, never a binding value such as an email or Slack id):
```
{ "loser": {"id","kind","display_name","created_at"},
  "bindings": [{"id","from","to","state","verified_at"}],
  "grants":   [{"id","persona","from","to"}],
  "aliases_added": ["<old_id>"],
  "aliases_repointed": [{"old_id","from","to"}],
  "activated": [{"persona","role","source":"soul|console","entry":"<field or grant id>","privileged":false,"pending_verification":false}],
  "inactive_privileged": [{"persona","role","entry"}] }
```
The audit event `user.merged` carries the same ids as `details` plus `merge_id`. The ledger is the undo authority, because `SLAUDE_AUDIT_RETENTION_DAYS` can purge audit rows; the audit event is the human record (D14).

Migration 0042, `0042_workspace_settings.sql`: `workspace_settings (team_id PK, trust_profile_email BOOLEAN NOT NULL DEFAULT false, updated_at, updated_by)`. Deployment-global (add all four new tables to `NO_TENANT_TABLES`; the drift test sees columns only, so unique keys, the partial unique index and CHECKs get their own test on both dialects, like slice B). Declared where: a table edited from the console and `slaude workspace set <T0EXAMPLE> --trust-profile-email on|off`, every change audited (D3). There is no workspace definition file today; the spec's "workspace definition" is this record until one exists.

## Resolver API

`src/refs/actor.ts`:

```ts
interface ActingUser {
  userId: string;            // live id, alias resolved
  slackBinding: { id: string; state: State };
  verified: boolean;         // slackBinding.state === "verified"
  emails: { address: string; verified: boolean }[];  // the user's email bindings
  joinedBy: "self" | "proof" | "profile-email" | "console";   // how this Slack binding reached its user, from the ledger
}
actingUser(teamId: string, slackUserId: string, ctx?: { tx?: DbClient }): Promise<ActingUser | null>
slackIdsFor(userId: string, teamId: string): Promise<string[]>
sameUser(a: ActorKey, b: ActorKey): Promise<boolean>   // two Slack ids (or a user id) are one person
```
Read only: it never creates (first sight does that), returns null when the Slack id has no binding yet (callers fall back to the legacy string path, which is what an unseen user is today). A per-process cache of 5 s (same as the grants cache), invalidated in process on link, unlink, merge, undo and grant change, so another replica lags by at most 5 s (D9). A DB error throws `ActorResolveError`; the seam decides what to do (failure modes below).

## Tasks, in order

### rc.19: schema, resolver, shadow (legacy stays authoritative)

1. Migration 0040 to 0042 and the sqlite mirror.
   - Files: `src/db/migrations/0040_access_internal_ids.sql`, `0041_user_merges.sql`, `0042_workspace_settings.sql`, `src/db/drivers/sqlite.ts`, `tests/db/schema-drift.test.ts` (no-tenant allowlist), new `tests/db/access-schema.test.ts`.
   - Tests first: unique keys (merge_proposals pair, merge_vetoes pair), the partial unique `user_merges(loser_id) WHERE state='applied'`, upgrade from a database at 0039 with existing agent_grants rows (new columns NULL, rows unchanged), old-binary compatibility (insert without the new columns).
   - Run: `bun test tests/db`, `SLAUDE_DB=pg bun test tests/db`, `bun run typecheck`.

2. Resolver `actingUser`, `slackIdsFor`, `sameUser`.
   - Files: `src/refs/actor.ts`, `src/db/domain.ts` (read helpers: `bindingsOfUser`, `emailsOfUser`), `tests/refs/actor.test.ts`.
   - Tests first: unknown id gives null; observed, verified and joined states; alias old id resolves to survivor; two workspaces with the same U id are two users; cache hit, in-process invalidation after `adoptBinding`; DB error throws `ActorResolveError`.
   - Metrics in `src/metrics.ts`: `slaude_actor_resolve_total{result}`, `slaude_actor_resolve_failures_total`.

3. Compile keeps references (access fields only).
   - Files: `src/persona/agent-def.ts`, `src/persona/agent-schema.ts` plus regenerated `docs/site/schemas/agent.schema.json`, `src/soul/data.ts` (new optional `accessEntries`, default `[]`), `src/domain/sync-refs.ts`, tests in `tests/persona`.
   - `slackId()` keeps returning the bare Slack id for `slack:` references (the legacy arrays are unchanged, so legacy behaviour is identical), and additionally records every user and channel reference in `accessEntries: {field, role, deny, dmOnly, channel?, ref: <canonical string>}[]`. `email:` and `user:` references are accepted in the user fields (manager, backupManager, approvers, dm, blocked) and produce an entry only (no legacy id, so the legacy path ignores them). Other schemes (`whatsapp:`, `telegram:`) and selectors stay refused with the existing message. A bare id keeps its one-release warning.
   - Tests first: an email approver compiles and warns nothing; the legacy arrays equal the pre-change output for a Slack-only fixture (golden comparison against the current compiler on the existing fixtures); a `slack:user:T0EXAMPLE/U0EXAMPLE` keeps its workspace in `accessEntries` and drops it in the legacy array; the JSON Schema drift test.

4. Grants carry a subject reference.
   - Files: `src/access/grants.ts` (`Grant.subject?: {ref: string; userId?: string}`; `deriveSoulGrants` also emits from `accessEntries`), `src/db/agent-grants.ts` (`create` accepts `subject` ref, stores `subject_ref`, ensures a `declared` binding and sets `subject_user_id` in the same transaction; `subject_id` rules unchanged for Slack subjects), `src/gateway/panel/api.ts` createGrantSchema (`subject` alternative to `subjectKind`+`subjectId`, same superadmin guard and audit), `tests/db/agent-grants.test.ts`, `tests/access/grants.test.ts`.
   - Tests first: creating `email:a@example.com` as member stores the ref and a declared email binding; the legacy reader (`listForPersona` as today) returns it with `subjectId` equal to the ref and never matches a Slack id; a manager grant by email is stored but flagged pending in the view.

5. The pure authority engine and the golden table.
   - Files: `src/access/authority.ts` (`admitInternal`, `roleInternal`, `usersWithRoleInternal`, `isDeniedInternal`, all taking `{grants, actor: ActingUser | null, teamId, channelId, isDM}` and implementing Rules A to F), `tests/access/authority.test.ts`, `tests/access/golden-decision-table.test.ts`.
   - Golden table (written before the engine): a data file of rows `identity x grants x context -> {legacy, new, intended?}`. Identities: unseen Slack id; observed only; verified with a verified email; verified Slack id and a second Slack id of the same person unlinked; observed Slack id joined by profile email; old alias id; same Slack id in another workspace; guest; declared-only email. Grants: soul manager by Slack, soul approver by email, soul channel-scoped approver, stored member by Slack, stored member by email, deny by Slack, deny by email, trusted channel, dm-only, workspace grant for the same and another team. Contexts: DM, channel, channel with scoped approvers, no channel. Rows where new differs from legacy must carry an `intended` tag from a closed list (`email-grant-now-active`, `workspace-grant-team-checked`, `email-grant-pending`, `joined-ordinary-only`); any other difference fails the test.
   - Parity property test: generate random Slack-only grants and Slack-only actors (no email, no merge, one workspace); `new` must equal `legacy` for admit, role and usersWithRole, with no allowance list. Fixed seed plus 5000 cases.

6. The shadow seam.
   - Files: `src/access/decide.ts` (`decideAdmit`, `decideRole`, `decideApprovers`, `decideSame`), `src/config/env.ts` (`SLAUDE_ACCESS_SOURCE=legacy|shadow|internal`, default `shadow` in rc.19; read on every call so a restart is enough to change it), `src/metrics.ts` (`slaude_access_shadow_total{site,outcome=match|mismatch|new_error}`, `slaude_access_decision_total{source,site,result}`), `tests/access/decide.test.ts`.
   - Behaviour in `shadow`: compute legacy (authoritative, returned), compute new inside a try, compare, count, and on mismatch log one line per (site, persona, reason) per minute, naming persona, site, legacy and new result and the intended-difference tag if it matches one, never a Slack id (use the internal id, or `unseen`). A new-path error counts `new_error` and never changes the answer. `legacy` skips the new path entirely.
   - Tests first: legacy returned on mismatch; error in the new path is invisible to the caller; log rate limit; `legacy` calls no resolver (spy).

7. Wire the seam into every decision site (shadow only, behaviour unchanged).
   - Files: `src/gateway/core/gateway.ts` (admission at the `admit` call, `isManagerOf`, cron role, 1on1 compares, manager compares, `proposalManagers`, `backgroundManagers`), `src/gateway/slack/approval-gate.ts`, `src/access/permission-auth.ts`, `src/gateway/slack/mcp-tools.ts`, `src/gateway/core/surface-mcp.ts`, `src/gateway/core/env-command.ts`, `src/background/{proposal-cards,scheduler,digest}.ts`, `src/proactive/rule-tool.ts`, `src/mandate/index.ts`, `src/gateway/panel/settings-view.ts`, `src/gateway/portal/my-agents.ts`. One commit per file group.
   - Rule: no site may read `soul.manager.userId` or a grant `subjectId` to decide authority after this task. `rg "subjectId ===|=== userId|userId ===|\.includes\(by\)" src` is added to the PR checklist and the remaining hits must be display or legacy-branch only. A new lint-style test `tests/access/no-string-authority.test.ts` greps the listed files for the banned patterns and fails on a new one.
   - Tests first per site: with `legacy` source the existing tests pass unchanged; with `shadow` the same tests pass and a seeded email grant for a linked user records `mismatch` with tag `email-grant-now-active` while the decision stays legacy.
   - Pre-admission: admission must still run `observeSlackUser` first (already so). Add a metric for actors with no binding yet (`unseen`), to size the first-sight gap.

8. Reconciler pass for grants.
   - Files: `src/domain/reconcile.ts` (new source `grants`: for each stored grant without `subject_user_id`, build `subject_ref` from the legacy pair using the tenant's single workspace rule from slice B, ensure the declared binding, set both columns; report counts and skipped rows), `src/cli/` domain command report formatting, `tests/domain/reconcile.test.ts`.
   - Tests first: idempotent on rerun; two runners race (advisory lock on pg); a grant whose workspace cannot be decided (two workspaces) is skipped and counted; a workspace-kind grant is left alone; a rolling deploy row written without the columns is picked up on the next run.
   - Dry run: `slaude domain reconcile --dry-run` lists would-set counts. Never writes a user for a bot or `USLACKBOT`.

9. rc.19 release.
   - Files: `docs/site/_content/releases/v0.46.0-rc.19.md`, field note `docs/site/_content/field-notes/2026-11-14-domain-access-shadow.md`, CLAUDE.md index line.
   - Gate before rc.20 (checked on the live deployment after at least 3 days or 200 admission decisions per active agent): `slaude_access_shadow_total{outcome="mismatch"}` is zero except intended tags; `new_error` rate below 0.1 percent; the unseen-actor count explained (first-sight lag only). Every unexplained mismatch is a bug in the new path and is fixed first, never allow-listed.

### rc.20: flip (new path authoritative, legacy kept as reverse shadow)

10. Flip and failure modes.
    - Files: `src/access/decide.ts`, `src/config/env.ts` (default `internal`; `SLAUDE_PRIVILEGED_NEEDS_VERIFIED`, default off), `tests/access/failure-modes.test.ts`.
    - `internal`: the new result is returned and the legacy result is still computed and compared (reverse shadow: outcome `legacy_disagrees`, same log and metric), so the old path stays a tripwire for one more RC.
    - Failure modes (written as tests first):
      - `actingUser` throws (database or resolver down): ordinary admission falls back to the legacy string result for that call (a Slack-id grant is the same authority, and a Slack deny still applies); every privileged answer (`manager`, `approver`, approver click, `/mcp connect` global, 1on1 override, heartbeat commands) is refused, not taken from legacy. A manager therefore can chat in a DM they hold a grant for but cannot run manager commands during the outage. Counted in `slaude_access_decision_total{source="fallback_legacy"}` and `slaude_actor_resolve_failures_total`; one log line a minute.
      - `actingUser` returns null (never seen): same as an unseen user today: legacy string result for ordinary, privileged refused only when the entry is an `email:` or `user:` entry; a direct `slack:` privileged entry keeps matching (Rule D, flag off).
      - Grants read failure: unchanged (soul-derived only), plus the email entries compiled in the soul still resolve.
      - Cache: a stale actor entry may live 5 s after a merge or unlink on another replica (D9).
    - Privileged rule: with `SLAUDE_PRIVILEGED_NEEDS_VERIFIED=1`, direct `slack:` manager and approver entries also need a verified Slack binding. The reconciler report lists how many privileged principals are unverified, so the owner can see the lockout before turning it on.

11. Approver and click paths on user ids.
    - Files: `src/gateway/slack/approval-gate.ts`, `src/access/permission-auth.ts`, `src/gateway/slack/permission-gate.ts`, `tests/approval-gate.test.ts`, `tests/access/permission-auth.test.ts`.
    - The allowlist becomes a set of user ids plus the Slack ids to DM (`slackIdsFor`). A click resolves the clicker once and compares user ids; `initiator` and `lockOwner` (stored Slack ids) resolve through `sameUser`, so a person who links a second Slack account mid-turn is still the initiator only if both bindings are on one user. A click by someone with no resolvable user is refused with the existing no-permission message, never by falling to a string compare.
    - Tests first: approver by email with a verified Slack binding can click; the same approver with an observed binding (profile-joined) cannot; denied clicker is refused whatever list names them; old card rows with `initiator` as a bare Slack id still resolve.

12. Console and API: email subject on grants, pending state visible.
    - Files: `src/gateway/panel/console-views.ts`, `src/gateway/panel/api.ts`, `src/web/console/lib/grants.ts`, the agent grants page under `src/web/console/pages/agent`, `tests/panel-web` spec, `tests/panel`.
    - A grant row shows its resolved state: `active`, `pending: no verified email binding yet`, `pending: Slack binding not verified (portal link needed)`. The create form accepts `email:` or `slack:user:` text; the server canonicalises it with `parseRef`. Same superadmin guard and audit as today.

13. rc.20 release (same file set as task 9, `docs/site/_content/releases/v0.46.0-rc.20.md`, field note, CLAUDE.md line).
    - Gate before rc.21: reverse-shadow `legacy_disagrees` only at intended tags for 3 days; the acceptance check below passes on the live deployment.

### rc.21: merge engine, notice, undo, console

14. Merge engine.
    - Files: `src/domain/merge.ts`, `src/db/domain.ts` (`moveBindings`, `moveGrants` helpers that return the rows read), `tests/domain/merge.test.ts`, `tests/domain/merge-concurrency.test.ts`.
    - `mergeUsers({survivorId?, loserId, kind, actor, proof})` runs in one transaction. Order: resolve both ids through aliases (same record means idempotent no-op, return the existing ledger row); lock both user rows in ascending id order (`SELECT ... FOR UPDATE` on pg, `BEGIN IMMEDIATE` on sqlite), then re-resolve and re-read; refuse (return a proposal instead) when either is `bot` or `agent`, when each side holds a verified Slack binding in one workspace, when two different verified emails land on one record, when a veto exists for the (Slack binding, email binding) pair, or for kind `alias`/`console`-unconfirmed; choose the survivor (the one holding a verified email, else the older `created_at`, ties by id); move bindings with a compare-and-set (rows changed must equal rows read, else roll back to a savepoint and report a conflict); repoint `agent_grants.subject_user_id`; repoint existing aliases; insert the alias for the loser; delete the loser row; compute `activated` and `inactive_privileged` by diffing the grants that reach the survivor before and after (stored rows by user id, soul `accessEntries` by resolving their refs, Rules A and B applied to the Slack binding's state); write the `user_merges` row with the ledger. After commit: audit `user.merged`, invalidate the actor and grant caches, queue the notice.
    - Tests first: merge twice is a no-op; A into B and B into A concurrently yield exactly one applied row and one survivor; merge racing `adoptBinding`, link and unlink; three-way chain A to B to C resolves old ids through two aliases; survivor rule (verified email wins, else older); two verified emails produce a proposal, not a merge; a bot record is refused; a veto blocks an automatic kind; a savepoint rollback leaves no partial move; the same tests on `SLAUDE_DB=pg` with two connections.

15. Route the existing proof paths through the engine and detect conflicts.
    - Files: `src/db/domain.ts` (`adoptBinding` keeps its signature and calls `mergeUsers` kind `proof` for the unverified-holder case), `src/db/account-projection.ts`, `src/domain/reconcile.ts` (conflicts now write `merge_proposals` instead of only a report line), `tests/db/domain.test.ts`, `tests/domain/reconcile.test.ts`.
    - Same email with a different verified Slack account in the same workspace, two accounts with one email, and two verified emails on one side create one `merge_proposals` row per pair (idempotent on the unique pair); aliases (`a+x@` and `a@`, dotted variants) are surfaced as `reason=alias` suggestions only, never merged. `SLAUDE_AUTO_MERGE=off` makes every automatic kind create a proposal instead (the rollback switch).
    - Tests first: existing adopt tests unchanged; the ledger row exists for an adopt; the proposal row is created once across reruns.

16. The Slack notice.
    - Files: `src/domain/merge-notice.ts`, `src/gateway/slack/` send helper (reuse the app-bound client the onboarding nudge uses, `src/gateway/portal/onboarding-nudge.ts`), `tests/domain/merge-notice.test.ts`.
    - After commit, DM the person (the Slack user whose binding moved) from the app of that workspace: what was linked (the email masked to `a***@example.com`, the workspace name), how many grants became active, whether any manager or approver grant stays inactive and why (it names the portal link step and delivers a fresh link when the binding is still unverified), and who to tell if wrong ("ask your administrator to undo merge `<short id>`"). It never contains another person's address. Failure sets `notice_state=failed`, is retried at the next sight of the user (at most 3 times, 24 h apart), and never blocks or reverts the merge.
    - Tests first: sent once per merge (rerun does not resend); text contains no raw Slack id of another user and no unmasked email; failed send does not change the merge; a privileged grant left inactive is mentioned.

17. Undo.
    - Files: `src/domain/merge-undo.ts`, `tests/domain/merge-undo.test.ts`.
    - Allowed while `state=applied` and `now < undo_until` (D1: 7 days). In one transaction: lock the survivor, recreate the loser user row with its original id and fields from the ledger, move back each ledger binding and grant only if its current owner still equals the ledger's `to` (compare-and-set per item; anything changed since, such as a binding unlinked, a grant revoked, or a grant created after the merge, is left and listed as `skipped` with the reason), remove the loser alias, restore repointed aliases, insert a `merge_vetoes` row for the (Slack binding, email binding) pair so the proof path cannot redo it silently, set `state=undone`, `undone_at`, `undone_by`, write audit `user.merge_undone` with the moved and skipped ids, invalidate caches, notify the person. Preview (`dry run`) returns the same lists without writing.
    - Limits, stated in the console and the release note: undo restores records and grants only; credentials and memory slices never moved in C so there is nothing to give back; sessions and audit rows were never rewritten; items changed after the merge are not reverted; after the window the console can still start a new console merge or a veto but not undo; a deleted account cannot be restored; undoing a merge that other merges chained onto is refused until the later merge is undone (order matters).
    - Tests first: round trip leaves bindings, grants and aliases as before for the moved items; a post-merge unlink stays unlinked and is reported skipped; the veto stops a repeat; past the window refused; chained merge refused; concurrent undo and merge of the same pair yields one result.

18. Console API and pages.
    - Files: `src/gateway/panel/api.ts` (routes below), `src/gateway/panel/api-types.ts`, `src/db/domain-read.ts` (list helpers, emails masked as slice B does), `src/web/console/pages/domain/` (Merges, Proposals, Aliases, Workspaces), `tests/panel`, `tests/panel-web`.
    - Routes, all behind `requireSuperadmin` with a new audited action name and an operator actor, and the same CSRF and origin protection the grant POST uses: `GET /panel/api/merges`, `GET /panel/api/merges/:id`, `POST /panel/api/merges/:id/undo-preview`, `POST /panel/api/merges/:id/undo` (body: reason, required), `GET /panel/api/merge-proposals?state`, `POST /panel/api/merge-proposals/:id/approve` (typed confirmation lists the grants it would activate, including privileged ones), `POST /panel/api/merge-proposals/:id/dismiss`, `GET /panel/api/alias-candidates`, `PUT /panel/api/workspaces/:team/settings` (trustProfileEmail, audited, effective for new sights only).
    - The console is for exceptions: the Users page links to its merge history; the Merges page defaults to "undoable now"; nothing here is needed for the normal path. Approving a proposal runs `mergeUsers` kind `console`.
    - Tests first: non-superadmin gets 403 and an audit refusal; undo needs a reason; approve is refused if the proposal's pair changed since it was loaded (version check); emails masked in every answer.

19. rc.21 release (release note, field note `domain-access-merging`, CLAUDE.md line, spec amendment marking slice C partial).
    - Gate before rc.22: a rehearsed merge and undo on a restored backup copy; `slaude domain reconcile --dry-run` shows no new conflicts; undo window and notice text signed off by the owner (D1, D7).

### rc.22: opt-in workspace email trust

20. Slack profile read and eligibility.
    - Files: `src/gateway/slack/profile-email.ts`, `src/cli/manifest.ts` (add `users:read.email`), `src/db/workspace-settings.ts`, a CLI command `slaude workspace set`, `tests/gateway/profile-email.test.ts`.
    - `users.info` for the new user in a workspace with `trust_profile_email` on. Eligible only when: the user is a full member (not `is_restricted`, `is_ultra_restricted`, `is_bot`, `is_stranger`), the user's `team_id` equals the workspace, `profile.email` is present and normalises with the slice A rule, and the workspace confirms the email (`is_email_confirmed`). Anything else counts a reason (`guest`, `external`, `unconfirmed`, `no_email`, `scope_missing`) and merges nothing. The call is rate limited and cached, runs off the hot path (first sight queue), and a failure only logs.
    - Tests first with a recorded `users.info` fixture per ineligible case.

21. Trust merge.
    - Files: `src/domain/trust-merge.ts` (called from first sight after the record exists), `src/domain/first-sight.ts`, `tests/domain/trust-merge.test.ts`.
    - If a `verified` email binding holds that address, call `mergeUsers` kind `profile-email` (survivor: the email's user). The Slack binding stays `observed`. If no verified record holds the address, do nothing (a declared email record is not enough: Rule B). If another verified Slack account in this workspace already holds that email's user, create a proposal (`conflict`), never merge.
    - Tests first: after the merge an ordinary email grant is active and a manager email grant is listed in `inactive_privileged`; completing the portal link then flips the Slack binding to verified and the privileged grant becomes active with no second merge; setting the workspace off stops new merges and does not undo old ones; guests, externals and aliases (`a+x@` against `a@`) never merge; a Slack admin changing a profile email later does not re-merge (the merge happens once per Slack binding and veto survives).

22. rc.22 release: release note, field note `domain-access-trust`, `docs/site` note for the new Slack scope (the app needs reinstall in a workspace that opts in; a workspace that does not opt in needs nothing), spec amendment (slice C done), CLAUDE.md line.

## Test strategy (summary)

- Parity: the property test in task 5 and the unchanged existing suites (`tests/access`, `tests/approval-gate.test.ts`, the gateway tests) run once with each `SLAUDE_ACCESS_SOURCE` value. Legacy and internal must give the same result for every Slack-only world.
- Golden table: the committed decision table is the specification of intended differences. A new row is needed to add a difference.
- Concurrency: two replicas (two connections on pg, two processes against one file on sqlite) racing merge, merge-merge, merge-link, merge-undo, grant create against merge; caches checked after invalidation.
- Failure injection: resolver throws, DB read throws in the middle of a merge (savepoint), Slack notice throws, `users.info` rate limit.
- Security tests: a declared email never grants; a profile-joined user never gets manager or approver; a veto stops automatic repeats; privileged flag on and off; undo by a non-superadmin refused; the notice never leaks another address.
- Commands: `bun test`, `SLAUDE_DB=pg bun test`, `bun run typecheck`, `bun run test:web` for the console pages.

## Rollout

Per RC: back up before the version bump (`sudo /usr/local/sbin/slaude-backup`), deploy through vps-hardening, `verify` 0 FAIL, Slack smoke with the sam agent (DM, channel, approval card click, `/1on1`), read the reconcile and shadow metrics.

| RC | Changes | Behaviour change | Rollback |
|---|---|---|---|
| rc.19 | 0040 to 0042, resolver, compile keeps refs, shadow seam, reconcile grants | none (legacy authoritative); email refs compile but grant nothing | set `SLAUDE_ACCESS_SOURCE=legacy`, or redeploy rc.18 (columns are nullable, extra tables unused) |
| rc.20 | flip to internal, approver and click paths, console shows grant state | email ACL entries start to work for verified users; workspace grants compare the team; privileged-by-email needs verified Slack | `SLAUDE_ACCESS_SOURCE=shadow` (legacy authoritative again), restart |
| rc.21 | merge engine, ledger, notice, undo, console | automatic merges on proof now notify and are undoable; conflicts become proposals | `SLAUDE_AUTO_MERGE=off` (proposals only), undo each recent merge from the console, or redeploy rc.20 |
| rc.22 | profile email trust, scope, workspace setting | only in a workspace that opts in | turn the setting off (no new merges); undo the merges it made |

Stable promotion of the whole slice waits for 7 days of rc.22 with no unexplained mismatch, then `scripts/promote-rc.sh`. The legacy path, the shadow seam and the flags are removed in a later cleanup task after one stable release, not in this slice.

Acceptance on the live deployment after rc.20 (owner and one test person): an `email:` member grant for a test address does nothing for an unlinked Slack user; after login and the delivered portal link the same user is admitted, the audit shows the decision source `internal`, and a manager grant by email works only after the link; unlinking removes the access within 5 s on every replica.

## Decisions needed from the owner (recommended default first)

- D1 Undo window. Default 7 days from the merge, after which only the ledger and veto remain. Alternative 72 hours.
- D2 Privileged grants by direct `slack:user:` reference. Default: keep today's behaviour at the flip and report the count of unverified privileged principals; the owner turns on `SLAUDE_PRIVILEGED_NEEDS_VERIFIED` when the count is zero or accepted. Strict alternative: require the portal link for every manager and approver from rc.20, which can lock out a manager who never linked.
- D3 Where `trustProfileEmail` is declared. Default: the `workspace_settings` table with a console toggle and `slaude workspace set`, audited. Alternative: a workspace section in a definition file (needs a new definition surface, so later).
- D4 Slack scope `users:read.email`. Default: add it to the generated manifest and request it only for a workspace that opts in; that workspace reinstalls the app. Without it the setting reports `scope_missing`.
- D5 Console-approved merges and privileged grants. Default: the operator's explicit confirmation (the typed list of grants) counts as proof and activates everything, including manager and approver, but Rule A still needs the Slack binding verified, so an observed binding stays ordinary until the person links.
- D6 Alias candidates (`a+x@` against `a@`, dotted variants). Default: suggestions on the Aliases page only, merge by explicit click.
- D7 Who is told. Default: the person only, plus the audit event. Alternative: also the agent's manager for a merge that activates a privileged grant.
- D8 Survivor with two verified emails. Default: not automatic; a proposal. (Spec survivor rule applies once a human approves.)
- D9 Cross-replica staleness. Default 5 s for the actor and grants caches. Alternative: no cache on privileged checks (one query per privileged decision).
- D10 Failure policy. Default as in task 10: ordinary falls back to legacy, privileged fails closed. Alternative: fail closed for everything during a resolver outage (stops chat for everyone).
- D11 Email deny from a non-verified state. Default: a deny applies from observed or verified bindings, never from declared. 
- D12 Workspace grants compare the team. Default: fix at the flip (intended difference, single-workspace deployments see no change). Alternative: keep the old behaviour behind a flag.
- D13 Audit actor ids. Default: leave audit rows and session initiators as Slack ids in C (slice D adds the keys), put the user id only in access and merge events.
- D14 Ledger versus audit retention. Default: the ledger is the undo authority and is never purged; the audit event is the readable record. The spec text says undo uses the audit list; this changes the source but not the behaviour.
- D15 Trust-merged people. Default: the notice says what was linked and that manager rights need the portal link; no extra approval step by the manager.

## Risks

- A site still comparing strings after the flip. Mitigation: task 7's inventory, the banned-pattern test, and the reverse shadow in rc.20.
- A wrong merge grants a person someone else's access. Mitigation: automatic merges only on proof or on the opt-in ordinary-only trust, privileged needs a verified Slack binding, the notice, the ledger, undo with veto, `SLAUDE_AUTO_MERGE=off`.
- Undo cannot restore what changed after the merge. Mitigation: per-item compare-and-set with a visible skipped list; the window is short; the limits are in the console text.
- The profile email is controlled by a workspace admin. Mitigation: opt-in per workspace, off by default, full members of that workspace only, ordinary access only, a Slack Connect or guest user never qualifies.
- Merge during a login or link race. Mitigation: ordered row locks, re-read after lock, compare-and-set moves, concurrency tests on both dialects (a sqlite test uses two connections to one file).
- Resolver cache lag lets a revoked person act for up to 5 s on another replica. Same exposure as the grants cache today; D9 offers the stricter option for privileged calls.
- First-sight gap: a user acting before the first-sight write lands has no record. The seam treats null as unseen and uses the legacy result for ordinary access; the metric sizes it.
- Slack scope reinstall friction for the opt-in workspace. Mitigation: documented, only that workspace is affected.
- The audit retention purge can remove the readable merge record. Mitigation: the ledger table.
- Doubled work during shadow (two computations per decision). The new path costs one cached binding read per actor; measure the p99 of admission before the flip and cap with the 5 s cache.
