# 2026-07-08 — Per-channel token and model metrics

**Context**: Token consumption was previously aggregated strictly by `kind` (input/output/cache_read/cache_creation). To enable downstream cost calculation (e.g., in Grafana), the metrics needed granularity down to the specific Slack channel and the active LLM model.

**Decision**: 
Augment the `slaude_tokens_total` Prometheus counter with two new labels: `channel_id` and `model`.

**Mechanism**:
- `manager.ts` fetches the active `slack_channel_id` from the SQLite session store using the `sessionId` when the SDK yields a `result`.
- Extracts the active model from the SDK message, falling back to `SLAUDE_MODEL`.
- Passes `{ channel_id, model, kind }` to `metrics.tokensTotal.inc()`.
- Exposing the model and channel labels allows downstream aggregators to multiply token counts by per-model rates to estimate cost accurately without hardcoding pricing within the slaude runtime.
