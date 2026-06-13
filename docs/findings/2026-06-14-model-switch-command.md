# 2026-06-14 — `/model` per-thread model switch

## What

New Slack slash command `/model [id]`:

- `/model` (no arg) — lists available models from the provider, shows the current session's model.
- `/model <id>` — sets the model for **this thread's session only**. Persists to `sessions.model`; if a live SDK Query exists, also pushed via `Query.setModel()` for an instant swap.

ACL: manager + backup manager + approver (same predicate as `/ingest`, `/cron`, `/ignore`).

## Why these choices

- **Per-thread only.** Each Slack thread = one session row with its own `model` column. No global default override, no per-user model — drop a cheap model for chatter in one thread, bump to Opus for hard work in another. Multi-agent/global config stays a deploy-time concern.
- **Typed id, no buttons.** Lower surface than a Block Kit picker; the no-arg list already surfaces correct ids.
- **Provider `/v1/models` is the source of truth.** Hardcoded whitelists rot as new models ship. We fetch `GET /v1/models?limit=100` and validate the typed id against the returned `id` set. Auth + base URL reuse the raw-fetch pattern from `soul/extract.ts` (API key wins over OAuth; OAuth needs the `anthropic-beta: oauth-2025-04-20` header). 5-minute in-memory cache avoids hammering the endpoint.

## The catch: non-Anthropic gateways

OpenRouter / Z.ai / self-hosted Anthropic-compat gateways may not expose `/v1/models` (or use a different path). So validation is **best-effort, pass-through + warn**: if the list fetch throws, the set still applies and the reply carries a ⚠️ "couldn't verify against provider". The list fetch never blocks a set. This keeps every provider working while giving typo protection on real Anthropic endpoints.

## Files

- `src/agent/models.ts` — `listModels()` + cache.
- `src/agent/manager.ts` — `setSessionModel()` (live `Query.setModel` + persist).
- `src/db/sessions.ts` — `setModel()` writer.
- `src/gateway/slack/model-auth.ts` — `canChangeModel()`.
- `src/gateway/slack/commands.ts` — parser + help entry.
- `src/gateway/core/gateway.ts` — dispatch block.

## Refs

- Spec: `docs/superpowers/specs/2026-06-14-model-switch-command-design.md`
- Plan: `docs/superpowers/plans/2026-06-14-model-switch-command.md`
