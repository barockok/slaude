# 01: admission parity with no stored grants

## Purpose

With no rows in `agent_grants`, admission must behave exactly as before the
agent platform work (`channelModeAdmits` plus the blocklist): a trusted or
allowed channel admits anyone; an unlisted channel and a DM admit only the
manager and the backup manager, plus the DM allowlist in a DM; an approver
alone is not admitted to chat; a blocked user is dropped everywhere with
reason `blocked_user`; every other drop has reason `whitelist`.

Code: `src/access/admission.ts` (`admit`), `src/gateway/core/gateway.ts`
(`preTurnDropReason`). The drop log lines are:

- `[slack-rx] drop ch=<channel> user=<user> persona=<persona>: not granted here`
  (reason `whitelist`; a ` (no manager set in SOUL.md)` suffix when the
  persona has no manager);
- `[slack-rx] drop ch=<channel> user=<user> — blocked user` (reason `blocked_user`).

Each drop increments `slaude_slack_drops_total{reason="<reason>"}`.

## Setup

- Unit floor: `cd "$REPO" && bun test tests/access/admission.test.ts tests/gateway/core/persona-admission.test.ts`
- Environment A (README, "A. Sim gateway"), including the bootstrap and the
  helpers. Confirm the table is empty:
  `sqlite3 "$SLAUDE_DB_PATH" "SELECT COUNT(*) FROM agent_grants;"` prints `0`.
- Environment B (README, "B. Dev stack") for the blocked-user and
  allowlist steps against the real soul. Confirm
  `psqlq "SELECT COUNT(*) FROM agent_grants;"` prints `0`.

## Steps

Environment A (sim fixed ids; the sim soul has manager `U0MGR`, backup
`U0BACKUP`, approver `U0APP`, trusted `C0TEAM`, allowed `C0PUB`, no DM
allowlist):

1. `bun test tests/access/admission.test.ts tests/gateway/core/persona-admission.test.ts`
2. `sim_run 01-trusted-member.yaml` (U0ALICE in trusted C0TEAM)
3. `sim_run 01-allowed-member.yaml` (U0ALICE in allowed C0PUB)
4. `sim_run 01-unlisted-outsider.yaml` (U0BOB in unlisted C0RANDOM)
5. `sim_run 01-unlisted-manager.yaml` (U0MGR in C0RANDOM)
6. `sim_run 01-unlisted-approver.yaml` (U0APP in C0RANDOM)
7. `sim_run 01-dm-manager.yaml` and `sim_run 01-dm-backup.yaml`
8. `sim_run 01-dm-member-no-allowlist.yaml` (U0ALICE DMs, not on the allowlist)
9. `sim_run 01-dm-approver.yaml` (U0APP DMs)
10. `sim_run 01-dm-member-allowlisted.yaml` (the transcript's own soul puts U0ALICE on the DM allowlist)

Environment B (default persona through app `ADEFAULT`; soul in README B4):

11. `say ADEFAULT UALICE CTEAM '[[mock:echo]] parity trusted'`, then poll
    `thread CTEAM <ts>` (the `ts` from the `say` answer).
12. `say ADEFAULT UBOB CPUB '[[mock:echo]] parity allowed'`, then poll its thread.
13. `say ADEFAULT UBOB CRANDOM '[[mock:echo]] parity unlisted'`; wait 5 s; `thread CRANDOM <ts>`;
    `grep 'drop ch=CRANDOM user=UBOB' "$IT/gateway.log"`.
14. `say ADEFAULT UMGR CRANDOM '[[mock:echo]] parity manager unlisted'`, then poll.
15. `say ADEFAULT UAPPR CRANDOM '[[mock:echo]] parity approver unlisted'`; wait 5 s; grep the log for `user=UAPPR`.
16. `say ADEFAULT UDAVE DUDAVE '[[mock:echo]] parity dm allowlist'`, then poll `msgs DUDAVE`.
17. `say ADEFAULT UALICE DUALICE '[[mock:echo]] parity dm member'`; wait 5 s; `msgs DUALICE`; grep the log for `drop ch=DUALICE`.
18. `say ADEFAULT UCAROL CTEAM '[[mock:echo]] parity blocked'`; wait 5 s; grep the log for `user=UCAROL`.
19. `curl -fsS $GW/metrics | grep slaude_slack_drops_total`

## Expected observations

1. Both files pass, `0 fail`.
2. `✓ tests/integration-agent/sim/01-trusted-member.yaml`, `1/1 transcripts passed`.
3. Same for `01-allowed-member.yaml`.
4. Passes; the output contains
   `[slack-rx] drop ch=C0RANDOM user=U0BOB persona=default: not granted here`.
5. Passes (the stub replied `ack: done`).
6. Passes; output contains `drop ch=C0RANDOM user=U0APP persona=default: not granted here`.
7. Both pass.
8. Passes; output contains `drop ch=D0SIM user=U0ALICE persona=default: not granted here`.
9. Passes; output contains `drop ch=D0SIM user=U0APP persona=default: not granted here`.
10. Passes (reply `ack: done`).
11. Within 30 s the thread holds a reply from `UAGENT` whose text contains
    `[default] ` and `parity trusted`.
12. A reply containing `[default] ` and `parity allowed`.
13. No reply in the thread; the log contains
    `[slack-rx] drop ch=CRANDOM user=UBOB persona=default: not granted here`.
14. A reply containing `parity manager unlisted`.
15. No reply; the log contains `drop ch=CRANDOM user=UAPPR persona=default: not granted here`.
16. A reply in `DUDAVE` containing `parity dm allowlist`.
17. No reply in `DUALICE`; the log contains `drop ch=DUALICE user=UALICE persona=default: not granted here`.
18. No reply; the log contains `[slack-rx] drop ch=CTEAM user=UCAROL — blocked user`
    (blocked beats the trusted channel).
19. `slaude_slack_drops_total{reason="whitelist"}` is at least 3 and
    `slaude_slack_drops_total{reason="blocked_user"}` is at least 1.

## Cleanup

Nothing was written to `agent_grants`. In A, `sim_reset` before the next
scenario. In B, leave the stack running for the next scenario.

## Notes

- The sim has no blocked-user field in its soul fixture
  (`src/gateway/sim/soul-fixture.ts`), so the soul blocklist is checked in B
  only; a stored deny (which uses the same `blocked_user` path) is checked in
  the sim in scenario 02.
- A message the gateway admits can still produce no reply when the mock LLM
  is down or the CLI fails; in B, check `$IT/mock-llm.log` and
  `GET http://127.0.0.1:9092/__mock/journal` before calling an admitted step
  FAIL. A dropped message never reaches the mock: its journal has no entry
  with that text.
