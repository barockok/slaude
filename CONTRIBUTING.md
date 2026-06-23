# Contributing to slaude

Thanks for your interest. slaude is a Slack-native Claude Code runtime —
onboard an AI agent as a team member.

## Ground rules

- **This is a public repo. No internal/proprietary references.** Never commit
  real people's names, company/employer/org names, internal Slack channel
  names, or internal service / KB / data-source identifiers — in code, tests,
  comments, docs, commit messages, or PR text. Use generic placeholders
  (`bulk-corpus`, `org/team-directory`, `#team-channel`, `Jane Doe`).
- Be excellent to each other — see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Security issues go to the private channel in [SECURITY.md](SECURITY.md), not
  the public tracker.

## Stack & setup

- **Bun + TypeScript.** Native sqlite, fast startup, native fetch.
- Install: `bun install`
- Typecheck: `bun run typecheck`
- Test: `bun test`

See [README.md](README.md) for full runtime setup (Slack app, env, SOUL.md).

## Pre-commit hygiene

Run before every commit (see also CLAUDE.md):

1. **Don't stage scratch artifacts** — `.handoff`, `.mcp.json` (commit
   `.mcp.json.example` instead), `.playwright-*/`, stray screenshots, `*.log`.
   They're gitignored; if one appears in `git status`, gitignore it.
2. **Leak-scan the staged diff** for internal references:
   ```sh
   git diff --cached -U0 | grep -nIiE '\.slack\.com|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY'
   ```
   Replace any real hit with a placeholder before committing.

## Commits & PRs

- **Granular commits** — one logical change per commit.
- **[Conventional Commits](https://www.conventionalcommits.org/)** —
  `feat:`, `fix:`, `docs:`, `chore:`, etc. Explain the *why*, not just the *what*.
- Add tests for new behavior; keep `bun run typecheck` and `bun test` green.
- Log significant findings/decisions in `docs/findings/<date>-<slug>.md` and
  link them from the Findings Log index in CLAUDE.md (newest first).
- Open a PR against `main`. Keep the description public-safe.

## Scope

In scope: Slack integration. Out of scope: Discord, Teams, web chat, CLI UX —
don't dilute focus.
