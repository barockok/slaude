---
title: "Thread head: a session that starts inside a thread knows what it is about"
date: 2026-11-17
---

# Thread head: a session that starts inside a thread knows what it is about

**Date:** 2026-11-17

## Problem

A session that starts inside an existing Slack thread (an @mention in the
middle of it, a channel session's thread reply, a thread in a proactive
channel) began blind. Its first turn carried the `<channel>` envelope, the
memory block and the proactive block, and nothing about the thread. The agent
had a history tool but nothing told it to use it.

## Mechanism

- **Fetch.** One `conversations.replies` path on the first real turn.
  `threadTail` (the decision gate's reader) includes the event and its
  `slice(-limit)` drops the root, so `fetchThreadSlice` is a variant: it keeps
  the root from the first page, excludes the event and everything later, and
  keeps the last N replies across pages. It reads at most five pages of 200;
  past that the replies kept are the latest of those read, not of the thread.
  Tombstones and join notices are not shown. Any error fails open.
- **Build.** `buildThreadHead` makes one line per message (the root marked,
  the agent's own messages as "you said", others by display name from the
  users cache, files by name). Text is cut to 500 characters, the block to
  6,000 (oldest replies first, root kept), and a line counts the messages
  left out. The block sits before the `<channel>` envelope so the last
  envelope is always the real message.
- **Marker.** `sessions.thread_head_at`, claimed with
  `UPDATE ... WHERE thread_head_at IS NULL` and the changed-row count, on every
  real (not recorded) turn. The claim is made whether or not the turn can take
  a head, so the marker means "the first real turn has happened".

## Review-driven decisions

- **A durable column, not the seen-events table and not `claude_started`.**
  The seen-events rows are purged after an hour, so a later turn would inject
  the head again. A recording boots the query and sets `claude_started`, so
  that flag would skip a thread first seen as a recording. A column set by
  compare-and-set survives both, and two concurrent first messages cannot both
  win.
- **Tag neutralisation.** The head is other people's text placed in the
  prompt. `thread-head` joined the envelope tags the neutraliser rewrites, and
  every piece (text, display name, file name) is neutralised and flattened to
  one line before it is wrapped, so a reply cannot close the block, open a
  `<channel>` with a trusted attribute, or start a fake "you said" line. A
  display name that reads "you" or "you said" is prefixed.
- **Author filtering.** A reusable filter (`makeAuthorFilter`) applies what the
  ingress applies to a person who writes to the agent: denied for the persona
  (the admission check), a user or thread ignored, and the owner's inbound
  guardrail deny rules on the text (fail closed when the rules cannot be
  read). The agent's own messages are always kept. The head widens a default
  read of what `get_thread_history` returns on request, so this is the
  mitigation. The same filter is meant for any later reader of thread text
  that feeds a model.
- **First real turn.** A recording never claims the marker, so a thread first
  seen as a recording gets its head on its first real turn. A real turn that
  cannot take a head still claims it, so no later turn gets one in the middle
  of a conversation. The migration claims the marker for sessions that already
  ran a turn.
- **Proactive reply block only.** `turnProactiveBlock` returns the reply block
  and the first-turn work block joined; the head is skipped only when the
  reply block is present (the post is the context). Keying off a non-empty
  result would have disabled the head in a proactive channel's unrelated
  human threads, where the work block is non-empty on a first turn.

## Known limits

- A channel session is one long-lived session, so it claims the marker once:
  its first real turn gets a head if that turn is a thread reply, later thread
  replies get none (the transcript holds what was recorded).
- A turn dropped after the claim (a failed dispatch) has spent the marker.
- With the decision gate on, the first turn makes two bounded reads.
- Past five pages of 200 the tail is not the latest.
- Display names are looked up once per distinct author (cached), so a cold
  cache costs up to one users call per author, bounded by the setting.

## Episodic record

A turn's user text, including the head, is what the memory manager gives the
episodic provider, and only the `<memory-context>` block was stripped before
storage. The head would have been stored: the brain provider writes a 200
character summary and an 800 character detail of the user text, which the head
(placed first) would have filled, and the sqlite provider stores the text
whole. The strip now removes the `<thread-head>` block as well, in the manager,
the brain provider and so for the node's sync route.
