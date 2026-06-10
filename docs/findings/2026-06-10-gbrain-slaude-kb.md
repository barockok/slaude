# gbrain × slaude — powering slaude_kb with a real brain

**Date:** 2026-06-10
**Status:** Phases 1-3 implemented (slaude_kb v2 scoped brain + gated writes + KB wiki indexing; brain-backed memory provider; nightly maintenance cycle). Phase 4 (multi-agent team brain on Postgres) designed, not yet implemented.
**Verdict:** **Adopt gbrain. Embed as a Bun library, not as an external process.** License (MIT), stack (Bun ≥1.3.10, TypeScript, ESM), and architecture (engine library + MCP server + skills) all line up with slaude. The fit is unusually good — gbrain was built to be operated *by* an agent platform, and slaude *is* an agent platform missing exactly the brain layer gbrain ships.

Repo studied: [garrytan/gbrain](https://github.com/garrytan/gbrain) @ v0.42.38.0 (clone at `/tmp/gbrain` during research). Note: **the npm package named `gbrain` is an unrelated project** (stormcolor/gbrain) — garrytan/gbrain must be consumed as a git dependency (`bun add github:garrytan/gbrain`) and pinned in `slaude.lock`-style fashion via `package.json` + `bun.lock`.

---

## 1. What gbrain is (the 5-minute version)

- **Engine library**: `connectEngine()` → `BrainEngine` over PGLite (embedded, zero-config) or Postgres/Supabase (pgvector). Schema: `sources`, `pages` (markdown + YAML frontmatter → `compiled_truth` + JSONB), `content_chunks` (embeddings, HNSW), `links` (typed knowledge-graph edges), `timeline_entries`, `facts`, `takes`, `minion_jobs` (BullMQ-style Postgres-native job queue).
- **Zero-LLM knowledge graph**: every `put_page` reconciles edges via regex/NER extraction — wikilinks `[[people/alice]]`, markdown links, typed frontmatter (`key_people → works_with`), mention detection. No LLM calls on the write path. Benchmarked +31.4 P@5 over vector-only RAG.
- **Synthesis layer (`think`)**: intent → gather (hybrid search + graph BFS + takes + timeline + trajectory) → synthesize (Claude) → **answer with citations, explicit gaps, and conflicts**. This is the "brain reads the pages for you" part.
- **100+ operations** exposed identically via CLI, stdio MCP (`gbrain serve`), and HTTP MCP (`--http`, OAuth 2.1) — all routed through one `operations.ts` registry with an `OperationContext { remote, auth, sourceId, takesHoldersAllowList }`.
- **RBAC**: source-scoped, asymmetric. Per-client `source_id` = single **write** authority; `federated_read: string[]` = **read** union. Enforcement is fail-closed SQL `WHERE` filtering in `sourceScopeOpts()` / `resolveRequestedScope()` (`src/core/operations.ts:396-450`) — `remote=true` callers can never widen scope; explicit out-of-grant `source_id` → `permission_denied`. Fuzz-tested read paths, zero leaks claimed.
- **Dream cycle**: ~22 dependency-ordered maintenance phases (lint → sync → extract → consolidate → embed → purge …) run nightly via `gbrain dream --json` (cron-friendly one-shot) or `gbrain autopilot` (self-installing daemon + minion queue, idempotency-keyed). Consolidation clusters un-consolidated facts per entity and synthesizes them into `takes` — never deletes, audit trail preserved.
- **43 skills** in a gbrain-specific `SKILL.md` format (RESOLVER.md dispatcher). **Not** claude-code-skill compatible — port selectively, don't import wholesale.
- **No approval flow.** Writes are immediate; audit trails (`ingest_log`, `mcp_request_log`, actor attribution) enable post-hoc review only. This is the one hole slaude must fill — and slaude already has the machinery (ApprovalGate/PermissionGate).

## 2. Integration shape: embed the engine, keep slaude's identity plumbing

Three options considered:

| Option | Shape | Verdict |
|---|---|---|
| A. External MCP | `gbrain serve` in `~/.slaude/.mcp.json` | Rejected as primary. Zero code, but the stdio server is one connection per deploy — no per-Slack-user scoping, no approval interception, double-process ops. Fine as a *day-1 spike*. |
| B. **Library embed** | `import { connectEngine } from 'gbrain'`; slaude builds its own in-process `slaude_kb` MCP backed by `BrainEngine` + the `operations` registry | **Chosen.** Slaude already builds 6 in-process MCP servers per session and already resolves the live Slack `userId` per tool call (`route.ctx.userId`). We construct a fresh `OperationContext` per call with identity baked in, and we can gate writes through ApprovalGate before they hit the engine. |
| C. HTTP brain + OAuth per user | `gbrain serve --http`, one OAuth client per Slack user | Rejected for single-deploy MVP (token lifecycle overhead for users who never asked for it). **Adopted later for the multi-agent team brain** (§6), where OAuth-per-agent is exactly right. |

Key trick for option B: even though slaude is in-process (trusted), **call operations with `remote: true` and a synthetic `AuthInfo`** (`{ clientId: slackUserId, sourceId, allowedSources }`). That makes gbrain's own fail-closed SQL enforcement do the scoping — defense in depth, not app-layer convention (gbrain's own docs call convention-only scoping "Model B" and warn it's not DB-enforced). Slaude becomes the identity broker; gbrain stays the enforcer.

```
Slack event ──▶ gateway resolves userId + thread lock ──▶ scope resolver
                                                              │
                                              OperationContext{ remote:true,
                                                auth:{ clientId:U123…,
                                                       sourceId, allowedSources } }
                                                              │
   slaude_kb MCP tools (think/search/get_page/put_page/…) ────┤
   ApprovalGate intercepts cross-slice writes ────────────────┤
                                                              ▼
                                            gbrain BrainEngine (PGLite @ ~/.slaude/brain/)
```

Brain home: `~/.slaude/brain/` (PGLite dir). One deploy = one persona = **one brain** — matches slaude's deploy unit exactly.

## 3. Identity & RBAC mapping ("agent has identity")

gbrain's scope unit is the **source**. Map slaude's social topology onto sources:

| gbrain source | Holds | Write authority | Read visibility |
|---|---|---|---|
| `agent` | The agent's own mind: episodic memory pages, learned concepts, soul-adjacent knowledge, syntheses | The agent itself (any turn) | Agent always; humans via the agent's answers (citations), never raw by default |
| `shared` | Team institutional memory: people/company/project pages, meeting notes, channel digests | Approval-gated (§4) | Everyone in trusted channels |
| `public` | Sanitized knowledge for public/allowed channels | Manager-approved only | All channels incl. public |
| `user-<slackId>` | A person's private slice — what they tell the agent in `/1on1` | That user's locked threads, auto | Only that user's locked threads + the agent when serving them |
| `kb-<label>` | Each installed KB wiki from `slaude.json` (synced from git, read-mostly) | `/ingest` pipeline only | Per-KB config; default trusted channels |

Per-turn scope resolution (the load-bearing function, lives next to the existing `mcpResolver`):

```
/1on1 locked thread (locked_user = U):
  write → user-U          read → [user-U, shared, public, kb-*]
trusted channel:
  write → shared (gated)  read → [shared, public, kb-*, agent†]
public/allowed channel:
  write → none (capture→inbox only)   read → [public]
agent's own turns (cron, dream, memory sync):
  write → agent           read → everything
manager:
  same as trusted + may approve writes anywhere; /brain admin ops
```

† `agent` source readable in trusted channels via `think` synthesis (the agent quoting its own memory), but raw `get_page` on `agent/*` stays agent-only — mirrors how the existing memory provider is internal.

This is gbrain's asymmetric write-one/read-many model used exactly as designed (`source_id` + `federated_read`), with slaude's existing identity signals — SoulData channels lists, `one_on_one_locks`, manager/backup — as the policy inputs. The `/1on1` story gets materially better: today isolation is OAuth-config-dir level; with gbrain it extends to **DB-enforced private knowledge slices**. Same spirit as the per-initiator `CLAUDE_CONFIG_DIR` finding, applied to memory.

`takes_holders` mapping: agent's own hunches → holder `agent`; per-user observations → holder `user-<id>`; default allow-list per scope mirrors `federated_read`. Private hunches about people never leak into shared synthesis.

## 4. Approval flow (the part gbrain doesn't have)

gbrain ships **audit, not approval**. Slaude supplies the human-in-the-loop, reusing both existing gates:

1. **Tier 0 — auto (no gate):** reads (`search`, `think`, `get_page`, graph traversal), writes into the caller's own slice (`user-<self>` in locked thread; `agent` source on agent turns), `capture` into `inbox/` (triage-by-convention, like gbrain's own inbox pattern).
2. **Tier 1 — PermissionGate (tool-level, fast):** `put_page` to `shared` from a trusted channel. Rendered as the existing `slaude_perm` allow/always/deny buttons; "always" grants the session. `SLAUDE_AUTO_ALLOW_TOOLS` can whitelist for high-trust deploys.
3. **Tier 2 — ApprovalGate (agent-initiated, routed):** cross-slice writes, `delete_page`, link surgery on shared pages, anything touching `public`, schema-pack changes. Goes through `request_approval` → Block Kit → SoulData `approvers` scope routing (`kb: <ids>` scope). Same machinery as today, new category `kb`.
4. **Tier 3 — manager-only:** `purge` (hard delete past recovery window), source create/archive, dream-cycle config changes, brain re-init. Routes to `manager`/`backupManager` only.

Mechanism: a thin `gatedDispatch(op, params, ctx)` wrapper in front of gbrain's `dispatchToolCall`. Classify op × target-source → tier → maybe await gate → dispatch. Attribution flows through: every write stamps `ctx.auth.clientId = slack userId`, and `ingest_log` rows become the audit trail the policy-guardrails design (2026-05-21 finding) wanted — Tier-2/3 guardrails can later read the same log.

Dream-cycle writes (consolidate, enrich) run **pre-authorized** as the agent (Tier 0 within `agent`/derived rows) — approval gates are for *human-facing scope crossings*, not nightly hygiene. Anything the cycle wants to write into `shared` (e.g. enriched person pages) lands as a **proposal page in `inbox/`** plus a morning-briefing line, so a human promotes it. That keeps the "wake up smarter" loop unattended without silent shared-truth mutation — consistent with slaude's autonomy rule (act freely, ask only when it matters).

## 5. Background process mapping

| gbrain mechanism | slaude mapping |
|---|---|
| `gbrain dream --json` nightly | **System-level cron job created at install** (not an agent-prompt cron): slaude server schedules an internal job that runs the cycle via library call (`runCycle(engine, phases)`) — no subprocess needed, same process, same PGLite handle. Report posted to a configured ops thread via existing cron→channel plumbing. |
| `gbrain autopilot` daemon + minion queue | Deferred. Slaude's process *is* the daemon (one container = one persona). Minion queue adoption replaces `kb_ingest_jobs` when we need durable retries — note `minion_jobs` is a near-superset of `kb_ingest_jobs` (status, heartbeat→lock_until, retries, parent jobs). |
| Ingestion recipes (email/X/meetings) | Out of scope for slaude core (Slack-only). **The Slack workspace itself is the ingestion source**: a new `slack-turns` source feeds `conversations/` pages — thread digests on session idle-close, channel daily digests via cron. Signal-detector pattern (zero-LLM entity extraction per message) runs in `syncTurn`: Slack users → `people/` stubs, channels → `channels/` stubs, timeline entries appended. |
| `capture` / inbox folder | `/ingest` keeps its UX; internally `/ingest` for a `kb-<label>` becomes: drop raw into the brain's inbox + run gbrain's ingest path, replacing the bespoke sub-query wiki pipeline over time. Quick capture from chat: agent calls `put_page` to `inbox/YYYY-MM-DD-<hash>` (gbrain's own convention). |
| Consolidation / enrich_thin / citation fixing | Run as dream phases. `enrich_thin` is brain-internal (no web calls), Haiku-priced, opt-in — good default-on candidate for `agent` + `shared` sources. |
| Memory consolidation | **This replaces slaude's memory roadmap.** `GbrainMemoryProvider implements MemoryProvider`: `prefetch(sessionId)` → hybrid search + graph neighborhood for the thread's entities → `<memory-context>` (replaces last-5-turns + flat facts); `syncTurn` → append to the session's conversation page + signal-detect. Nightly consolidate turns conversations → facts → takes. Episodic + semantic memory — the North Star bullets — drop out of gbrain for free. |

Cost discipline (gbrain contract: "no silent defaults"): surface the search-mode cost matrix at install/first-init in the setup output; default `balanced`, store choice in brain config. Embedding provider via existing `ANTHROPIC_BASE_URL`-style env (gbrain's `ai/gateway` is multi-provider).

## 6. Agents as identities, agents as tools

Slaude's model: **multi-agent = multi-deploy**, each with its own Slack identity + SOUL.md. gbrain gives this model its missing shared substrate:

- **Solo agent (MVP):** private PGLite brain per deploy. The agent has a mind of its own — `agent` source — satisfying "Agent has identity" at the *memory* level, not just persona level. Soul KB-first rule becomes enforceable: the system prompt directs `slaude_kb think` before external action (the brain-ops "brain-first lookup" skill pattern, ported).
- **Team of agents:** flip `engine-factory` to Postgres (`SLAUDE_BRAIN_DATABASE_URL`) and the same brain serves N slaude deploys. Each agent registers as a **gbrain OAuth client** (`gbrain auth register-client agent-<name> --source agent-<name> --federated-read agent-<name>,shared,public`). Now agents *are tools to each other*, mediated by the brain: agent A writes a finding into `shared`, agent B's `think` cites it next turn. No agent-to-agent protocol needed — the brain is the bus, citations are the contract, RBAC keeps each agent's private slice private. A human asking agent B can get an answer grounded in agent A's work, with provenance (`actor: mcp:agent-a…`).
- **Direct agent-as-tool (later):** one slaude deploy can mount another agent's `gbrain serve --http` as an external MCP in `~/.slaude/.mcp.json` with a read-scoped token — querying a peer's public brain slice like any other tool. The existing `/mcp connect` OAuth flow (global scope, 2026-06-10 finding) already handles the token ceremony.

This is the "interacting with others as tools" answer in slaude's spirit: identity stays per-deploy (Slack identity + SOUL + brain slice), interaction happens through scoped, cited, audited brain reads/writes rather than ad-hoc message passing.

## 7. The experience (what users feel)

- **Ask in thread** → agent answers from the brain *synthesized with citations and explicit gaps* ("the brain hasn't seen anything about X since April — want me to ask?"). Today's `search_kbs` keyword hits become real answers.
- **Meeting-prep moment**: "what do I need before meeting Alice?" works because every Slack interaction has been feeding people/timeline pages silently.
- **`/1on1` becomes a private notebook**: things told to the agent in a locked thread land in `user-<id>` and *provably* never surface elsewhere (DB-enforced, not prompt-enforced).
- **Approval feels native**: a shared-knowledge write shows the same Block Kit card users already know, with diff-style summary + the source page link.
- **Morning briefing cron**: think-powered digest — what changed in the brain, what consolidated overnight, proposals waiting in inbox.
- **Owner ops**: `/brain status` (pages/entities/last dream report), `/brain dream` (manual cycle), `/ingest` unchanged.

## 8. Migration plan

1. **Spike (day 1):** `bun add github:garrytan/gbrain#<sha>`; `gbrain init --pglite` under `~/.slaude/brain/`; mount `gbrain serve` as external MCP read-only; import one existing KB wiki; eyeball `think` quality. Zero slaude code.
2. **Phase 1 — slaude_kb v2:** in-process MCP backed by `BrainEngine`: `think`, `search`, `get_page`, `list_pages`, `put_page`, graph tools. Scope resolver (§3) + `gatedDispatch` (§4). Existing 3 KB tools kept as aliases over the new engine. Migrate KB wikis: `sync` each `~/.slaude/knowledge/<label>/wiki/` as a `kb-<label>` source (gbrain syncs markdown dirs natively — wikis stay git-backed, brain indexes them).
3. **Phase 2 — memory:** `GbrainMemoryProvider` behind the existing `MemoryProvider` interface (clean swap — interface already abstracts this); Slack-turn capture + signal detection; keep sqlite provider as fallback flag.
4. **Phase 3 — dream cycle:** nightly internal cron, phases `sync,extract,extract_facts,consolidate,recompute_emotional_weight,embed,orphans,purge` to start; ops-thread report; inbox-proposal flow for shared enrichment.
5. **Phase 4 — team brain:** Postgres/Supabase engine option + per-agent OAuth clients; multi-deploy shared memory.

## 9. Risks & open questions

- **Git-dep churn**: gbrain moves fast (v0.42.x); pin a sha, upgrade deliberately, watch `pglite-schema` migrations. The `onboard --check --json` health probe is scriptable into slaude boot.
- **Skill format mismatch**: port ~4 skills (query/brain-ops, ingest, maintain, briefing) into slaude's claude-code-compatible `SKILL.md`; do not vendor the 43.
- **No per-page ACL** in gbrain — slice granularity is the source. Many `user-<id>` sources is the supported pattern (sources table is cheap), but cross-cutting "this one page is secret" needs convention or a Tier-2 gate, not DB enforcement.
- **PGLite single-writer**: dream cycle + live turns share one process — fine (gbrain's cycle lock handles overlap); the moment we want concurrent workers, that's the Postgres trigger.
- **Embedding spend**: chunk embedding on a chatty workspace adds up; `conservative` mode (keyword-only) is a valid cheap start, matrix shown to operator.
- **Open**: do `kb-<label>` wikis remain the system of record in git (brain = index) or does the brain become primary with git export? Leaning git-primary for KBs (matches dependency-manifest design), brain-primary for `agent`/`shared`/`user-*`.

## Decision

Adopt gbrain as slaude's brain layer per above. Supersedes the bespoke roadmap items for semantic KB search, fact extraction, and the embedding-provider TODO in the memory open-decision. Phase 1 is the next implementation milestone.

## Implementation notes (Phase 1, 2026-06-10)

Plan: `docs/superpowers/plans/2026-06-10-gbrain-slaude-kb-phase1.md`. New modules:

- `src/knowledge/brain.ts` — PGLite engine lifecycle under `$SLAUDE_BRAIN_HOME` (default `~/.slaude/brain/`; sets `GBRAIN_HOME` there), `brainCall` (remote:true + synthetic AuthInfo → gbrain SQL scoping), `brainAdminCall` (remote:false, boot/admin), `ensureSources`.
- `src/knowledge/scope.ts` — Slack identity → `BrainScope`; sources `agent`/`shared`/`public`/`user-<id>`/`kb-<label>`.
- `src/knowledge/gated-dispatch.ts` — op tier classification (auto/approval/manager/deny) + Surface `requestApproval` bridge.
- `src/knowledge/brain-sync.ts` — installed KB wikis imported as `kb-<label>` sources at boot.
- `src/knowledge/mcp-tools.ts` — slaude_kb v2: `kb_think/kb_search/kb_get_page/kb_list_pages/kb_graph/kb_put_page/kb_delete_page` (legacy 3 tools kept).

Spike caveats that shaped the code:
- A `put_page` into a nonexistent source spins indefinitely — `ensureSources()` runs at gateway boot before any tool can write.
- `sync_brain` source routing falls back to "sole non-default source"; `syncKbWikis` pins `GBRAIN_SOURCE` per call, sequentially.
- gbrain's TS sources don't compile under slaude's tsc strictness — `brain.ts` erases import specifiers (`gbrainImport`) so typecheck never descends into the package.
- `sources_list` returns `{ sources: [...] }`, not a bare array.
- npm `gbrain` is unrelated; dep pinned to `github:garrytan/gbrain#03ffc6e`.

Env: `SLAUDE_BRAIN_HOME` (override location), `SLAUDE_BRAIN_DISABLED=1` (kill switch — legacy keyword tools remain).

## Implementation notes (Phases 2-3, 2026-06-10)

- `src/memory/brain-provider.ts` + `src/memory/index.ts` — `BrainMemoryProvider` is the default memory when the brain is enabled (`SLAUDE_MEMORY=sqlite` reverts). Each session gets a `conversations/<sessionId>` page in the `agent` source; turns append as timeline entries (rows, not page rewrites — avoids `page_versions` bloat). Prefetch renders the last 5 entries as `<recent-turns>`. Failure policy: memory never breaks a turn — prefetch degrades to null, syncTurn to a logged no-op. Note: `get_page` throws `OperationError(code=page_not_found)` rather than returning null.
- `src/knowledge/brain-cycle.ts` — `runNightlyMaintenance()` (KB wiki re-sync → per-wiki extraction → orphan report → purge expired soft-deletes) scheduled in-process at 03:00 local (`SLAUDE_BRAIN_CYCLE="HH:MM"|"off"`). In-process because PGLite is single-writer: an external `gbrain dream` subprocess cannot run while the server holds the engine lock.
- Soul baseline KB-first stance now leads with `kb_think`/`kb_search` and documents `kb_put_page` for durable knowledge.
- **Known gap:** `[[wikilink]]`s in fs-synced wiki sources produce 0 graph edges via `runExtractCore`/`runExtract --source db` (tried qualified slugs, markdown links, `link_resolution.global_basename`) — resolution rules need upstream investigation. Agent `put_page` writes DO reconcile edges inline (verified), so the agent-authored graph works; only imported-wiki cross-links are missing edges. Hybrid/keyword search over wikis is unaffected.

## Enabling semantic search (remote embedding model)

Vectors are opt-in; keyword+graph search needs no keys. To enable:

Simplest path — provider-generic env (mirrors the `ANTHROPIC_BASE_URL` pattern; any OpenAI-compatible `/v1/embeddings` endpoint):

```
EMBEDDING_URL=https://api.openai.com/v1      # or any compatible endpoint
EMBEDDING_API_KEY=sk-...
EMBEDDING_MODEL=text-embedding-3-small       # default if unset
EMBEDDING_DIMENSIONS=1536                    # default if unset; locks schema at first embed
```

`applyEmbeddingEnv()` (runs at brain boot) maps these onto gbrain's `litellm:` recipe (its generic base-URL+key passthrough) and writes `embedding_model`/`embedding_dimensions` into `~/.slaude/brain/config.json` — without ever clobbering an operator-set `embedding_model`.

Alternative — gbrain-native provider config: set the provider's own key env (e.g. `ZEROENTROPY_API_KEY` for `zeroentropyai:zembed-1`, $0.05/1M tok) and write `embedding_model` in config.json directly. Needed for providers whose APIs are NOT OpenAI-compatible (ZeroEntropy's native asymmetric API among them).

Either way, once `embedding_model` is set the nightly sync drops `no_embed` and new/changed chunks embed from then on; gbrain stamps chunks per-model and re-embeds stale ones, so enabling late backfills naturally. Decision: embeddings stay remote — no local daemon in the deploy unit. Slaude-scale spend ≈ pennies/month; the real cost lever is the reranker (`tokenmax` mode), not embeddings.

Known limit: chunks created by `kb_put_page`/memory between cycles embed only when a sync touches them; a dedicated stale-chunk embed sweep (gbrain's `embed` command is CLI-only) is future work if query-time gaps show up.

## Phase 4 (not implemented)

Team brain: flip engine to Postgres (`database_url`), register per-agent OAuth clients, point multiple slaude deploys at one brain. All slaude-side plumbing (scope resolver, gated dispatch) is engine-agnostic already; the work is config + ops, not code.
