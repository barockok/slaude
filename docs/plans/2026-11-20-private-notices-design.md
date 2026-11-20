# Private notices: gateway output never goes to the channel

Status: design, approved in brainstorming 2026-11-20 and revised after an independent review against the code. Not implemented.

## Goal

Anything the gateway produces deterministically (not the model) that is meant for one person must not be posted as a regular channel message. It goes to that person as an ephemeral message, a DM or a modal.

Stays public, by decision:

- Permission, approval and proposal cards (several people must see and act on them).
- The model's own replies and posts.
- Short gateway lines about a change that alters what other people can expect (see "Public state changes").
- Status line, reactions, and the todo and task tracker (presence UI, not notices).

A decided permission or approval card becomes an audit entry that keeps what was decided.

## What the code does today (verified)

- The `// runtime-ui:` marker count understates the work. `gateway.ts` has two helpers, `reply` and `replyPrivately`, behind about 85 command replies. The OAuth notices go through `surface.reply({ runtime: true })` and carry no `runtime-ui` marker.
- Commands are parsed from message events, not Slack slash commands, so a command never carries a `trigger_id`. A modal always needs a button click first, and a `trigger_id` lasts 3 seconds.
- On the HTTP transport a `view_submission` is answered with an empty 200 before the handler runs, and `ViewHandler.ack` takes no argument. A modal cannot show field errors on any transport, and the token exchange cannot fit the 3 second window.
- A decided card is replaced with one line and `blocks: []`. Loopback OAuth posts the authorize URL publicly, so anyone in the thread can authorize their own account into the initiator's slot.
- A pasted callback with no parked flow (expired after 10 minutes, or pasted in another thread) is forwarded to the model as a normal turn.

## 1. `sendPrivate` (`src/gateway/slack/private.ts`)

One entry point, `sendPrivate({ class, kind, userId, channel, thread, text, blocks })`, on top of `Surface.sayEphemeral`. The existing `reply` and `replyPrivately` helpers in `gateway.ts` become thin callers of it, so the ~85 command replies move without touching each one.

Delivery ladder, never public:

1. `chat.postEphemeral` to the user, in the thread when it has replies, otherwise in the channel.
2. On any API error (user not in channel, DM thread, and so on): `chat.postMessage` with the user id as the channel (already used by the approval gate; `im:write` is in the manifest). The DM carries a permalink so it has context. The persona's own app sends it on a multi-app gateway.
3. If that fails: drop, log, increment `slaude_private_notice_dropped_total{class}`.

An accepted ephemeral can still go unseen (user not in the channel or inactive, a thread with no replies yet, a reload). Delivery is therefore best effort, and the design does not claim otherwise:

- Metric `slaude_private_notice_sent_total{class,path}` counts sends as well as drops.
- The error reaction on the original message stays as the durable floor for `failure` notices, as it is today.
- A notice whose loss would strand the user (`sensitive`) is sent as a DM with a button, not as an ephemeral.
- Bots, workflow users and Slack Connect external users get no DM fallback.

Classes:

- `sensitive`: DM with an action button; the click carries the `trigger_id` and opens the modal. If the DM fails the flow stops and the initiator sees nothing happen; this is logged and counted. No claim of a delivered error.
- `info`: the answer to something the user asked (`/help`, `/model`, `/mcp` status) is never limited. Only unsolicited notices (the ignore and 1on1-lock rejections) are rate-limited, per `(persona, user, thread, kind)` for 10 minutes. The token is spent only after a successful delivery. The limiter is in-process, as the existing `makeReplyQuiet` is: two replicas may each notify once, which is acceptable for a courtesy notice, and a Redis outage cannot mute anyone.
- `failure`: a refusal that blocks the user (rate limit, decision-gate skip, input guardrail block); not limited.

A per-class environment switch, `SLAUDE_PRIVATE_NOTICES=on|off` (default on), falls back to the old public behavior, so a bad rollout can be turned off without a release.

Regression guard, so the rule is enforced by CI:

- The marker test gains multi-line write detection (today `chat\n.update({` slips through), and a `// private-ui: <class>` marker.
- The test fails on a `runtime-ui` marker that is not a gate card or `views.*` call, and an allowlist names the deliberate public sites with a reason.
- Calls through the `reply` helper are checked by name and by a lint of its call sites, since the marker sits on the helper definition.
- `surface.reply({ runtime: true })` is added to the audited write forms.

## 2. MCP OAuth without exposing the link or the code

Both modes. A `sensitive` private notice carries the authorize link; nothing about the flow reaches the channel.

Loopback mode (same host): the authorize URL is sent privately instead of through `surface.reply`. After the flow finishes there is nothing public to redact.

Paste-back mode (k8s and remote):

1. `/mcp connect` parks the flow as before, and sends the authorize link and a "Paste callback" button as a `sensitive` notice, by DM.
2. The click gives a `trigger_id`; `views.open` shows a modal with one `plain_text_input`. `private_metadata` carries a signed, user-bound, max-age offer (the same encoding `/env` offers already use via `decodeEnvOffer`), not a bare flow key. The submit handler rebuilds the key from `body.user.id` and rejects a mismatch.
3. `view_submission` returns immediately (the 200 already closed the modal) and hands the value to `parseCallback`, which resumes the parked flow in the background.
4. The result, success or failure (bad URL, expired flow, state mismatch, exchange error), is a private notice. There are no modal field errors, because the transport cannot send them.

The old "edit the link away when done" step needs `surface.edit`, which an ephemeral lacks; the DM path keeps it (a DM is editable), and the ephemeral fallback is accepted as unredacted but private.

A callback URL pasted into a thread still works when a flow is parked, followed by a private warning that the code is single-use and the button is preferred. When no flow is parked and the text parses as an OAuth callback, it is not forwarded to the model: the user gets a private "that link has expired, start again with /mcp connect". The bot cannot delete a user's own post, so nothing more can be done about the pasted text itself.

The portal flow is unchanged.

## 3. Commands, 1on1, ignored users

- All command replies move to `sendPrivate` through the two helpers. Read-only answers and the user's own confirmations are private and never limited.
- Pickers (`/model`, `/env`): `/model` is plain text today, so a picker is new work. It is an ephemeral block message with an action per choice. Free-text entry is a button that opens a modal, never a modal opened straight from the command.
- `/1on1` confirms the lock only to the person who ran it. No public line (owner decision).
- Not the locked user in a locked thread: the message is still ignored, and the sender gets one private notice, "this thread is locked 1on1 to <user> (and the manager), so I did not respond to your message", rate-limited per user and thread. The agent can also lock a thread itself (`set_one_on_one`) and will say so in its own reply; the notice is not the only path.
- Ignored users: the notice is sent from `handleMessage`, next to the guardrail reply, not from `preTurnDropReason` (the decision gate also calls that read-only, and a notice there would fire from the gate path). One notice per user per thread per 10 minutes, per persona. A thread-level ignore applies to every speaker, so it can notify each participant once, which is accepted. A channel with several apps notifies per app, accepted.
- Admission drops (blocked user, whitelist) stay silent, as today.

### Public state changes

Kept as one short gateway-generated public line, because they alter what other people can expect: `/mode` (for example bypass), `/ignore @user` and `/ignore-thread`, `/mention-only`, cron create, edit and remove, `/soul` ACL edits, `/abort`, and `/new`. The requester's own confirmation of these is private. `/bash` output is private to the requester.

### Deterministic posts reviewed one by one

Each gets a decision in the implementation plan, with this default: private when it has one reader and a way to reach them; public when it concerns the whole thread or a timer posts without any user present. In particular:

- Promise line (timer, no clicking user) and ops-panel hold notice: stay public.
- Bridge connect and reauth card: a DM to the manager, since the manager may not be in the channel.
- Turn failure text: `failure` class, private, with the error reaction as the floor.
- `/mcp` status card with Connect buttons: private, interactive.
- Proactive feedback reply: stays public (it answers a visible post).

## 4. Audit entry for decided cards

On a click the card is kept and edited, not rebuilt: take `body.message.blocks`, drop the actions block, append the decision line ("Approved by <@user>, 14:02", "Denied", "Always allowed"). This is the existing proposal-card pattern (`withDecision`), so it needs no new handler, no stored state and no cross-replica case, and the click payload already carries the rendered input.

What the entry shows is bounded and redacted:

- Redaction uses `redactValue` (`src/audit/redact.ts`), plus a string pass the live card does not have today (the card uses `redactTree` only). New patterns: URL userinfo (`scheme://user:pass@`), signed-URL query parameters, `--password x` and `-u user:pass`, PEM blocks, cookie strings.
- Write and Edit inputs show the path and a size, never file contents. The approval card for a held reply never shows the held text (the approver's DM does that today and stays so).
- Truncation happens after redaction, so a cut token cannot slip a pattern.
- Voice and other multi-block cards are never truncated, so they keep their existing compact form.
- If `respond` fails (for example `invalid_blocks`), the decision site falls back to the old one-line replacement, so a decided card never keeps live buttons.

Collapsing: the entry has a one-line summary and the input as a context block that Slack renders compactly. A Details/Hide toggle is dropped, as it needs per-click state and a shared re-render for everyone. If the owner wants a true toggle later, the details can be read from the audit row by `toolUseId`.

Cards that are never decided (permission card expired or aborted, approval timeout) are brought into the same path: on expiry or abort the sweep edits the card to a "Expired" or "Cancelled" entry with the same redaction, so no card keeps live buttons and a full input indefinitely.

## Testing

- The marker and lint test changes land first and fail on the current tree; they give the worklist.
- Unit: the delivery ladder, limiter (solicited never limited, token spent after success, per persona), classes, redaction patterns, the modal submit handler including the user-id mismatch, and HTTP-transport `view_submission` with no ack semantics.
- The sim gateway gets a view handler (`t.view` is optional there today), so the modal path runs end to end.
- Scenarios: 1on1 rejection, ignore notice (not from the gate path), loopback link sent privately, expired paste not forwarded to the model, expired and aborted cards, multi-app duplicate notices.
- Real Slack, in a test channel: `/help`, `/model` picker, one OAuth paste-back, and the cases Slack documents but this repo has not verified live: ephemeral in a thread with no replies, ephemeral to a user not in the channel, the `response_url` limits.

## Rollout

Gateway and card path only, not the agent loop. One RC, granular commits: marker and lint test, `sendPrivate` and the two helpers, OAuth (loopback and paste-back), commands and pickers, 1on1 and ignore notices, audit entry and expiry. Ship the metrics, the `SLAUDE_PRIVATE_NOTICES` switch and release notes with it. Parked flows and cards already in channels keep the old layout until they resolve.
