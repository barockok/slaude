# slaude Guardrails — Design Document

**Status**: Draft v0.1
**Author**: Zidni Mubarok
**Date**: 2026-05-21
**Project**: [slaude](https://github.com/barockok/slaude)
**Related wiki**: [[ent-slaude]], [[con-llm-guardrails]], [[con-semantic-classification-embeddings]], [[cmp-langchain-vs-nemo-guardrails]]

---

## 1. Goal

Add a policy-driven guardrails layer to slaude as an independent process-mode:

1. Runs **policy-service** as a separate HTTP server (port 8081) within the slaude container.
2. Agent loop calls policy-service via HTTP (`POST /check`) on SDK hooks rather than embedding logic in hooks.
3. Loads a human-authored policy document and embeds it into a semantic index (Chroma-backed, tier 3 ready).
4. Decides per-turn using a `(actor, channel, content)` triple — content alone is insufficient.
5. Defaults to most-restrictive behavior when actor's role is unknown; emits onboarding redirect rather than silent denial.
6. Stays provider-agnostic for the embedding model (default: EmbeddingGemma 300M, swappable).
7. Positions tier 3 cleanly — policy-service can graduate to independent microservice without slaude refactor.

Non-goals:
- Replacing existing channel-trust, blocked-user, or approver-scope gates. Those continue to live in the gateway.
- Building compliance-team admin UI (deferred to tier-3).
- Multi-runtime fleet policy synchronization (each container runs its own policy-service).

---

## 2. Architectural Position

**Two-service boundary within one container:**

```
┌─ slaude container ─────────────────────┐
│                                         │
│ ┌─ policy-service (port 8081) ────┐   │
│ │ Policy loader, Chroma, HTTP API  │   │
│ │ /check, /reload, /stats          │   │
│ └─────────────────────────────────┘   │
│           ▲                             │
│           │ HTTP                        │
│           │                             │
│ ┌─ agent (port 3000) ─────────────┐   │
│ │ SDK loop, hooks, gateway         │   │
│ │ Calls policy-service on hooks    │   │
│ └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

**Separation of concerns:**

- **Policy authoring** (prose, YAML) — human writes `POLICY.md`. LLM never authors policy.
- **Policy compilation** (deterministic) — chunker + embedder + Chroma loader in policy-service. Pure code.
- **Policy enforcement** (deterministic) — `policyCheck()` runs in policy-service, agent calls via HTTP. No LLM judgment in decision path.
- **Gateway logic** (existing) — channel-trust, blocked-user, engagement, approvers stay in slaude gateway.

Embedding is used **only** as a semantic-similarity primitive to match input text against policy anchors. The decision logic on top (role gate, channel gate, severity reduction) is fully deterministic.

**Why separate service?**
- Clean boundary: policy team can own policy-service independently (for tier 3).
- Hot-reload: update POLICY.md without restarting agent.
- Independent deployment: policy-service can be upgraded/tested without agent.
- Scaling flexibility: policy-service can graduate to external microservice (tier 3) without agent refactor.

---

## 3. Policy Pipeline (Tier 2)

### 3.1 Tier choice

| Tier | Pipeline | When |
|---|---|---|
| 1 | `POLICY.md` → embed at boot → in-memory | <50 rules, single deploy |
| **2** | **`POLICY.md` → sqlite-vec cache (per-chunk sha) → in-memory hot table** | **50–500 rules, multi-deploy, hot edits** |
| 3 | External vector store + admin app | 500+ rules, compliance UI, multi-author |

**Selected: Tier 2.** Markdown is single source of truth; sqlite-vec holds derived embeddings keyed by chunk sha so only changed anchors re-embed.

### 3.2 Source-of-truth files

```
~/.slaude/
├── POLICY.md                                # operator-authored, git-tracked
└── cache/
    └── policy/
        └── <embedding_model>/
            ├── policy.db                    # sqlite + sqlite-vec virtual table
            └── meta.json                    # {policy_sha, anchors_count, built_at}
```

### 3.3 Schema

POLICY.md frontmatter + body:

```yaml
---
version: 1
defaults:
  threshold: 0.65
  hook_points: [user_prompt, pre_tool, output]
embedding:
  provider: gemma                            # gemma | openai | bge-m3
  model: embeddinggemma-300m
  dim: 768
role_source:
  type: remote_http
  url: https://idp.internal/api/slack-roles
  auth: bearer ${ROLE_API_TOKEN}
  ttl_seconds: 600
onboarding:
  enabled: true
  message_template: |
    I don't have you in my role map yet. Onboard here: {{onboard_url}}.
    Manager <@{{manager_id}}> — please approve.
  manager_request_approval: true
---

# Rules

- id: leak-customer-pii
  severity: block
  roles_allowed: []
  roles_denied: [anonymous, vendor, intern]
  channels: [any]
  hook_points: [user_prompt, pre_tool, post_tool, output]
  threshold: 0.7
  anchors:
    - share customer credit card
    - borrower KTP number
    - phone number disclosure
  message: "PII handling restricted. Ask #compliance."

- id: discuss-roadmap-q3
  severity: ask
  roles_allowed: [manager, eng-lead, exec]
  roles_denied: [vendor, anonymous]
  channels: [trusted]
  threshold: 0.6
  anchors:
    - q3 roadmap
    - unreleased feature timeline
  message: "Roadmap topic — manager approval required."

- id: destructive-bash
  severity: block
  roles_allowed: [eng-lead, sre]
  channels: [trusted]
  hook_points: [pre_tool]
  threshold: 0.55
  anchors:
    - rm -rf production
    - drop table users
    - terraform destroy
```

Rule field semantics:

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Stable identifier. Used in metrics, audit logs. |
| `severity` | enum `block|ask|redact|log` | yes | Action class. |
| `roles_allowed` | string[] | yes | Empty = no role allowed (with `roles_denied=[]` means rule applies to all). |
| `roles_denied` | string[] | no | Hard denial. Overrides `roles_allowed`. |
| `channels` | string[] | yes | `any` or list of `trusted|allowed|restricted`. |
| `hook_points` | string[] | no (defaults inherit) | Where rule evaluates. |
| `threshold` | float | no (defaults inherit) | Cosine similarity gate. |
| `anchors` | string[] | yes | Embedded once; each maps back to this rule. |
| `message` | string | no | User-facing rejection text. |

### 3.4 Sqlite layout

```sql
CREATE TABLE policy_rules (
  id            TEXT PRIMARY KEY,
  severity      TEXT NOT NULL,
  roles_allowed JSON NOT NULL,
  roles_denied  JSON NOT NULL,
  channels      JSON NOT NULL,
  hook_points   JSON NOT NULL,
  threshold     REAL NOT NULL,
  message       TEXT,
  rule_sha      TEXT NOT NULL                -- detects rule body change
);

CREATE TABLE policy_anchors (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id   TEXT NOT NULL REFERENCES policy_rules(id) ON DELETE CASCADE,
  text      TEXT NOT NULL,
  text_sha  TEXT NOT NULL,                   -- cache key for embedding
  UNIQUE(rule_id, text_sha)
);

CREATE VIRTUAL TABLE policy_vec_embeddinggemma_300m USING vec0(
  anchor_id INTEGER PRIMARY KEY,
  embedding FLOAT[768]
);
```

Table name carries `<model>_<dim>` so swapping providers creates a fresh table; old cache discarded only after new one is built (atomic swap).

### 3.5 Loader algorithm

```
on boot OR file_watch(POLICY.md) fires:
  policy_text = read POLICY.md
  policy_sha = sha256(policy_text)
  if meta.json.policy_sha == policy_sha:
      load existing tables; return

  rules = parse_yaml(policy_text)
  begin txn:
    upsert policy_rules (by id, with rule_sha)
    delete rules not present in current POLICY.md
    for rule in rules:
      for anchor_text in rule.anchors:
        text_sha = sha256(anchor_text)
        if not exists policy_anchors(rule.id, text_sha):
          vec = embedding_provider.embed([anchor_text])[0]
          insert policy_anchors → anchor_id
          insert policy_vec_<model> (anchor_id, vec)
      delete policy_anchors for this rule not in current anchor list
        (cascades to policy_vec via trigger)
  commit
  write meta.json = {policy_sha, anchors_count, built_at}
  atomic-swap in-memory pointer to new loader instance
```

Only changed anchors re-embed. Boot cost = O(delta).

### 3.6 Hot reload

`fs.watch("~/.slaude/POLICY.md")` debounced 500ms → re-run loader → swap pointer. Mirror's slaude's skill hot-reload pattern.

---

## 4. Role Source — Remote, Pluggable

### 4.1 Interface

```typescript
interface RoleResolver {
  resolve(slackUserId: string): Promise<ResolvedRole | null>
}

interface ResolvedRole {
  role: string                  // canonical role identifier
  groups: string[]              // optional secondary memberships
  resolved_at: number           // epoch ms
  stale_at: number              // epoch ms when cache entry expires
  source: string                // 'remote_http' | 'slack_usergroups' | 'soul_md' | 'null'
}
```

### 4.2 Implementations (ship order)

1. `RemoteHttpRoleResolver` — default. `GET ${url}/users/${userId}`, bearer auth, JSON `{role, groups, expires_at}`. Per request timeout 2s.
2. `NullRoleResolver` — dev/test. Every user → `anonymous`.
3. `SoulMdRoleResolver` — fallback. Reads `## Roles` block from SOUL.md (kept for offline operation).
4. `SlackUsergroupsResolver` — future. Polls `usergroups.list`.

`CompositeRoleResolver` chains them: try remote → fallback to SOUL.md → fallback to null. Used when remote is required-but-degraded.

### 4.3 Cache + failure modes

```
LRU<userId, ResolvedRole> in-memory, max 10K entries
TTL = resolved.stale_at - resolved.resolved_at, default 600s
```

Behavior matrix:

| State | Cache hit | Cache miss |
|---|---|---|
| Remote up | Serve cached if fresh; revalidate async if past 80% TTL | Fetch → cache → serve |
| Remote down | Serve stale (stale-while-revalidate); emit `slaude_role_resolver_stale_total` | Return null → caller treats as `anonymous` (fail-closed first-touch) |

Metrics:
- `slaude_role_resolver_requests_total{source, result}` (result: `hit|miss|stale|fail`)
- `slaude_role_resolver_latency_seconds_bucket{source}`
- `slaude_role_resolver_failures_total{source, kind}`

### 4.4 Identity envelope injection

slaude `adapter.ts` already prepends `<channel … trust="…">` to each turn. Extend with actor:

```
<actor user="U02ABC" role="eng-lead" groups="payment,acore" channel_trust="trusted"/>
```

Hooks parse this envelope to know the actor. **Hook also re-verifies role against the in-memory RoleResolver cache** — never trusts envelope alone, mirroring slaude's existing id-provenance check pattern.

---

## 5. Embedding Provider — Gemma default, swappable

### 5.1 Interface

```typescript
interface EmbeddingProvider {
  readonly model_id: string       // "embeddinggemma-300m"
  readonly dim: number            // 768
  readonly l2_normalized: boolean
  embed(texts: string[]): Promise<Float32Array[]>
}
```

### 5.2 Implementations

| Provider | Model | Dim | Where it runs | Notes |
|---|---|---|---|---|
| `GemmaEmbeddingProvider` (default) | EmbeddingGemma 300M | 768 | Local CPU/GPU via transformers.js or ONNX | Apache 2.0, multilingual incl. Indonesian, ~50ms/text CPU |
| `OpenAIEmbeddingProvider` | text-embedding-3-small | 1536 (Matryoshka 256-1536) | Network | $0.02/M tokens |
| `OpenAIEmbeddingProvider` | text-embedding-3-large | 3072 (Matryoshka 256-3072) | Network | $0.13/M tokens |
| `BgeM3EmbeddingProvider` | bge-m3 | 1024 | Local CPU/GPU | Multilingual fallback |

### 5.3 Swap mechanics

- Cache table name carries `<model_id>_<dim>` → swap invalidates cache transparently.
- New provider triggers full re-embed at boot; until new table is populated, queries continue against old table.
- Atomic pointer swap after build completes; old table dropped after grace period (1 boot cycle).

---

## 6. Enforcement — SDK hooks first

### 6.1 Layer ownership

| Concern | Layer | Why |
|---|---|---|
| Slack user identity, auth, channel resolution | Gateway (`adapter.ts`) | Pre-SDK; hook has no Slack access |
| Channel-trust tier resolution | Gateway (existing) | Pre-SDK |
| Blocked-user hard drop | Gateway (existing) | Pre-SDK |
| Engagement (mention parsing) | Gateway (existing) | Pre-SDK |
| Onboarding redirect (unknown role) | Gateway | Must short-circuit before SDK boot |
| Inject `<actor …/>` envelope | Gateway | So hooks can read role |
| Approval click verification (Block Kit) | Gateway (`approval-gate.ts`) | Outside SDK lifecycle |
| **Content scoring on inbound text** | **SDK `UserPromptSubmit` hook** | Block/mutate before model sees |
| **Content scoring on tool args** | **SDK `PreToolUse` hook** | Hook returns `{decision: block\|ask\|approve}` |
| **Content scoring on Slack output** | **SDK `PreToolUse` hook on `mcp__slaude_slack__{reply,edit,upload}`** | All output flows through MCP — single chokepoint |
| **Redact tool result (PII leak from `Read`, `Bash`)** | **SDK `PostToolUse` hook** | Scrub observation before agent re-reads |
| Permission-mode (`ask|accept-edits|bypass`) | Gateway (`permission-gate.ts canUseTool`) | Mode UX, not policy |
| `redactPatterns` regex | `format.ts` (existing, kept) | Deterministic fast layer pre-embedding scrub |

**No `Stop` hook needed.** slaude's design makes `mcp__slaude_slack__reply` the only output path, so `PreToolUse` on that tool name is the output scrub. Cleaner than typical Claude Code setups.

### 6.2 Hook handlers (call policy-service HTTP API)

```typescript
// src/agent/hooks.ts — Agent loop
import type { HookContext } from '@anthropic-ai/claude-agent-sdk'
import { PolicyClient } from '../policy/client'

const policyClient = new PolicyClient('http://localhost:8081')

export const userPromptSubmitHook = async (ctx: HookContext) => {
  const actor = parseActorEnvelope(ctx.message.content)
  const decision = await policyClient.check({
    text: stripEnvelopes(ctx.message.content),
    actor,
    channel: actor.channel_trust,
    hook_point: 'user_prompt',
  })
  return applyDecision(decision, ctx, 'user_prompt')
}

export const preToolUseHook = async (ctx: HookContext) => {
  const actor = ctx.session.actor                  // resolved at session boot
  const text = serializeToolInput(ctx.tool.name, ctx.tool.input)
  const decision = await policyClient.check({
    text,
    actor,
    channel: ctx.session.channel_trust,
    hook_point: ctx.tool.name.startsWith('mcp__slaude_slack__') ? 'output' : 'pre_tool',
  })
  return applyDecision(decision, ctx, 'pre_tool')
}

export const postToolUseHook = async (ctx: HookContext) => {
  const actor = ctx.session.actor
  const decision = await policyClient.check({
    text: ctx.tool.result,
    actor,
    channel: ctx.session.channel_trust,
    hook_point: 'post_tool',
  })
  if (decision.action === 'redact') {
    return { result: redactSpans(ctx.tool.result, decision.spans) }
  }
  return applyDecision(decision, ctx, 'post_tool')
}
```

**PolicyClient** is a lightweight HTTP wrapper:

```typescript
// src/policy/client.ts — Agent → policy-service client
export class PolicyClient {
  constructor(private baseUrl: string) {}

  async check(input: PolicyCheckInput): Promise<Decision> {
    const res = await fetch(`${this.baseUrl}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      timeout: 500,  // policy checks must be fast
    })
    if (!res.ok) throw new Error(`Policy check failed: ${res.statusText}`)
    return res.json()
  }

  async reload(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/reload`, { method: 'POST' })
    if (!res.ok) throw new Error(`Policy reload failed: ${res.statusText}`)
  }
}

### 6.3 Action × hook matrix

| Hook | `block` | `ask` | `redact` | `log` |
|---|---|---|---|---|
| `UserPromptSubmit` | replace prompt w/ rejection msg, short-circuit turn | inject `<approval-required rule="…">`, route to `request_approval` | regex/template scrub matched span | metric only |
| `PreToolUse` (bash/write/etc) | return `{decision: 'block', reason}` | return `{decision: 'ask'}` → `request_approval` | mutate args (rare) | metric only |
| `PreToolUse` on `mcp__slaude_slack__reply` | replace payload w/ refusal text | escalate via `request_approval` | redact PII in payload before post | metric only |
| `PostToolUse` | drop observation, replace w/ error stub | n/a (already executed) | scrub tool output before agent reads | metric only |

---

## 7. Decision Pipeline

### 7.1 `policyCheck()` signature

```typescript
interface PolicyCheckInput {
  text: string
  actor: ResolvedRole | { role: 'anonymous', groups: [], source: 'unknown' }
  channel: 'trusted' | 'allowed' | 'restricted'
  hook_point: 'user_prompt' | 'pre_tool' | 'post_tool' | 'output'
}

interface Decision {
  action: 'block' | 'ask' | 'redact' | 'log' | 'allow'
  rule_id?: string
  anchor_id?: number
  score?: number
  message?: string
  matched_rules: Array<{rule_id: string, anchor_id: number, score: number}>
}

async function policyCheck(input: PolicyCheckInput): Promise<Decision>
```

### 7.2 Algorithm

```
input: {text, actor, channel, hook_point}
  │
  ▼
query_vec = embedding_provider.embed([text])[0]
  │
  ▼
top-k 10 from policy_vec_<model> ordered by distance ASC
  │
  ▼
JOIN policy_anchors → policy_rules
  │
  ▼
filter:
  - hook_point ∈ rule.hook_points
  - similarity ≥ rule.threshold       (similarity = 1 - L2_distance/2 for L2-normalized)
  - actor.role ∉ rule.roles_denied
  - actor.role ∈ rule.roles_allowed OR rule.roles_allowed contains 'any'
  - channel ∈ rule.channels OR rule.channels contains 'any'
  │
  ▼
if any rule had actor.role ∈ roles_denied (regardless of allowed):
  upgrade severity to block        (denial is absolute)
  │
  ▼
reduce surviving rules → single action by severity precedence:
  block > ask > redact > log > allow
ties → lowest L2 distance wins (most semantically certain anchor)
  │
  ▼
emit Decision{action, rule_id, anchor_id, score, message, matched_rules}
```

### 7.3 Severity precedence rules

```
explicit roles_denied hit  → severity escalates to block (overrides ask/redact)
multiple rules hit         → max(severity) wins
tied severity              → lowest anchor distance wins
no rule hits               → allow + sample-log (configurable rate, default 5% prod / 100% dev)
```

### 7.4 Worked example

User in `#general` (channel_trust=`allowed`), role=`vendor`, sends: *"hey, what's the q3 roadmap looking like?"*

```
1. adapter.ts → resolve role = vendor → inject
     <actor user="Uvendor" role="vendor" channel_trust="allowed"/>
2. SDK UserPromptSubmit hook fires
3. embed("hey, what's the q3 roadmap looking like?") → query_vec
4. top-k anchors → "q3 roadmap" @ similarity 0.74 (rule discuss-roadmap-q3)
5. filter:
     - hook_point user_prompt ∈ rule.hook_points ✓
     - similarity 0.74 ≥ rule.threshold 0.6 ✓
     - vendor ∈ roles_denied [vendor, anonymous] → DENY trigger
     - vendor ∉ roles_allowed [manager, eng-lead, exec]
     - allowed ∈ rule.channels [trusted] ✗
   → rule's `ask` severity escalates to `block` due to roles_denied hit
6. action: block
7. hook returns prompt replacement:
     "Roadmap topic — restricted for your role. Ping #pm-team for public updates."
8. SDK turn ends without LLM call
9. metric: slaude_policy_blocks_total{rule="discuss-roadmap-q3",hook_point="user_prompt",role="vendor"} += 1
```

Same query from `eng-lead` in `#eng-internal` (`trusted`) → rule severity stays `ask` → routes to `request_approval` → manager click → proceed.

Same query from unknown role → onboarding fork at gateway (§8), never reaches hook.

---

## 8. Onboarding Fork (unknown role)

When `RoleResolver` returns null AND remote is reachable (i.e. user genuinely absent, not transient failure):

```
turn arrives → adapter.ts resolves role → null → assigned role=anonymous
  ↓
preflight policyCheck on inbound text
  ↓
if any rule triggers with severity ≥ ask (which is most rules for anonymous):
  short-circuit BEFORE SDK boot
  ↓
emit slaude_slack__reply with onboarding message:
  "I don't have you in my role map. Onboard here: <link>.
   Manager <@manager.userId> — please approve."
  ↓
if config.onboarding.manager_request_approval:
  post request_approval prompt to manager
  category: 'onboarding', summary: 'add user <@Uxxx> role'
  on approve → write to remote role source (via webhook or manual step)
  ↓
set pending-onboarding flag in sqlite per userId (TTL 24h)
  ↓
subsequent turns from same user while pending:
  drop with dedupe (post onboarding message once per dedup window 1h)
```

Prevents loop spam, gives manager clear approval path, keeps anonymous users from costing LLM cycles.

If remote is genuinely down (not "user not found"), `RoleResolver` returns explicit error → gateway returns "Auth service unavailable, retry shortly" instead of onboarding flow.

---

## 9. Concrete slaude Codebase Changes

### 9.1 New files — Policy Service

```
src/
  policy/                          # ← NEW: standalone policy-service module
    server.ts                      # Express/Hono HTTP server, routes: POST /check, /reload
    loader.ts                      # POLICY.md parse → Chroma build (sha-cached, hot-reload)
    check.ts                       # policyCheck() — embed query, rule filter, severity reduce
    store.ts                       # Chroma schema + vector store wrapper
    client.ts                      # HTTP client for agent to call policy-service
    types.ts                       # Rule, Anchor, Decision, PolicyCheckInput (shared types)
  embedding/                       # ← NEW: embedding providers (used by policy-service)
    provider.ts                    # EmbeddingProvider interface
    gemma.ts                       # GemmaEmbeddingProvider (default, local)
    openai.ts                      # OpenAIEmbeddingProvider
    bge.ts                         # BgeM3EmbeddingProvider
  roles/                           # ← NEW: role resolvers (used by both services)
    resolver.ts                    # RoleResolver interface
    remote-http.ts                 # RemoteHttpRoleResolver (default)
    soul-md.ts                     # SoulMdRoleResolver (fallback)
    null.ts                        # NullRoleResolver (dev)
    composite.ts                   # CompositeRoleResolver (chain)
    cache.ts                       # LRU + TTL + stale-while-revalidate
```

### 9.2 Modified files

| File | Change |
|---|---|
| `src/server.ts` | NEW: detect `SLAUDE_POLICY_MODE=enabled` → spawn policy-service on port 8081 + agent on port 3000. Both in same process tree, supervisored startup. |
| `src/agent/manager.ts` | Register hook handlers from `agent/hooks.ts` in SDK `hooks: {…}` option. Hooks call PolicyClient. Inject session-level `actor` + `channel_trust`. |
| `src/agent/hooks.ts` | NEW: Hook handlers that call PolicyClient (HTTP → policy-service). |
| `src/gateway/slack/adapter.ts` | Resolve role via RoleResolver before SDK boot. Inject `<actor …/>` envelope. Onboarding fork on unknown role. Stash actor on session. |
| `src/gateway/slack/permission-gate.ts` | Shrink — policy logic moves to hooks (via policy-service). Keep mode-based logic (`ask|accept-edits|bypass`). |
| `src/gateway/slack/format.ts` | `redactPatterns` regex stays as cheap pre-pass. |
| `~/.slaude/` layout | Add `POLICY.md` + `cache/policy/chroma/`. |
| `deploy/k8s/slaude.yaml` | Mount POLICY.md as ConfigMap; mount role-source bearer token as Secret. |

### 9.3 Server startup

```typescript
// src/server.ts
import { launchAgentManager } from './agent/manager'
import { launchPolicyService } from './policy/server'

async function main() {
  const policyMode = process.env.SLAUDE_POLICY_MODE === 'enabled'
  
  const policyPort = parseInt(process.env.SLAUDE_POLICY_PORT || '8081', 10)
  const agentPort = parseInt(process.env.PORT || '3000', 10)

  // Start policy-service first; if it fails, don't start agent
  if (policyMode) {
    await launchPolicyService({ port: policyPort })
    console.log(`Policy-service running on :${policyPort}`)
  }

  // Start agent; it calls policy-service if enabled
  await launchAgentManager({ port: agentPort, policyServiceUrl: policyMode ? `http://localhost:${policyPort}` : null })
  console.log(`Agent running on :${agentPort}`)
}

main().catch(err => {
  console.error('Startup failed:', err)
  process.exit(1)
})
```

### 9.4 Untouched

- `slaude_skills` MCP server (skill evolution)
- `approval-gate.ts` core flow — guardrails reuses `request_approval` for `ask` actions
- SOUL.md `## Approvers` semantics
- All Slack output formatting / mrkdwn conversion

---

## 10. Metrics

```
slaude_policy_checks_total{hook_point, result}
  result: block | ask | redact | log | allow

slaude_policy_blocks_total{rule_id, hook_point, role, channel}
slaude_policy_asks_total{rule_id, hook_point, role, channel}
slaude_policy_redacts_total{rule_id, hook_point, role, channel}

slaude_policy_score_bucket{hook_point}   # histogram of top-1 similarity

slaude_policy_load_duration_seconds       # boot embed cost
slaude_policy_anchors_count{model}        # cache size
slaude_policy_reload_total{result}        # hot-reload success/failure

slaude_role_resolver_requests_total{source, result}
slaude_role_resolver_latency_seconds_bucket{source}
slaude_role_resolver_failures_total{source, kind}
slaude_role_resolver_cache_size

slaude_embedding_requests_total{provider, result}
slaude_embedding_latency_seconds_bucket{provider}

slaude_onboarding_redirects_total{reason}  # user_unknown | remote_down
```

---

## 11. Configuration

### 11.1 Env vars

**Process control:**

| Var | Default | Purpose |
|---|---|---|
| `SLAUDE_POLICY_MODE` | `disabled` | `enabled` = start policy-service + agent; `disabled` = agent only (no policy checks) |
| `PORT` | `3000` | Agent port |
| `SLAUDE_POLICY_PORT` | `8081` | Policy-service port |
| `SLAUDE_POLICY_STARTUP_TIMEOUT_MS` | `10000` | Max time to wait for policy-service to boot |

**Policy-service config:**

| Var | Default | Purpose |
|---|---|---|
| `SLAUDE_POLICY_FILE` | `~/.slaude/POLICY.md` | Policy source |
| `SLAUDE_POLICY_CACHE_DIR` | `~/.slaude/cache/policy` | Chroma embeddings cache root |
| `SLAUDE_POLICY_SHADOW_MODE` | `0` | If `1`, log decisions but never enforce (eval mode) |
| `SLAUDE_EMBEDDING_PROVIDER` | `gemma` | Override POLICY.md frontmatter (`gemma` \| `openai` \| `bge-m3`) |
| `ROLE_API_TOKEN` | — | Bearer token for remote role source |
| `SLAUDE_ROLE_CACHE_TTL_SECONDS` | `600` | Override per-user cache TTL |

**Agent config:**

| Var | Default | Purpose |
|---|---|---|
| `SLAUDE_POLICY_SERVICE_URL` | `http://localhost:8081` | Policy-service URL (agent calls this) |
| `SLAUDE_POLICY_CHECK_TIMEOUT_MS` | `500` | HTTP timeout for policy checks (fail-open) |

### 11.2 Dev vs Prod knobs

| Knob | Dev | Prod |
|---|---|---|
| `defaults.threshold` | 0.7 (loose, fewer false positives) | 0.6 (tight, fewer false negatives) |
| Sample-log rate (no-hit) | 100% | 5% |
| `onboarding.enabled` | false (log-only) | true |
| `RoleResolver` | `NullRoleResolver` (everyone anon) or `SoulMdRoleResolver` | `CompositeRoleResolver(remote → soul_md)` |
| Embedding | gemma local | gemma local + openai shadow (eval) |
| `SLAUDE_POLICY_SHADOW_MODE` | `1` first weeks | `0` once tuned |

---

## 12. Trade-offs Acknowledged

- **Latency**: each embed call adds 50-300ms (local Gemma) or 100-500ms (OpenAI network). `UserPromptSubmit` + `PreToolUse` on every tool call compounds. Mitigation: batch when possible, skip score on read-only tools below cost ceiling, cache recent inputs.
- **False positives**: layered deterministic + semantic checks. Risk both reject legitimate query. Mitigation: sample-review boundary cases via shadow-mode logs, tune thresholds per category not global.
- **Embedding-judge manipulability**: input embeddings score against fixed anchors, not against a prompt — less susceptible than LLM-judge but still bypassable via novel phrasings the anchors don't cover. Mitigation: keep `redactPatterns` regex layer + periodic anchor refresh from real production traffic.
- **Multi-runtime cache duplication**: each container rebuilds its own sqlite-vec cache. Acceptable at tier 2 (small policy). Mitigation if painful: shared volume for `cache/policy/`.
- **Onboarding loop**: if remote source is silently broken (returns 200 with empty body), users get onboarding spam. Mitigation: dedupe window + alert on `slaude_role_resolver_failures_total` rate.
- **Policy = source code**: POLICY.md changes are git-PR-reviewed, not edited via UI. Fine for slaude scope; would need tier-3 for compliance-team ownership.

---

## 13. Build Order

**Phase 1: Shared modules**

1. `EmbeddingProvider` interface + `GemmaEmbeddingProvider` (local).
2. `RoleResolver` interface + `RemoteHttpRoleResolver` + LRU cache + `CompositeRoleResolver` w/ SOUL.md fallback.
3. `PolicyCheckInput`, `Decision`, `Rule`, `Anchor` types (shared).

**Phase 2: Policy-service (runs standalone on :8081)**

4. POLICY.md parser → Chroma loader w/ sha-cached chunks.
5. `policyCheck(input) → Decision` — embed, top-k, filter, severity reduce.
6. HTTP server (`src/policy/server.ts`): `POST /check`, `POST /reload`, `GET /health`.
7. Metrics surface (policy-service metrics).
8. Hot-reload watcher on POLICY.md, reload endpoint.
9. `SLAUDE_POLICY_SHADOW_MODE` flag.

**Phase 3: Agent integration (calls policy-service via HTTP)**

10. `PolicyClient` HTTP wrapper (`src/policy/client.ts`).
11. SDK `UserPromptSubmit` hook handler. Wire into `agent/manager.ts`.
12. SDK `PreToolUse` hook handler — branch on `mcp__slaude_slack__*` for output scoring.
13. SDK `PostToolUse` hook handler — observation redaction.
14. Server startup logic (`src/server.ts`): spawn policy-service + agent, supervise both.
15. Gateway: actor envelope injection + onboarding fork (existing `adapter.ts`).

**Phase 4: Eval + tuning**

16. Eval harness: diff shadow-mode decisions against approver clicks; tune thresholds.
17. Threshold tuning loop (requires eval corpus from decision #4).

---

## 14. Open Decisions

| # | Question | Owner | Blocking? |
|---|---|---|---|
| 1 | POLICY.md frontmatter for all policy config, or split between SOUL.md and POLICY.md? | Barock | No — default to all-in-POLICY.md |
| 2 | Onboarding redirect message → manager DM, or in-channel reply? | Barock | No — default in-channel + manager `request_approval` |
| 3 | At tier 3, when policy-service becomes independent: does agent discover policy-service URL from a config service, or hardcode in env? | Barock | No — hardcode env for v1; tier 3 adds service discovery |
| 4 | Eval corpus source for tuning thresholds — synthetic, prod replay, or human-curated set? | Barock | Yes — needs ~100 labeled samples before prod cutover |
| 5 | Gemma runtime — transformers.js (JS) or ONNX (faster, native bindings)? | Barock | Yes — affects boot/latency budget + policy-service startup time |
| 6 | How to handle role updates without restart — file watch on SOUL.md fallback only, or hot remote role poll? | Barock | No — file watch covers fallback; remote already has TTL |

---

## 15. Two-Service Supervision

Both services run in the same container but as distinct processes. Startup and liveness:

```typescript
// src/server.ts supervision logic
const child = spawn('node', ['build/policy-service-main.js'], {
  stdio: 'inherit',
  detached: false,
})

// Health check: poll policy-service before marking agent ready
async function waitForPolicyService(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { timeout: 500 })
      if (res.ok) return true
    } catch (e) {
      // expected, not up yet
    }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`Policy-service failed to start within ${timeoutMs}ms`)
}

// On agent startup: wait for policy-service if enabled
if (policyMode) {
  await waitForPolicyService(policyServiceUrl, 10000)
}
```

**Health endpoints:**

- **Policy-service** `GET /health` — returns 200 if Chroma + embedding model ready
- **Agent** `GET /healthz` (existing) — returns 200 if SDK ready; includes policy-service status
- **Readiness** `GET /readyz` (existing) — both services healthy + Slack connection ready

**Failure modes:**

| Scenario | Behavior |
|---|---|
| Policy-service fails to start | Agent startup fails (fast-fail); container exits with error |
| Policy-service crashes mid-run | Agent continues; policy checks timeout (fail-open, allow by default) |
| POLICY.md parse fails on reload | Hot-reload skipped, old policy stays active; metric + alert emitted |
| Chroma unavailable | `policyCheck` panics; agent catches + logs as policy-service error |

**Logs:**

- Both services write to stdout (containerized). K8s collects both via single `logs` command.
- Distinguish by prefix: `[policy-service]` vs `[agent]` in structured logs.

---

## 16. Future Extensions (out of scope for v1)

- **Tier-3 compliance UI** — admin app authoring rules into separate store (when policy >500 rules or compliance team owns it).
- **Policy versioning + canary** — A/B test new rule set on subset of users.
- **Federated anchor corpus** — share jailbreak anchors across slaude deployments (opt-in).
- **Conversation-level memory of past decisions** — if user asks same blocked thing twice, surface earlier rejection in approver UI.
- **Per-actor risk score** — accumulate policy hits per user; escalate threshold dynamically for repeat-offenders.
- **LLM-judge as third layer** — for genuinely ambiguous cases that pass embedding but a human approver keeps flagging, add `self_check_input`-style LLM judge as final gate. Skip for v1 (latency cost).

---

## 17. References

- Wiki: [[ent-slaude]], [[src-slaude]]
- Wiki: [[con-llm-guardrails]] — pattern foundation
- Wiki: [[con-semantic-classification-embeddings]] — embedding mechanism
- Wiki: [[cmp-langchain-vs-nemo-guardrails]] — comparable framework analysis
- Wiki: [[ent-claude-agent-sdk]] — hook API surface
- Source bundle: [[src-guardrails-implementation]]
