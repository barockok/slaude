# 2026-05-21 — Policy Guardrails (Tier 2 / Tier 3 Design)

- **Policy guardrails design spec drafted** (`docs/guardrails-design.md`). Goal: policy-driven safety layer that enforces based on content semantic similarity + role context, designed to position tier 3 (compliance-managed policies, independent service). See design doc for full architecture.
- **Two-service model within one container**: Policy-service runs on port 8081; agent calls via HTTP on SDK hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`). Shared types (Rule, Decision, PolicyCheckInput) + separate HTTP boundary. Both services supervised by a single `src/server.ts` entry point.
- **Architecture decisions locked in**:
  - **Vector backend**: Chroma (tier 3 ready; swappable policy-store interface allows tier 2 sqlite-vec if needed for testing).
  - **Role source**: remote HTTP (POLICY.md frontmatter `role_source.type: remote_http`); fallback to `## Roles` in SOUL.md for offline operation.
  - **Embedding provider**: EmbeddingGemma 300M (local, Apache 2.0, multilingual, ~50ms/text); pluggable via `EmbeddingProvider` interface. OpenAI + BGE-M3 optional.
  - **Unknown role behavior**: most-restrictive default + onboarding fork (in-channel msg + manager `request_approval`). Prevents silent denials.
  - **Hook enforcement**: `policyCheck(actor, channel, content, hook_point) → Decision{action, rule_id, score, message}`. SDK hooks apply Decision. Gateway does not duplicate policy checks (only role resolution + engagement).
- **Build order** splits into 4 phases: (1) shared modules (EmbeddingProvider, RoleResolver, types), (2) policy-service (loader, Chroma, HTTP server, hot-reload), (3) agent integration (PolicyClient, hooks, supervision), (4) eval + tuning.
- **Blocking decisions remaining** (§14 in design doc):
  - (#4) **Eval corpus source** for threshold tuning: synthetic (fast, unrealistic), prod replay (realistic, slow), or human-curated (covers edge cases, labor-intensive)?
  - (#5) **Gemma runtime**: transformers.js (JS, portable) or ONNX (native bindings, faster)?
- **Non-blocking** (defaults set): POLICY.md frontmatter only (no split with SOUL.md), onboarding in-channel + request_approval, per-container policy-service (no shared cache volume tier 2).
- **Tier 3 path clear**: policy-service HTTP boundary + `PolicyStore` interface abstraction mean `src/policy/` can graduate to independent microservice (docker, k8s) without refactoring agent. POLICY.md stays git-tracked in slaude repo until tier 3, at which point policy source moves to policy-service repo / admin UI.
