# Per-agent brain slices: private minds, deliberate sharing

**Date:** 2026-07-24
**Status:** shipped (branch `feat/per-agent-brain-slices`)

## Problem

The KB write gate carded the human on *every* in-conversation `kb_memoize`
outside a `/1on1`. The runtime baseline tells the agent to proactively record
durable knowledge, but the infra asked for approval each time — the persona and
the gate contradicted each other. Two structural causes:

1. **The only auto-pass paths were `userId === null` (background/cron) and the
   `/1on1` own-user slice.** A normal Slack turn always carries `ctx.userId`, so
   an agent-initiated memoize in a trusted channel was attributed to the human
   and classified `approval`.
2. **`AGENT_SOURCE = "agent"` was a single literal.** With a brain shared across
   multiple agent identities (the remote brain-server design), every persona
   would write into the same `agent` source — their minds merge.

## Why not the obvious fix

The first instinct was a `calledByAgent` flag: auto-pass when the memoize was the
agent's own initiative. Rejected — **intent is unknowable at the gate.** "The
agent decided to save this" and "the user said remember this" arrive as the
*identical* tool call. The only way to populate such a flag is to trust the model
to self-report, which is self-attested and gameable. It cannot be an
authorization input.

## The model: classify DESTINATION, not intent

Three slices, keyed on where the write lands:

| Slice          | Owner     | Write gate            | Readable by                       |
| -------------- | --------- | --------------------- | --------------------------------- |
| `user-<id>`    | one human | auto in their `/1on1` | that human + the serving agent    |
| `agent-<id>`   | one agent | **auto for that agent** | **only that agent** (private mind) |
| `shared`       | the team  | approval (grant-collapsed) | all agents + all humans      |
| `public`/`kb-*`| curated   | read-only             | everyone                          |

- **Default `kb_memoize` target is `"mine"`** → the agent's own `agent-<id>`
  slice (the user's slice inside a `/1on1`). Auto-passes.
- **`target:"shared"`** overrides the write to `shared` and cards — including
  the manager. Writing to the common KB is legitimately approval-worthy; the
  standing grant collapses repeat cards per thread.
- The distinguishing signal is the **write destination**, which the model picks
  explicitly — not a self-reported intent. Escalating to `shared` is the
  deliberate act worth a card.

The agent's own `agent-<id>` slice is in the read union of *every* turn it runs,
regardless of who is talking — it holds its identity across turns, so it always
recalls its own notes. No *other* agent (nor a direct human query) sees it;
cross-agent knowledge flows only through `shared`.

## Identity anchor

At the brain layer an agent source is already just a federated source like a
user's — the only asymmetry was the identifier. `agentSourceId(id)` mirrors
`userSourceId(id)`. The id resolves once at boot:

1. `SLAUDE_AGENT_ID` env — deterministic, recommended for multi-agent deploys.
2. `auth.test` on the posting token — the bot user id, or the user id under
   post-as-user. Same identity namespace as humans.
3. `"default"` — single-agent / test / brain-disabled fallback.

Resolved value is cached process-wide; early memory writes await resolution so
nothing splits between `agent-default` and `agent-<id>`. Per-agent slices are
NOT baseline sources — like `user-<id>` they are ensured lazily at first write,
so the brain server never needs to know the agent's identity.

## Legacy continuity (non-destructive)

Rather than a destructive rename of an existing single-agent `agent` source, the
legacy `agent` source stays in the agent's read union. Existing memory remains
visible while new memory accretes in `agent-<id>`; a consolidation rename can be
a later opt-in CLI. A destructive source-rename inside a security-sensitive gate
change was judged the riskier path.

## Files

- `src/knowledge/scope.ts` — `agentSourceId`, `ScopeInput.agentId`,
  `resolveBrainScope` default-write + read-union rewrite.
- `src/knowledge/agent-identity.ts` — id resolution + cache + `agentScope()`.
- `src/knowledge/gated-dispatch.ts` — agent-slice auto-pass line.
- `src/knowledge/mcp-tools.ts` — `kb_memoize` `target`.
- `src/knowledge/brain.ts` — drop `agent` from `baselineSources`.
- `src/memory/brain-provider.ts` — per-agent scope + await identity.
- `src/gateway/core/gateway.ts` — boot resolution + `brainGateFor` wiring.
