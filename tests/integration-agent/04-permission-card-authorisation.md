# 04: who may decide a tool permission card

## Purpose

A tool permission card (`:lock: *Approval needed* — \`<tool>\``, buttons
`Allow once`, `Always allow`, `Deny`) may be decided only by the person who
started the turn (the initiator), the thread's `/1on1` lock owner, or an
approver or manager of the persona (channel aware). Anyone else gets the
ephemeral text `Only the person who asked or an approver can decide this.`,
the `pending_gates` row stays `pending`, and a `gate.permission.refused`
audit row is written. The initiator is stamped into the row when the card is
created, from the senders of the inputs the turn is processing, so a
bystander who posts in the thread after the card appeared does not become the
initiator. A turn with no human initiator (cron, panel, heartbeat) needs an
approver or a manager.

Code: `src/access/permission-auth.ts` (`canDecidePermission`),
`src/gateway/slack/permission-gate.ts` (`PERM_REFUSED_TEXT`, `mayDecide`,
`stampFromSenders`, action ids `slaude_perm:<allow|always|deny>:<toolUseId>`),
`src/audit/emit.ts` (`auditGateRow`).

## Setup

- Unit floor:
  `bun test tests/access/permission-auth.test.ts tests/permission-gate.test.ts tests/gateway/core/turn-origin.test.ts`
- Environment B. Bash is not auto-allowed: `SLAUDE_AUTO_ALLOW_TOOLS` must be
  unset in the gateway's environment (`echo "${SLAUDE_AUTO_ALLOW_TOOLS:-unset}"`
  in the shell that started it prints `unset`).
- No stored grants (`psqlq "SELECT COUNT(*) FROM agent_grants;"` prints `0`).
- Clear the fake's call log so `ephemerals` shows only this scenario:
  `curl -fsS -X DELETE "$F/calls"`.

## Steps

Requester decides, bystander refused:

1. Run the unit floor.
2. `say ADEFAULT UALICE CTEAM '[[mock:multi-tool n=1 tool=Bash]] permission check one'`; note the
   `ts` as `T1`. Poll `thread CTEAM $T1` until a message from `UAGENT` has
   blocks with an `actions` element; note its `ts` as `CARD1` and the action
   ids (`slaude_perm:allow:<id>` etc.).
3. `psqlq "SELECT id, status, payload->>'initiator', payload->>'toolName' FROM pending_gates WHERE kind='perm' ORDER BY created_at DESC LIMIT 1;"`
4. Bystander posts in the thread after the card appeared:
   `say ADEFAULT UBOB CTEAM 'I will approve that' "$T1"`.
5. Bystander clicks: `click ADEFAULT UBOB CTEAM "$CARD1" 'slaude_perm:allow:<id>'`; wait 2 s.
6. `ephemerals`
7. Repeat step 3.
8. `psqlq "SELECT action, actor_id, decision, target_kind, target_id, summary, details::text FROM audit_events WHERE action='gate.permission.refused' ORDER BY id DESC LIMIT 1;"`
9. Requester clicks: `click ADEFAULT UALICE CTEAM "$CARD1" 'slaude_perm:allow:<id>'`; poll `thread CTEAM $T1`.
10. Repeat step 3, and
    `psqlq "SELECT action, actor_id, decision, summary FROM audit_events WHERE action='gate.permission.decided' ORDER BY id DESC LIMIT 1;"`

Approver and manager decide another person's card:

11. `say ADEFAULT UALICE CTEAM '[[mock:multi-tool n=1 tool=Bash]] permission check two'`; card ts `CARD2`.
    Click `Deny` as the approver: `click ADEFAULT UAPPR CTEAM "$CARD2" 'slaude_perm:deny:<id>'`.
12. `say ADEFAULT UALICE CTEAM '[[mock:multi-tool n=1 tool=Bash]] permission check three'`; card `CARD3`.
    Click `Allow once` as the manager `UMGR`.
13. Audit rows for steps 11 and 12 (the step 10 query, `LIMIT 2`).

Channel-scoped approvers (COPS replaces the global approvers with `UOPSLEAD`, plus manager and backup):

14. `say ADEFAULT UALICE COPS '[[mock:multi-tool n=1 tool=Bash]] permission check ops'`; card `CARD4`.
    Click `Allow once` as `UAPPR` (a global approver, not one in COPS). Then `ephemerals`.
15. Click `Allow once` on `CARD4` as `UOPSLEAD`.

Cron turn (no initiator):

16. As the manager in CTEAM:
    `say ADEFAULT UMGR CTEAM '/cron-add "* * * * *" "[[mock:multi-tool n=1 tool=Bash]] cron permission check" channel'`;
    read the reply and note the job id prefix (8 characters).
17. Wait up to 90 s for a new root message in CTEAM from `UAGENT` with a card
    (or a card in the thread the cron opened): `msgs CTEAM`. Note `CARD5`.
18. `psqlq "SELECT status, payload->>'initiator', payload->>'origin' FROM pending_gates WHERE kind='perm' ORDER BY created_at DESC LIMIT 1;"`
19. Click `Allow once` on `CARD5` as `UALICE` (a member); then `ephemerals`.
20. Click `Allow once` on `CARD5` as `UAPPR`.
21. Remove the cron: `say ADEFAULT UMGR CTEAM '/cron-remove <prefix>'`.

## Expected observations

1. All pass.
2. The card's first section text is ``:lock: *Approval needed* — `Bash` ``;
   buttons `Allow once`, `Always allow`, `Deny`.
3. `status` `pending`, `initiator` `UALICE`, `toolName` `Bash`.
4. UBOB's message is admitted (CTEAM is trusted); whatever the agent does with
   it, the card's row does not change (step 7).
5. The click is accepted by the fake (`delivery` ok).
6. The latest body has `"response_type":"ephemeral"`, `"replace_original":false`
   and `"text":"Only the person who asked or an approver can decide this."`.
7. Still `pending`, `initiator` still `UALICE`.
8. One row: `gate.permission.refused | UBOB | refused | tool | Bash`, summary
   `Bash: refused (not the requester or an approver)`, details contain
   `"attempted":"allow"` and the `gateId`.
9. The card is replaced (decided) and the turn continues past the gate:
   within 30 s `toolran` (README B5) prints 1 or more.
10. The row is no longer `pending` (decided by `UALICE`); the audit row is
    `gate.permission.decided | UALICE | allow | Bash: allow`.
11. The approver's `Deny` decides the card (no refusal ephemeral).
12. The manager's `Allow once` decides the card.
13. `gate.permission.decided` rows with actors `UMGR` (`allow`) and `UAPPR` (`deny`).
14. Refused: the ephemeral refusal text and a `gate.permission.refused` row
    with actor `UAPPR`; the card stays pending. Rationale: in a channel whose
    block names approvers, only those (plus manager and backup) are approvers
    there.
15. Decided by `UOPSLEAD`.
16. A reply that contains `cron job created` and `channel root`.
17. A card for `Bash` appears within 90 s (the cron fires each minute).
18. `pending`, `initiator` empty (null).
19. Refused with the ephemeral text; still `pending`.
20. Decided by `UAPPR`.
21. A reply confirming the removal; `/cron-list` (as `UMGR`) no longer lists it.

## Cleanup

Remove the cron (step 21) even if earlier steps failed: a cron firing every
minute keeps opening cards. Pending cards left over expire on their own; there
is nothing else to clean.

## Notes

- Requester on the node path (gateway role) is stamped from the job's
  recorded senders and must equal the job token's initiator; this
  environment is `mono`, so only the in-process path is exercised here.
- TODO: what happens when a bystander's message arrives before the card is
  created and is merged into the running turn (two senders, so the stamp is
  null and even the requester would need an approver) depends on whether the
  in-process `AgentManager` merges a mid-turn message into the turn's inputs
  (`turnSenders`). The timing is not controllable from the fake; this case
  is covered by `stampFromSenders` unit tests in
  `tests/permission-gate.test.ts`, not here.
- The `/1on1` lock owner rule (a locked thread's owner may decide) is not
  exercised here; to add it, `/1on1` in a thread as `UALICE`, then let a
  turn started by the manager in that thread open a card and click as
  `UALICE`.
- If the cron card in step 17 does not appear, check `gateway.log` for the
  scheduler line of the job and the mock journal; report BLOCKED with that
  evidence rather than FAIL.
