# Private notices: gateway output never goes to the channel

Status: design, approved in brainstorming 2026-11-20. Not implemented.

## Goal

Anything the gateway produces deterministically (not the model) must not be posted as a regular channel message. It goes to the one person it is for, as an ephemeral message, a DM, or a modal. Two exceptions are kept on purpose:

- Permission, approval and proposal cards stay public (several people must see and act on them).
- The model's own replies are unchanged.

A decided permission or approval card becomes a collapsible audit entry instead of disappearing.

## Today

The audit of `// runtime-ui:` write sites found about 35: 16 gateway notices and command replies in `gateway.ts` (mostly `chat.postMessage` in the thread), 8 permission-gate cards, 7 approval-gate cards, 3 proposal-card click answers, and one existing ephemeral (`Surface.sayEphemeral`). In paste-back MCP OAuth mode the user pastes the callback URL into the thread, where everyone can read it. A decided card is replaced by a one-line text with `blocks: []`, so what was approved is lost.

## 1. `sendPrivate` helper (`src/gateway/slack/private.ts`)

One entry point: `sendPrivate({ class, userId, channel, thread, text, blocks, modal? })`, built on `Surface.sayEphemeral`.

Delivery ladder, never public:

1. `chat.postEphemeral` to the user in the thread.
2. On `user_not_in_channel`, a DM thread, or any ephemeral error: open a DM and post there.
3. If that fails: drop, log, and increment `slaude_private_notice_dropped_total{class}`.

Classes:

- `sensitive`: without a `trigger_id`, skip step 1 and send a DM with an "Open form" button; the click opens the modal. If nothing works the flow fails closed with a clear private error.
- `info`: rate-limited per `(user, thread, noticeKind)` for 10 minutes, state in Redis so replicas agree.
- `failure`: like `info` without the limiter, plus the drop metric.

Regression guard: `tests/gateway/outbound-sites.test.ts` already requires a marker on every Slack write. Add `// private-ui: <class>` and fail the test on any `runtime-ui` marker that is not a gate card, so CI enforces the rule.

## 2. MCP OAuth without a paste into the chat

In paste-back mode (the parked flow keyed `channel:thread:user` is unchanged):

1. `/mcp connect` sends the authorize link and a "Paste callback" button as a `sensitive` private notice.
2. The click gives a `trigger_id`; `views.open` shows a modal with one `plain_text_input`. `private_metadata` holds only the flow key.
3. `view_submission` passes the value to the existing `parseCallback` and resumes the same flow.
4. Errors come back as modal field errors; success closes the modal and sends a private confirmation.

A URL pasted into the thread is still accepted (existing users), followed by a private warning that the URL is single-use and the button should be used next time. Loopback mode and the portal flow are unchanged.

## 3. Commands, 1on1, ignored users

- All 16 gateway command and notice sites move to `sendPrivate`. Read-only answers are `info`. Pickers (`/model`, `/env`) are interactive ephemeral blocks; free-text input opens a modal.
- State changes keep one short gateway-generated public line, "this thread is now 1on1 with <user>", so others know why the agent went quiet. Open question for the implementer: confirm with the owner before making it private too.
- Not the locked user in a 1on1 thread: the message is still ignored, and the sender gets a private `info` notice (rate-limited).
- Ignored users: the ignore gate still drops the message, and the user gets one private notice (rate-limited), then silence.
- Gate refusals (rate limit, decision-gate skip, input guardrail block) use class `failure`.
- Out of scope: the model's posts, including a deliberate `pass`.

## 4. Collapsible audit card

On resolve, `respond({ replace_original: true, ... })` renders:

- Collapsed: "Approved: `<tool>` by <@decider>, 14:02" (or Denied, or Always allowed) with a Details button.
- Expanded: tool name, key parameters, decision, decider, time, and a Hide button.
- Redaction: parameters pass through `src/redact`, truncated to about 1,500 characters; tokens and keys are masked.
- Storage: the poll path deliberately keeps no tool input (it can carry secrets and the row outlives the decision), so the decision site renders the redacted details into the button `value`. No new column. On a cross-replica decision where the input is not held, the expanded view shows only the summary fields.
- Anyone in the thread may toggle; it is read-only.

## Testing

- Unit: delivery ladder, limiter, classes, audit redaction, modal submit handler with the existing callback fixtures.
- The marker-test change lands first and fails on the current tree, which is the worklist.
- Sim gateway: a 1on1 scenario and an ignore scenario end to end.
- Real Slack: `/help`, `/model` and one OAuth paste-back in a test channel.

## Rollout

Gateway and card path only, not the agent loop. One RC, granular commits: helper, marker test, OAuth modal, commands, 1on1 and ignore notices, audit card. Ship the metric and release notes with it.
