# /1on1 named guests: owner-only enforcement that holds in bypass mode

A `/1on1` runs as its owner: the owner's config dir, private MCP credentials
and, with a sandbox MCP server, the owner's sandbox. Teams wanted
a QA engineer or a reviewer to talk in that thread and drive tests there, while
commits, pushes and file changes stay the owner's call. Open mode could already
admit everyone, but its scope is free text the model is asked to respect.
Named guests make the rule hold in code.

## What it does

- `/1on1 invite @a @b` / `/1on1 kick @a` (owner or manager/backup, locked 1on1
  only) store guest ids on the lock (`one_on_one_locks.guests`, TEXT holding a
  JSON array; pg migration 0018, mirrored in the sqlite bootstrap). Re-locking,
  opening, `/1on1 lock` and `/1on1 off` clear it. Guests never change runAs.
- The lock gate hears owner + guests + manager/backup. `/remote` keeps guests
  out: only the owner drives the remote machine.
- The envelope carries `role="owner|guest|manager"`, computed from the lock and
  the signed inbound user id. The session-mode block lists the guests and the
  owner-only actions.
- While a guest's message is in the turn, a tool call matching the owner-only
  list waits on a card only the owner can decide. No decision before the
  timeout is a deny.

## The enforcement point had to be a hook

The deployment that asked for this runs with `SLAUDE_DEFAULT_MODE=bypass`. In
bypass mode the CLI never calls `canUseTool`, so anything built on the normal
permission prompt is not there. A `PreToolUse` hook runs in every mode, so the
guard is a hook installed by `AgentManager.setOwnerGuard` (mono: the gateway
posts the card in-process; node: `runtime/owner_gate` on the gateway plus the
usual `/v1/pending/:id` long-poll).

Two details of the hook matter:

- **A hook must answer before its own timeout.** Claude Code treats a hook that
  errors or times out as non-blocking, so a hook still waiting on a slow owner
  when the CLI gives up would let the call run. The matcher sets `timeout` to
  the gate timeout plus a minute, and the hook races the guard against its own
  deadline (gate timeout plus five seconds), so it always answers deny first.
- **Approving returns no decision.** The guard only ever takes permission away:
  after the owner's click the session's own permission mode decides, so in
  `ask` mode the usual permission card still follows. Returning `allow` could
  have granted more than the session's mode allows.

## Who is the speaker of a tool call

The live route's `ctx.userId` is overwritten by every inbound message, even
mid-turn. Reading it at tool-call time would let an owner's message that
arrives during a guest's turn turn that turn into an owner turn. So the turn is
marked when its input is pushed: `sendMessage(..., { guest: true })` sets a
flag on the live session in the same tick as the push, and it clears only once
no input is outstanding. An owner's turn that overlaps a queued guest message
is guarded too (the owner approves their own call); that is the fail-closed
direction. A turn cut by a reboot carries the flag into the next boot.

On the queue path the token is not enough either: a message that coalesces into
a waiting job keeps that job's token, whose `initiator` is the job's first
speaker. The gateway therefore stamps `guest: true` on the queued message
itself, and the node marks the whole coalesced turn when any message has it.
The guests also ride the signed `lock` claim, and the session-config
fingerprint includes them only when there are any, so an invite reboots a warm
node session with the new block while every existing fingerprint is unchanged.

## Found on the way

- **The permission-card click handler never checked who clicked.** Any member
  of a channel could approve a tool call in someone's 1on1, which runs with
  that person's credentials. Cards now carry an `approvers` list resolved when
  they are posted: in a 1on1 thread the owner and the manager/backup; anyone
  else gets an ephemeral refusal and the card stays. Unlocked threads keep the
  previous rule (anyone in the thread).
- **A slash command's @mention disengaged the thread.** `/1on1 invite @qa`
  (and the existing `/ignore @user`) mentions another user, which the router
  reads as "talking to a colleague". A message that parses as a slash command
  no longer counts its mentions as addressees.
- **A guest's slash commands.** Once guests are heard, `/1on1` would have let a
  guest re-lock the thread to themselves, and `/mode` or `/cron-add` would have
  changed the owner's thread. A guest may run `/help`, `/abort`, their own
  `/link` and `/1on1 status`; the cron tools are always owner-only in a guest's
  turn (a job created in a 1on1 later runs as its owner with no guest in it).
- **The agent's set_one_on_one never checked the speaker.** `lock` re-locked the
  thread to whoever spoke, and `off` released it, so a guest heard in open mode
  could get the agent to take the 1on1 over (runAs switches to the guest) or
  drop it. An existing 1on1 is now changed only when the speaker is its owner
  or the manager/backup, the same rule as `/1on1 lock`; anyone else gets a
  refusal to relay. In a named guest's turn the hook denies the call outright:
  an owner's click could not make a guest's call pass that check, so a card
  would only mislead. The speaker is the turn's inbound user (on a node, the
  job's first speaker); a guest message that coalesces into an owner's queued
  job, or lands in mono while an owner's turn runs, is not seen there. The hook
  covers that for named guests, but not in open mode.

## Not covered

- Open mode is unchanged: non-owners are not card-gated there, `/1on1` and
  `/1on1 off` from a non-owner still act as before. Applying the owner-only
  rule to open mode is a behaviour change left for a separate decision.
- The owner-only list is a deployment-wide environment variable read by the
  process that runs the agent (mono, or each node). A per-persona list would
  need a persona field and the runtime bundle.
- The `:write` classifier for meta-tools reads inner tool names; it treats
  names without a read verb as writes, so an unusual read tool name asks the
  owner.
- Not run against a real cluster: the node path is covered by the live-`/v1`
  shim test and the dispatch test, not by the Redis end-to-end suite.
