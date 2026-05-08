# slaude

Slack-native Claude Code runtime. Onboard AI agent as team member.

## North Star

Like NousResearch/hermes-agent, but Slack-only, powered by Claude Code as engine. Agent has:
- **Soul** — persistent persona/identity file. Defines voice, values, mandate.
- **Skills** — grow over time. New capability = new skill file.
- **Memory** — episodic (what happened) + semantic (what learned).
- **Autonomy** — runs unattended. Asks owner via Telegram only when blocked on important question.

Shell host (folk fork or greenfield) = backend. Multiple sessions, one per agent identity.

## Scope

In: Slack integration only. Single chat surface. Multi-agent (each agent = own slack identity).
Out: Discord, Teams, web chat, CLI UX. Don't dilute focus.

## Owner

Zidni Mubarok <zidmubarock@gmail.com>. Telegram bridge available — use for blocking questions.

## Working Rules

- Granular commits. One logical change per commit.
- Update this file w/ significant findings, decisions, mistakes (so future Claude sessions inherit).
- Autonomous by default. Don't ask trivial; ask via Telegram only when:
  - Irreversible action needed
  - Architecture fork-in-the-road
  - Secret/credential required
- Memory: write surprising/non-obvious facts to `memory/` per skill rules.

## Open Decisions

- [ ] Fork barockok/folk vs greenfield backend (pending research)
- [ ] Runtime lang for backend (folk's stack vs node/bun/rust)
- [ ] Memory store (sqlite + embedding? markdown + grep? both?)
- [ ] Skill format (claude-code skill compat? custom?)

## Findings Log

(append-only; date entries)

### 2026-05-08
- Repo init. Research dispatched on hermes-agent + folk.
