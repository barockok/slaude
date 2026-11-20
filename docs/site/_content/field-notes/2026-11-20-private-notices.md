# Private notices: what the gateway says for itself goes to one person

The gateway writes text of its own, apart from the model's: a command's answer, a refusal, an OAuth link, an error. That
text went into the thread for everyone, and for OAuth it included the authorize link and the callback code a user
pasted back, which are credentials. This note records the rule that replaced that, and what reviewing the design
against the code changed in it. The mechanism only; nothing here is specific to a deployment.

## The rule

Gateway-generated text meant for one person goes to that person: an ephemeral message, then a DM, never the channel.
Only the model's replies and the permission and approval cards (several people must act on those) stay public, plus a
short list of lines that change what everyone can expect (`/mode`, `/ignore`, cron edits, `/soul` edits, `/abort`,
`/new`) or that no one is present to receive (a timer's promise line). Each public line is named with its reason in
`tests/gateway/outbound-sites.test.ts`, and a new one fails the test until it is.

## What the review against the code changed

- **A modal cannot show an error.** On the HTTP transport a `view_submission` is answered with an empty 200 before the
  handler runs, and the token exchange would not fit the acknowledgement window anyway. So the OAuth code form does no
  field errors: every outcome is a private notice.
- **The loopback link leaked too.** The design first said loopback mode was unchanged. It posted the authorize URL in the
  thread, where anyone could open it and authorize their own account into the initiator's credential slot. It is private now.
- **A pasted callback could reach the model.** With no parked flow (expired, or another thread) the text went on as an
  ordinary turn, so the code sat in the transcript and memory. A single-token callback URL is now held back.
- **The marker count understated the work.** About 85 command replies sit behind two helpers, and the OAuth notices carried no
  `runtime-ui` marker. The change goes through the helpers, and the guard test also reads writes split across lines.
- **An accepted ephemeral can be unseen.** Slack takes an ephemeral for a user who is away, and drops it on a reload. Delivery
  is best effort, and the design says so: a notice whose loss would strand someone (a link, a connect card) is a DM; the
  error reaction stays as the floor for a failed turn; the sent metric counts sends, the dropped metric counts only what
  neither path could deliver.
- **Storing the decision in the button would have broken.** A button value holds 2,000 characters, and a failed update left
  a decided card with live buttons. A decided card now keeps the blocks it already had and swaps only the buttons, as
  proposal cards already did, and falls back to one line if Slack refuses.
- **Redaction was not enough to keep.** The card used a walker with no string pass, and the secret patterns missed URL
  passwords, `--password` flags, `curl -u`, signed URLs, key blocks and cookies. Both are fixed before the card keeps its input.

## Choices worth keeping

- An ignore or lock notice is sent from the message handler, never from the pre-turn drop check the decision gate also
  calls read-only, which would have fired it from the gate path. It is sent only when the person addressed the agent, so
  people talking to each other in a locked thread are not told "I did not respond".
- The limiter is in-process, like the guardrail reply limiter it replaces: two replicas may each notify once, which is
  fine for a courtesy notice, and a Redis outage cannot mute anyone. A solicited answer is never limited, and the token is
  spent only after a delivery.
- `SLAUDE_PRIVATE_NOTICES=off` puts the public behavior back without a release.

## Open

- Slack documents that an ephemeral in a thread with no replies may not render. A top-level command now goes to the channel
  rather than a thread for that reason, but whether a real thread ephemeral shows before the first reply has not been
  checked live.
- A decided card shows its input to the thread, as the pending card did. That is the audit trail, and it is why the redaction
  patterns matter; an operator who does not want a command's text kept can set a `redactPatterns` rule for it.
