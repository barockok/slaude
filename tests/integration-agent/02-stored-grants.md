# 02: stored grants

## Purpose

Stored grants (`agent_grants`, `source=console`) refine what the soul admits:
a `member` grant lets a user chat where the soul does not; a `dm_only` member
grant admits in a DM only; a `deny` drops the user even in a trusted channel
(`blocked_user`); an expired grant is ignored (filtered at read time); a
`workspace` grant admits everyone. Grant changes through the console API are
superadmin only and audited as `grant.created` and `grant.revoked`; an
operator gets `403` and the refusal is audited.

Code: `src/db/agent-grants.ts`, `src/access/role.ts` (`loadGrants`, cache of
5 s, invalidated in process on create and revoke), `src/access/admission.ts`,
`src/gateway/panel/api.ts` (`POST /panel/api/agents/:name/grants`,
`DELETE /panel/api/agents/:name/grants/:id`, `GET /panel/api/grants`).

## Setup

- Unit floor: `bun test tests/db/agent-grants.test.ts tests/access/role.test.ts tests/panel/console-agents.test.ts`
- Environment A with the helpers (`grant`, `sim_run`, `NOW`), table empty.
- Environment B, signed in to the console as the superadmin `lead`
  (README, "Signing in"). Table empty: `psqlq "SELECT COUNT(*) FROM agent_grants;"` prints `0`.

## Steps

Environment A (sim ids; persona `default`):

1. Run the unit floor.
2. Member grant in an unlisted channel:
   `grant it-member-bob user U0BOB member 0 0 && sim_run 02-member-grant-unlisted.yaml`
3. Negative control: `sqlite3 "$SLAUDE_DB_PATH" "DELETE FROM agent_grants;" && sim_run 02-member-grant-unlisted.yaml`
4. dm-only grant:
   `grant it-dmonly-bob user U0BOB member 0 1 && sim_run 02-dm-only-grant-dm.yaml && sim_run 02-dm-only-grant-channel.yaml`
5. Deny beats a trusted channel:
   `sqlite3 "$SLAUDE_DB_PATH" "DELETE FROM agent_grants;" && grant it-deny-alice user U0ALICE member 1 0 && sim_run 02-deny-trusted.yaml`
6. Expired grant ignored:
   `sqlite3 "$SLAUDE_DB_PATH" "DELETE FROM agent_grants;" && grant it-expired-bob user U0BOB member 0 0 "$NOW-3600000" && sim_run 02-expired-grant.yaml`
7. Workspace grant:
   `sqlite3 "$SLAUDE_DB_PATH" "DELETE FROM agent_grants;" && grant it-workspace workspace T0SIM member 0 0 && sim_run 02-workspace-grant.yaml`
8. `sqlite3 "$SLAUDE_DB_PATH" "DELETE FROM agent_grants;"`

Environment B, through the console UI (superadmin `lead`):

9. Before the grant: `say ADEFAULT UBOB CRANDOM '[[mock:echo]] grants before'`; wait 5 s; grep the gateway log for `drop ch=CRANDOM user=UBOB`.
10. In the browser open `http://localhost:8080/panel/agents/default/access`.
    Take a screenshot.
11. Click `Add grant`. In the dialog: `Subject kind` = `user`, `Slack id` =
    `UBOB`, `Role` = `member`, leave `Deny` and `Direct messages only`
    unchecked, `Note` = `integration test`. Click the dialog's `Add grant`
    button. Screenshot.
12. `say ADEFAULT UBOB CRANDOM '[[mock:echo]] grants after'`, poll its thread for up to 30 s.
13. `psqlq "SELECT persona, subject_kind, subject_id, role, deny, dm_only, created_by, note FROM agent_grants;"`
14. `psqlq "SELECT action, actor_kind, actor_id, target_kind, summary, details->>'subjectId', details->>'operatorRole' FROM audit_events WHERE action='grant.created' ORDER BY id DESC LIMIT 1;"`
15. In the Access tab, click `Revoke` on the `UBOB` row, then `Revoke` in the
    `Revoke grant?` confirmation. Screenshot.
16. `psqlq "SELECT COUNT(*) FROM agent_grants;"` and
    `psqlq "SELECT action, actor_id, summary FROM audit_events WHERE action='grant.revoked' ORDER BY id DESC LIMIT 1;"`
17. `say ADEFAULT UBOB CRANDOM '[[mock:echo]] grants revoked'`; wait 5 s; grep the log.

Environment B, through the API (page context, see README):

18. As `lead`, POST a dm-only grant:
    `{"subjectKind":"user","subjectId":"UBOB","role":"member","dmOnly":true}` to
    `/panel/api/agents/default/grants`. Then
    `say ADEFAULT UBOB DUBOB '[[mock:echo]] dm only in dm'` and
    `say ADEFAULT UBOB CRANDOM '[[mock:echo]] dm only in channel'`.
19. As `lead`, POST a deny for Alice: `{"subjectKind":"user","subjectId":"UALICE","role":"member","deny":true}`.
    Then `say ADEFAULT UALICE CTEAM '[[mock:echo]] denied in trusted'`; wait 5 s; grep the log.
20. As `lead`, POST a grant for `UDAVE` (DM-allowlisted, not admitted in channels) that expires in 20 s:
    `{"subjectKind":"user","subjectId":"UDAVE","role":"member","expiresAt": <now ms + 20000>}`
    (in the page: `Date.now() + 20000`). Immediately
    `say ADEFAULT UDAVE CRANDOM '[[mock:echo]] before expiry'`; wait 30 s;
    `say ADEFAULT UDAVE CRANDOM '[[mock:echo]] after expiry'`; grep the log for `user=UDAVE`.
21. Validation: POST `{"subjectKind":"channel","subjectId":"CRANDOM","role":"manager"}`, and
    POST `{"subjectKind":"user","subjectId":"not-an-id","role":"member"}`, and
    POST `{"subjectKind":"user","subjectId":"UBOB","role":"member","expiresAt":1}`.
22. Sign out, sign in as the operator `alice`. Open `/panel/agents/default/access`. Screenshot.
23. As `alice`, POST `{"subjectKind":"user","subjectId":"UBOB","role":"member"}` to
    `/panel/api/agents/default/grants`, and DELETE
    `/panel/api/agents/default/grants/<id of any grant from GET /panel/api/agents/default/grants>`.
24. `psqlq "SELECT action, actor_id, decision, details->>'panelAction' FROM audit_events WHERE actor_id='alice@example.com' ORDER BY id DESC LIMIT 2;"`
25. As `alice`, GET `/panel/api/grants`.

## Expected observations

1. All pass.
2. `✓ .../02-member-grant-unlisted.yaml` (U0BOB gets `ack: done` in C0RANDOM).
3. `✗ .../02-member-grant-unlisted.yaml` with `expect_reply contains "ack: done" - no match`
   and the line `drop ch=C0RANDOM user=U0BOB persona=default: not granted here`
   (proves step 2 passed because of the grant).
4. Both pass: admitted in the DM, dropped in C0RANDOM with reason `whitelist`.
5. Passes; output contains `[slack-rx] drop ch=C0TEAM user=U0ALICE — blocked user`.
6. Passes; output contains `drop ch=C0RANDOM user=U0BOB persona=default: not granted here`.
7. Passes (reply `ack: done`).
8. Table empty.
9. Dropped: `drop ch=CRANDOM user=UBOB persona=default: not granted here`.
10. Heading `Effective grants`, caption `Changes apply on this gateway immediately and on other replicas within a few seconds.`,
    a primary button `Add grant`; rows with source `Soul` for the soul's
    manager, backup, approvers, channels, DM allowlist and the blocked user
    (`Deny` badge on `UCAROL`).
11. Toast `Grant added` with description `Added ... on default.`; a new row for
    `UBOB` with the `Console` badge, `Created by` `lead@example.com`.
12. A reply containing `[default] ` and `grants after` (no restart needed: the
    create invalidated the in-process grant cache).
13. One row: `default | user | UBOB | member | f | f | lead@example.com | integration test`.
14. `grant.created | operator | lead@example.com | grant | member for user UBOB | UBOB | superadmin`.
15. Toast `Grant revoked`; the row is gone.
16. `0`; then `grant.revoked | lead@example.com | revoked member for user UBOB`.
17. Dropped again (`not granted here`).
18. POST answers `201` with `{ "grant": { "source": "console", ..., "dmOnly": true } }`;
    the DM gets a reply containing `dm only in dm`; the channel message is
    dropped with `drop ch=CRANDOM user=UBOB persona=default: not granted here`.
19. `201`; then the log contains `[slack-rx] drop ch=CTEAM user=UALICE — blocked user`
    (a stored deny beats the trusted channel `CTEAM`).
20. `201`; the first message gets a reply containing `before expiry`; the second is dropped
    (`drop ch=CRANDOM user=UDAVE persona=default: not granted here`): expiry is
    filtered at read time and the cache lives 5 s, so 30 s is enough.
21. Each answers `400` with an `error`: the first
    `a channel subject can only be granted member, not manager`; the second
    `a user subject_id must be a Slack user id (U or W followed by uppercase letters and digits), got "not-an-id"`
    (the API trims but does not upper-case; only the console dialog upper-cases
    what is typed); the third `expiresAt must be in the future`.
22. The Access tab shows the grants; no `Add grant` button and no `Revoke`
    buttons; caption `You can view grants. Ask a superadmin to add or revoke one.`
23. Both answer `403` with
    `{"error":"action 'grant.create' requires the superadmin role","required":"superadmin"}`
    and `{"error":"action 'grant.revoke' requires the superadmin role","required":"superadmin"}`;
    `agent_grants` is unchanged.
24. Two rows: `panel.grant.revoke | alice@example.com | refused | grant.revoke` and
    `panel.grant.create | alice@example.com | refused | grant.create`.
25. `200` with `{ "grants": [...] }` (reads are open to operators).

## Cleanup

- A: `sqlite3 "$SLAUDE_DB_PATH" "DELETE FROM agent_grants;"`.
- B: as `lead`, revoke every console grant created here (Access tab or
  `DELETE /panel/api/agents/default/grants/<id>`), then
  `psqlq "SELECT COUNT(*) FROM agent_grants;"` prints `0`. Audit rows stay
  (append-only by design).

## Notes

- The sim ids (`U0BOB` etc.) are the sim's own; environment B uses the README
  placeholders.
