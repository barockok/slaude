# 07: mandates view

## Purpose

A mandate is a read model, computed from what already exists (SOUL.md stays
authoritative): the soul's global mandate, each `## Channel` block, the
`## Proactive` heartbeat when enabled, and each active, unpaused cron job of
the persona. The agent detail page's `Mandates` tab must show exactly these,
with the approvers who can actually approve at runtime.

For the default persona, approvers are the soul's effective approvers for
the mandate's channel: the global list where the channel has no block of its
own; the block's approvers plus the manager and backup where it does. The
approval gate then narrows them by scope per request, which the API states as
`approverNote: "scope-matched per request"`. For a named persona, approvers
come from `approversFor` (channel aware, no scope matching).

Code: `src/mandate/index.ts` (`listMandates`), `src/soul/per-persona.ts`
(`effectiveSoulForChannelFor`, `withManagerApprover`),
`GET /panel/api/agents/:name`, `src/web/console/pages/agent/MandatesTab.tsx`.

## Setup

- Unit floor: `bun test tests/mandate/mandate.test.ts tests/panel/console-agents.test.ts`
- Environment B with the README B4 soul: global mandate
  `Answer questions from the team about the integration test environment.`,
  a `## Channel <#COPS>` block (mandate
  `Watch the ops channel and summarise incidents.`, approver `UOPSLEAD`), and
  `## Proactive` enabled (`Watch: tracker`, `Highest: ignore`).
- Signed in to the console as `lead`.

## Steps

1. Run the unit floor.
2. Create two crons as the manager in CTEAM:
   `say ADEFAULT UMGR CTEAM '/cron-add "0 9 * * 1" "weekly status digest for the team" channel'` and
   `say ADEFAULT UMGR CTEAM '/cron-add "0 10 * * 1" "paused job that must not be listed" channel'`;
   note both 8-character id prefixes from the replies. Pause the second:
   `say ADEFAULT UMGR CTEAM '/cron-pause <second prefix>'`.
3. `psqlq "SELECT id, persona_id, cron_expr, paused, active, channel_id, last_run_at, prompt FROM cron_jobs ORDER BY next_run_at;"`
4. `GET /panel/api/agents/default` (page context); keep `.mandates`.
5. Open `http://localhost:8080/panel/agents/default/mandates`. Screenshot at 1440 px and at 390 px.
6. Compare each mandate with its source:
   - global: `instructions` equals the `## Mandate` text of `$SLAUDE_HOME/SOUL.md`;
   - `channel:COPS`: `instructions` equals the `### Mandate` line of the `COPS` block;
   - `heartbeat`: derived from `## Proactive`;
   - each `cron:<id>`: matches a row of step 3 with `paused` false.
7. Approvers against who can approve: for each mandate, compare `approvers`
   with the rule in Purpose, then prove one live: start an approval in COPS
   (`say ADEFAULT UALICE COPS "[[mock:multi-tool n=1 tool=mcp__slaude_surface__request_approval args=$ARGS]] mandate approver check"`,
   `ARGS` from scenario 05) and click `Approve` as `UAPPR` (refused: not an
   approver in COPS), then as `UOPSLEAD` (decides).
8. `GET /panel/api/agents/scout`; keep `.mandates`. Open `/panel/agents/scout/mandates`.
9. Cleanup the crons (below), reload step 4.

## Expected observations

1. All pass.
2. Each `/cron-add` reply contains `cron job created` and `channel root`; the
   pause is confirmed.
3. Two rows for persona `default`; the second paused.
4. `mandates` has exactly four entries, in this order (the API's order):
   - `{ id: "global", kind: "global", title: "Global mandate", instructions: "Answer questions from the team about the integration test environment.", triggers: ["any admitted message"], approvers: ["UAPPR"], source: "soul", approverNote: "scope-matched per request" }`
   - `{ id: "channel:COPS", kind: "channel", title: "Mandate in <#COPS>", instructions: "Watch the ops channel and summarise incidents.", triggers: ["messages in <#COPS>"], approvers: ["UOPSLEAD", "UMGR", "UBACKUP"], source: "soul", channelId: "COPS", boundary: "channel:COPS", mode: "override", effective: "Watch the ops channel and summarise incidents." }`
   - `{ id: "heartbeat", kind: "heartbeat", title: "Heartbeat", instructions: "Watches: tracker. Highest action: ignore.", triggers: ["heartbeat round"], approvers: ["UAPPR"], source: "proactive" }`
   - `{ id: "cron:<id>", kind: "cron", title: "weekly status digest for the team", triggers: ["cron 0 9 * * 1"], approvers: ["UAPPR"], source: "cron", channelId: "CTEAM", schedule: "0 9 * * 1", lastRunAt: null }`
   The paused cron is absent.
5. Sections `Global`, `Channels`, `Heartbeat`, `Crons` with the hints
   `Applies to every admitted message.`,
   `Each channel block in the soul: it overrides, extends or reduces the global mandate in that channel.`,
   `What the agent watches on its own between messages.`,
   `Scheduled prompts that run on their own.`; source badges `Soul`, `Soul`,
   `Proactive`, `Cron`; the cron shows `Schedule` `0 9 * * 1` and `Last run`
   `Not run yet`; each card lists its approvers. No horizontal scroll at 390 px.
6. Every comparison matches.
7. The `approvers` lists match the rule; `UAPPR`'s click is refused with
   `:no_entry: <@UAPPR>, you are not on the approver allowlist for this plan. The plan stays pending.`,
   and `UOPSLEAD`'s click decides.
8. `scout` has no structured soul (filesystem persona), so it takes no
   global mandate and no heartbeat (its own SOUL.md has no `## Mandate` and no
   `## Proactive`), and inherits the default's channel blocks for approvers
   only, never their mandate text (`withAclFallback`,
   `inheritChannelApprovers` in `src/soul/per-persona.ts`). Expect exactly one
   entry: `{ id: "channel:COPS", kind: "channel", title: "Mandate in <#COPS>", instructions: "", inheritsGlobal: true, source: "soul", channelId: "COPS" }`
   whose `approvers` hold exactly `UOPSLEAD`, `UMGR` and `UBACKUP` in any order
   (`approversFor`: approver or manager in COPS), and no `approverNote` (named
   persona). The tab shows it with `Inherits the global mandate`.
9. The cron entry is gone after removal.

## Cleanup

`say ADEFAULT UMGR CTEAM '/cron-remove <first prefix>'` and
`say ADEFAULT UMGR CTEAM '/cron-remove <second prefix>'`.

## Notes

- The proactive heartbeat with `Highest: ignore` may log heartbeat rounds in
  `gateway.log`; it never posts. Rounds call the mock LLM untagged and get
  `mock: untagged request`, which is expected noise.
