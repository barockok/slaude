# 03: access for a named persona

## Purpose

Admission and roles are per persona. A named persona takes each access unit
(managers, channels, DM allowlist, blocked users, approvers) whole from its
own structured soul when it names any part of it, and whole from the default
persona otherwise. A persona with no structured soul at all (every filesystem
persona in phase 1, and a managed one whose `soul_json` carries only identity)
therefore admits exactly what the default persona admits. Stored grants are
keyed by persona name and apply to that persona only. Admin slash commands
(`/cron-*`, `/ignore`) and the `/1on1` manager check go through
`roleOf(persona, user, channel)`.

Code: `src/soul/per-persona.ts` (`soulDataFor`), `src/access/role.ts`
(`roleOf`, `approversFor`), `src/gateway/core/gateway.ts` (admission with
`dispatch.personaId`; `/cron-*` role check), the app-to-persona routing from
`slack_apps.persona_id`.

## Setup

- Unit floor:
  `bun test tests/soul/per-persona.test.ts tests/gateway/core/persona-admission.test.ts tests/access/role.test.ts tests/access/admission.test.ts`
- Environment B. The `scout` persona (README B4) is a filesystem persona with
  its own Slack app `ASCOUT` (bot user `USCOUT`) and a soul with an identity
  only. Confirm it is loaded: `grep 'multi-persona mode' "$IT/gateway.log"`
  lists `scout`. No stored grants: `psqlq "SELECT COUNT(*) FROM agent_grants;"` prints `0`.
- Signed in to the console as `lead`.

## Steps

1. Run the unit floor. Note in the evidence the test names that cover "own
   manager and channels" and "only identity in soul_json"
   (`bun test tests/access/admission.test.ts 2>&1 | grep -i persona` lists them).
2. `say ASCOUT UALICE CTEAM '[[mock:echo]] scout in trusted'`; poll its thread.
3. `say ASCOUT UBOB CRANDOM '[[mock:echo]] scout unlisted'`; wait 5 s; grep the gateway log for `persona=scout`.
4. `say ASCOUT UMGR CRANDOM '[[mock:echo]] scout manager unlisted'`; poll its thread.
5. `say ASCOUT UCAROL CTEAM '[[mock:echo]] scout blocked'`; wait 5 s; grep the log for `user=UCAROL`.
6. Open `http://localhost:8080/panel/agents/scout/access`. Screenshot.
7. As `lead` POST `{"subjectKind":"user","subjectId":"UBOB","role":"member"}` to
   `/panel/api/agents/scout/grants`.
8. `say ASCOUT UBOB CRANDOM '[[mock:echo]] scout granted'`; poll its thread.
9. `say ADEFAULT UBOB CRANDOM '[[mock:echo]] default not granted'`; wait 5 s; grep the log.
10. Admin command by the (inherited) manager:
    `say ASCOUT UMGR CTEAM '/cron-list'`; poll its thread.
11. Admin command by a member: `say ASCOUT UALICE CTEAM '/cron-list'`; poll its thread.
12. Admin command by the approver: `say ASCOUT UAPPR CTEAM '/cron-list'`; poll its thread.
13. `GET /panel/api/agents/scout` (page context) and keep `grants` from the answer.
14. Named persona with its own manager and channels, live: TODO, see Notes.

## Expected observations

1. All pass, `0 fail`.
2. A reply from `USCOUT` containing `[scout] ` and `scout in trusted` (scout
   inherits the default persona's trusted channels).
3. No reply; the log contains
   `[slack-rx] drop ch=CRANDOM user=UBOB persona=scout: not granted here`.
4. A reply containing `scout manager unlisted` (scout inherits the default manager `UMGR`).
5. No reply; the log contains `[slack-rx] drop ch=CTEAM user=UCAROL — blocked user`
   (scout inherits the default blocklist).
6. `Effective grants` lists the same soul rows as the default persona's
   Access tab, all with source `Soul`: manager `UMGR`, backup `UBACKUP`,
   approver `UAPPR`, the approvers scoped to `COPS` (`UOPSLEAD`, plus the
   manager and backup), member channels `CTEAM`, `COPS` and `CPUB`, DM-only
   member `UDAVE`, deny `UCAROL`.
7. `201`, the grant has `"source":"console"`.
8. A reply containing `[scout] ` and `scout granted`.
9. No reply; `drop ch=CRANDOM user=UBOB persona=default: not granted here`
   (the grant is on `scout` only).
10. A reply from `USCOUT` that is not a `:no_entry:` refusal (the cron list, or
    a line saying there are no cron jobs).
11. The reply `:no_entry: only manager or approver can list cron jobs`.
12. Not a refusal (an approver may list crons).
13. `grants` contains the soul rows of step 6 plus the console row for `UBOB`.
14. BLOCKED unless the TODO is resolved.

## Cleanup

Revoke the `scout` grant for `UBOB` (Access tab of `scout`, or
`DELETE /panel/api/agents/scout/grants/<id>`). `psqlq "SELECT COUNT(*) FROM agent_grants;"` prints `0`.

## Notes

- TODO (step 14): a live check of a named persona whose structured soul names
  its own manager and channels needs a managed tenant (`personas.soul_json`).
  A tenant becomes managed only through a personas-as-code sync, and
  `/deploy` exists only in the gateway role (`SLAUDE_ROLE=gateway`, which also
  needs Redis, node workers and a Postgres brain); the panel's
  `POST /panel/api/personas` answers 409 `tenant 'default' is not managed as
  code yet` on an unsynced tenant. The sync's soul extraction can be served
  from the soul cache (pre-seed it as in README B4 for each persona's soul
  text), which makes it work with the mock LLM. Until someone writes and runs
  that recipe, this case rests on `tests/gateway/core/persona-admission.test.ts`
  (a persona `alpha` with its own manager `UALPHAMGR` and channel `C0ALPHA`
  is admitted in its own channel and dropped elsewhere, and answers admin
  commands from its own manager only) and `tests/soul/per-persona.test.ts`.
- `/soul trust|allow|dm|block` changes only the default persona's soul
  (`soul_overrides` has no persona column). Do not use it to tune `scout`.
