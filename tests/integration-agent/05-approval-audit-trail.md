# 05: approval audit trail

## Purpose

Every approval decision leaves a durable `audit_events` row: decided
(`gate.approval.decided`, decision `allow` or `deny`), a click by someone
not on the approver list (`gate.approval.refused`, decision `refused`, card
stays pending), and expiry (`gate.approval.expired`, actor `system`, decision
`expired`). Summaries and every string in `details` are redacted with the
shared secret redaction (`src/redact/index.ts`: for example
`api_key=<value>` becomes `••••`; any key matching
`token|secret|key|password|authorization|cookie|credential` gets the value
`[redacted]`). The console's Approvals and audit page lists them with filters
and a detail drawer.

Code: `src/gateway/slack/approval-gate.ts` (`auditApprovalDecided`,
`auditApprovalExpired`, the `notAllowed` refusal), `src/audit/emit.ts`
(`auditGateRow`), `src/audit/redact.ts`, `src/db/audit-events.ts`,
`GET /panel/api/audit`, `src/web/console/pages/AuditPage.tsx`,
`src/web/console/components/AuditDrawer.tsx`.

## Setup

- Unit floor: `bun test tests/approval-gate.test.ts tests/audit/audit.test.ts tests/audit/emit.test.ts tests/panel/console-audit.test.ts`
- Environment A with the helpers; clear the audit table first:
  `sqlite3 "$SLAUDE_DB_PATH" "DELETE FROM audit_events;"`.
- Environment B, signed in as `lead`. The default soul's approval timeout is
  60 s (README B4, `approvalTimeoutSeconds: 60`). Clear the fake's call log:
  `curl -fsS -X DELETE "$F/calls"`.
- Build the tool input for a secret-looking plan (base64url JSON, the mock's `args`):

```sh
ARGS=$(printf '%s' '{"summary":"rotate api_key=it-placeholder-123 on the test box","risks":"none"}' \
  | base64 | tr '+/' '-_' | tr -d '=\n')
```

## Steps

Environment A (sim; the stub's plan summary is always `deploy prod`):

1. Run the unit floor.
2. `sim_reset; bun run sim run 'tests/integration-agent/sim/05-*.yaml'`
3. `sqlite3 -header "$SLAUDE_DB_PATH" "SELECT action, actor_kind, actor_id, decision, persona, target_kind, target_id, channel_id, summary, details FROM audit_events ORDER BY id;"`
4. `sqlite3 "$SLAUDE_DB_PATH" "SELECT kind, status, resolved_by FROM pending_gates;"`

Environment B:

5. `say ADEFAULT UALICE CTEAM "[[mock:multi-tool n=1 tool=mcp__slaude_surface__request_approval args=$ARGS]] approval one"`;
   note `ts` as `T1`. Poll `thread CTEAM $T1` for a message with buttons
   `Approve` and `Deny` (action ids `slaude_appr:approve:<id>`,
   `slaude_appr:deny:<id>`); note its `ts` as `CARD1`.
6. Bystander: `click ADEFAULT UBOB CTEAM "$CARD1" 'slaude_appr:approve:<id>'`; then `ephemerals`.
7. `psqlq "SELECT status FROM pending_gates WHERE kind='approval' ORDER BY created_at DESC LIMIT 1;"`
8. Approver: `click ADEFAULT UAPPR CTEAM "$CARD1" 'slaude_appr:approve:<id>'`; poll the thread.
9. `say ADEFAULT UALICE CTEAM "[[mock:multi-tool n=1 tool=mcp__slaude_surface__request_approval args=$ARGS]] approval two"`;
   card `CARD2`; click `slaude_appr:deny:<id>` as `UAPPR`.
10. `say ADEFAULT UALICE CTEAM "[[mock:multi-tool n=1 tool=mcp__slaude_surface__request_approval args=$ARGS]] approval three"`;
    do not click. Wait 75 s.
11. `psqlq "SELECT action, actor_kind, actor_id, decision, target_kind, target_id, summary, details::text FROM audit_events WHERE action LIKE 'gate.approval.%' ORDER BY id;"`
12. `grep '"evt":"audit"' "$IT/gateway.log" | grep 'gate.approval' | tail -4`
13. Console: open `http://localhost:8080/panel/audit`. Screenshot at 1440 px.
14. `Action` filter chip: choose `Approval`. Screenshot. Note the URL.
15. `Decision` filter chip: choose `Refused`. Then `Any`, then `Expired`.
16. Type `UAPPR` into the `Filter by actor` field (placeholder `Actor id or email`) and press Enter. Then clear it.
17. `Time` chip: `Last 24 h`.
18. Click the row of the decided `allow` event to open the drawer. Screenshot.
19. API: `GET /panel/api/audit?action=gate.approval.&decision=refused` and
    `GET /panel/api/audit?action=gate.approval.decided&limit=1` (page context).
20. Session audit: `psqlq "SELECT session_id FROM audit_events WHERE action='gate.approval.decided' ORDER BY id DESC LIMIT 1;"`,
    then `GET /panel/api/sessions/<session_id>/audit` and open
    `http://localhost:8080/panel/sessions/<session_id>/audit`. Screenshot.

## Expected observations

1. All pass.
2. `✓ .../05-approval-denied.yaml`, `✓ .../05-approval-refused-then-decided.yaml`, `2/2 transcripts passed`.
3. Three rows, in order:
   `gate.approval.refused | slack_user | U0BOB | refused | default | approval | plan | C0TEAM | approval approve refused: clicker is not an approver | {"gateId":"...","category":null}`,
   `gate.approval.decided | slack_user | U0APP | allow | default | approval | plan | C0TEAM | approved: deploy prod | {...}`,
   `gate.approval.decided | slack_user | U0APP | deny | default | approval | plan | C0TEAM | denied: deploy prod | {...}`.
4. `approval | approved | U0APP` and `approval | denied | U0APP`.
5. A card with `Approve` and `Deny`, and the context line
   `:hourglass: Auto-denies in *60s* if no one clicks.`
6. The ephemeral body text is
   `:no_entry: <@UBOB>, you are not on the approver allowlist for this plan. The plan stays pending.`
7. `pending`.
8. The card text becomes `Plan → *Approved* by <@UAPPR>`; the turn continues
   past the gate (`toolran` prints 1 or more within 30 s).
9. Denied.
10. After 60 s the plan auto-denies.
11. Rows include, in order:
    `gate.approval.refused | slack_user | UBOB | refused | approval | ...`,
    `gate.approval.decided | slack_user | UAPPR | allow | ...`,
    `gate.approval.decided | slack_user | UAPPR | deny | ...`,
    `gate.approval.expired | system | system | expired | ...` with details containing `"timeoutSec":60`.
    Redaction: no summary or details contains `it-placeholder-123`; the
    decided summaries read `approved: rotate •••• on the test box` and
    `denied: rotate •••• on the test box`, the expired one
    `auto-denied after 60s: rotate •••• on the test box`.
12. The same events as JSON lines with `"evt":"audit"`, equally redacted.
13. Page title `Approvals and audit`, description
    `Every permission decision and console change, newest first.`, a table
    labelled `Audit events` with the events, newest first.
14. Only `gate.approval.*` rows; the URL carries `action=gate.approval.`.
15. `Refused` shows only the `UBOB` row; `Expired` only the expired row; the
    URL carries `decision=refused`, then `decision=expired`.
16. Only `UAPPR` rows (actor filter is exact).
17. The step 5 to 10 rows are still listed.
18. Drawer titled `Approval decided` (the label for `gate.approval.decided`),
    description the redacted summary, fields `Time`, `Agent`, `Actor`
    (`UAPPR`, kind label for `slack_user`), `Action` `gate.approval.decided`,
    `Target` `approval`, `Decision`, `Session`, `Channel` `CTEAM`, `Event id`,
    a `Details` block with the caption
    `Secret values are redacted before an event is stored.` and JSON that
    contains `gateId` and `category`, and no `it-placeholder-123`.
19. `200` each; the first lists only refused approval events; the second one
    item and a `nextCursor` string when there are more.
20. `200` with this session's gate events; the session page's Audit tab
    lists the same events.

## Cleanup

None. Audit rows are append-only; `pending_gates` rows are settled.

## Notes

- `target_id` is the plan's `scope`, else its `category`, else `plan`
  (`gateTarget` in `src/audit/emit.ts`). The mock call here sets neither, so
  it is `plan`.
- The persona column for a default-persona gate is `default` in the sim
  (observed). In B, if it is empty, report it in Notes rather than FAIL: the
  pass criterion is the action, actor, decision and redaction.
- Step 20: the session id may also be found from `GET /panel/api/sessions`
  (the row whose thread is `T1`).
