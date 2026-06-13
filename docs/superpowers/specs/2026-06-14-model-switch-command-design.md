# `/model` — per-thread model switch (design)

Date: 2026-06-14
Status: approved, pre-implementation

## Problem

No runtime way to change the model a session runs. Model is fixed at session
creation from `env.model()` (`SLAUDE_MODEL`) and stored in `sessions.model`
(`NOT NULL`). Operators want to swap model per Slack thread (e.g. drop to a
cheap model for chatter, bump to Opus for hard work) without redeploy.

A naive `/model <id>` invites typos and silently-wrong model ids, because the
SDK passes whatever string through to the provider. We need the *correct*
available model names surfaced/validated against the live provider — not a
hardcoded whitelist that rots as new models ship.

## Decisions (locked)

| Question | Choice |
|----------|--------|
| Scope | **Per-thread only** (current session). No global default, no per-user. |
| UX | **Typed id only.** `/model <id>` sets; `/model` (no arg) lists available + shows current. No Block Kit buttons. |
| ACL | **Manager + backup manager + approvers** (same predicate as `/ingest`). |
| Validation fallback | **Pass-through + warn** when provider list can't be fetched (non-Anthropic gateway / no `/v1/models`). |
| Model-list cache | **In-memory TTL, 5 minutes.** Lost on restart. |

YAGNI cut: global scope, per-user model, button pickers, hardcoded model lists.

## Source of truth for model names

Provider `GET /v1/models?limit=100`. Returns `{ data: [{ id, display_name,
created_at }], has_more, first_id, last_id }`. The `id` field is the exact
string to pass to the SDK `options.model` / `Query.setModel()`.

Auth + base URL resolution mirrors the existing raw-fetch in
`src/soul/extract.ts:42-88`:

- Base: `process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"`
- Header `anthropic-version: 2023-06-01`
- If `ANTHROPIC_API_KEY` → `x-api-key`
- Else if `CLAUDE_CODE_OAUTH_TOKEN` → `authorization: Bearer …` + `anthropic-beta: oauth-2025-04-20`

Non-Anthropic gateways may lack `/v1/models` or use a different path. Any
non-200 / fetch error → treat as "can't verify" (pass-through + warn). The list
fetch never blocks a set.

## Components

### 1. `src/agent/models.ts` (new)

```ts
export interface ModelInfo { id: string; display_name: string }
export async function listModels(): Promise<ModelInfo[]>
```

- Module-scope cache: `{ data: ModelInfo[]; fetchedAtMs: number } | null`.
- TTL 5 min. On hit within TTL → return cached. Else fetch, populate, return.
- Throws on non-200 or network error (caller catches → "can't verify").
- Single unit: fetch + cache. No DB, no Slack knowledge.

### 2. `src/agent/manager.ts`

New method:

```ts
async setSessionModel(sessionId: string, model: string): Promise<void>
```

- If session live and Query resolved → call `Query.setModel(model)` for instant
  swap on the active turn.
- Always `UPDATE sessions SET model=? WHERE id=?` so it survives restart and
  applies even when no live Query exists yet.
- Idempotent; no-op-safe on dead session (still persists).

### 3. `src/gateway/slack/commands.ts`

- `SlashHit` union: add `{ kind: "model"; id?: string }`.
- `AGENT_COMMANDS`: add `/model` entry + help text
  ("`/model [id]` — show/set this thread's model (manager/approver)").
- `parseSlashCommand`:
  - `/model` → `{ kind: "model" }`
  - `/model <id>` → `{ kind: "model", id: <trimmed first token> }`

### 4. `src/gateway/core/gateway.ts` dispatch

New if-block after the cron block (~L880):

```ts
if (slash.kind === "model") {
  if (!canChangeModel(userId, soul)) {
    await reply(":lock: `/model` — manager or approver only.");
    return;
  }
  if (!slash.id) {
    try {
      const models = await listModels();
      await reply(renderModelList(models, row.model)); // list + "current: `<row.model>`"
    } catch {
      await reply(`can't fetch model list from provider. current: \`${row.model}\``);
    }
    return;
  }
  let verified = false;
  try { verified = (await listModels()).some((m) => m.id === slash.id); }
  catch { /* gateway has no /v1/models — pass through */ }
  await agent.setSessionModel(session.id, slash.id);
  await reply(
    verified
      ? `model → \`${slash.id}\``
      : `model → \`${slash.id}\` :warning: couldn't verify against provider`,
  );
  return;
}
```

### 5. ACL helper

Predicate is identical to `canTriggerIngest` (`src/gateway/slack/ingest-auth.ts`):
`manager.userId || backupManager.userId || approvers[].userId`.

Plan decides: reuse `canTriggerIngest` directly, or extract a shared
`canManage(userId, soul)` and have both call it. Prefer the shared extract to
avoid two predicates drifting — but keep `canTriggerIngest` as a thin alias so
existing call sites/tests are untouched.

## Data flow

```
Slack "/model claude-opus-4-8"
  → parseSlashCommand → {kind:"model", id:"claude-opus-4-8"}
  → gateway dispatch
      → canChangeModel? no → :lock: reply, stop
      → listModels() (5m cache) → verify id present (best-effort)
      → manager.setSessionModel(sessionId, id)
          → Query.setModel(id) if live
          → UPDATE sessions SET model=id
      → reply "model → `id`" (+ ⚠️ if unverified)
```

## Error handling

- List fetch failure: never blocks a set. No-arg list → friendly "can't fetch"
  message still showing current model. Set → applies + warns unverified.
- `setModel` on dead/un-resolved session: skip the live call, still persist to
  DB; next boot picks up `sessions.model`.
- Empty/garbage id token: parser keeps first whitespace-delimited token; no
  validation beyond provider check (pass-through path covers unknown ids).

## Testing

- `tests/commands.test.ts`: parse `/model` → `{kind:"model"}`; `/model x` →
  `{kind:"model", id:"x"}`; extra args ignored.
- `tests/models.test.ts`: cache hit within TTL avoids second fetch; expiry
  refetches; non-200 throws. Mock `fetch`.
- ACL: non-manager/non-approver caller → `:lock:` reply, no `setSessionModel`
  call. Manager and approver both allowed.
- `setSessionModel`: persists to `sessions.model`; calls `Query.setModel` when
  live.

## Out of scope

Global/default model override, per-user model, model-list buttons, cost guards,
provider-specific list-path adapters (OpenRouter `/api/v1/models` etc.) — the
pass-through path already keeps those gateways functional.
