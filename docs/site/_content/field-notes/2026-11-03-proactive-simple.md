---
title: "Proactiveness: one switch, and wakes that see replies and finish work"
date: 2026-11-03
---

# Proactiveness: one switch, and wakes that see replies and finish work

**Date:** 2026-11-03
**Status:** On branch `feat/proactive-simple`, running live as a patched rc.12 on one deployment. Spec: `docs/superpowers/specs/2026-11-03-proactive-simple-design.md`.

## What was wrong

Measured on live agents over three days: 11 posts, all concepts or status. No asset existed when the manager approved, and an agent wrote "zero approvals" over three hours after one.

- A wake could not see replies: a fresh session, and nothing read Slack.
- A wake could not save: its initiator is the agent's own id, so the KB gate read it as a person in a public channel. The agent then wrote "no write tool" into its notes and believed it.
- A soul edit silently dropped a named persona to the old round and blanked its mandate: both came from the LLM extraction cache, which is empty for new soul text. This caused the "channel unreadable" posts.
- A new thread started from nothing, so an approval could not find what it approved.
- Turning it on took `Enabled`, `Wake`, `Highest`, a checklist page, and usually `Cooldown` and a cap.

## What changed

- `Enabled: yes` is enough. The mandate is the job and the authority. Old keys still parse, and only narrow.
- Code reads Slack before the model call: three days of messages, new thread replies, and who answered each post.
- A wake writes to the agent's own memory. Its manager and mandates are parsed from the soul text when the cache has no entry.
- The prompt says what a finished wake is and is not. `proactive_post` needs only text.
- The first turn of a thread in a working place gets recent posts, notes and the work folder.
- `/heartbeat now` looks on demand.

## What the live runs showed

After the change, with no one prompting: the agent saved its research for the first time, found feedback it had ignored for three days, acted on an approval by rendering, came back for the render, reported two blockers nobody knew about (a publishing account not connected, low credits), and followed up in the existing thread rather than stacking posts. One agent's wake cost fell from $0.46 to $0.20 once it no longer had to read a channel through a connector.

## Known limits

- A wake cannot upload a file, so finished work reaches people as links. A thread-targeted upload needs file transfer from the node.
- Rendering spends paid credits outside the model budget. The mandate's "ask first" line is prompt-level.
- Thread turns get notes, not fresh activity, so a stale line in the notes can be repeated until the next wake corrects it.
- Two agents can ask the manager the same thing when one watches the other.
- Upgrade: `Enabled: yes` now means working unattended. An upstream release needs a release note or a migration default.

One limit had to move from the prompt into code. "Remind once" was only an instruction, and a follow-up in a thread had no cooldown. When the cooldown refused a post, a live agent used the thread instead and asked the same question three times in two hours. A wake can now add one follow-up to a thread until someone answers, counted from the thread itself.
