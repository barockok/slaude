---
title: "One Slack app per persona: the receiving app picks the persona"
date: 2026-11-01
---

# One Slack app per persona: the receiving app picks the persona

**Date:** 2026-11-01
**Status:** Shipped in `v0.45.0-rc.11`. It changes how the gateway routes inbound Slack messages, so it soaks as a release candidate. Checked with unit tests (gateway handlers, HTTP transport); not yet checked against real Slack.

## What was wrong

`slack-app add --persona <name>` stores `slack_apps.persona_id`, and the horizontal-scale design names one app per persona as the model that ships. Nothing in the gateway read that column. A DM to a registered app's bot, an @mention of it, and a reply in a thread it was engaged in all reached `handleMessage` with no persona, so the session was created as `default`. A second app registered for a second persona therefore spoke with the default persona's soul, tools and memory, through its own bot name and avatar. Named personas were reachable only by mentioning a persona's own Slack user in a channel.

Nodes were never the problem: a job carries its persona, and one node already serves several personas.

## What changed

- The HTTP transport puts the receiving app's `persona_id` in the event context (`context.personaId`).
- The gateway resolves it once per event (`appPersonaOf`) and passes it where the app's own bot is addressed: a DM, an @mention of the bot (both the `message` and the `app_mention` delivery), and a plain reply in a thread whose own-persona session is engaged. Gate, doubt reaction, engagement and the turn all use the same persona.
- Replies go out through the receiving app's bot unless the persona has its own user token, as before.
- Sessions are keyed by `(team, channel, thread, persona)`, so two apps in one channel keep separate sessions for one thread.

## Decisions

- **No change when the persona is `default`.** That is what a registration gets without `--persona`, so existing single-app and multi-app deployments behave as before.
- **A persona that is not live falls back to the default persona, with one warning per persona.** Dropping the message, as a retired persona's mention is dropped, would silence apps that were registered with a persona name that has no matching persona (a typo, or a fixture that seeds the default soul under another name). The warning names the app and persona.
- **Mention routing is unchanged.** A mention of a persona's own Slack user still routes to that persona, and a mention of the receiving bot wins over it as before.
- **Suppressed records follow the thread.** A colleague mention or a mention-only message in a thread is recorded under the persona of the thread's existing session, so it never creates a stray default row. `CLAUDE.md` now names one app per persona as a second way to run several agents; the `how-slaude-works` skill still says "more agents = more deploys".

## Checked

- `tests/gateway/core/app-persona.test.ts`: a DM, an @mention (both deliveries, deduplicated), and a thread reply run as the app's persona and record the app; a default app is unchanged; one thread keeps separate sessions per app; a persona that is not live falls back with one warning; a context with no persona is unchanged. Six of the eight fail on the previous code.
- `tests/gateway/slack/http-transport.test.ts`: the context carries each app's own persona.
- `bun run typecheck` and the whole gateway test directory pass.

## Not covered

- Real Slack end to end. A gateway that serves two apps should be tried with a DM to each before a release.
- Interactivity (gate buttons) and cron jobs take their persona from the session, which now carries the app's persona; they were not changed.
