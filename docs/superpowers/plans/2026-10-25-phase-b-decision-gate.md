# Phase B — Decision Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before any Claude turn, a cheap System One decision model decides whether an inbound mention or engaged-thread message deserves a turn. The gate is configurable `off | shadow | on`, and `off` is today's behaviour exactly.

**Architecture:**
- **`src/decision/`** is a generic, provider-neutral decision service. It holds the types for a decision request (shared state plus named multiple-choice questions) and its answers (the chosen option plus a confidence), a `DecisionAdapter` interface, and an adapter registry. **Jev is one adapter** (`src/decision/adapters/jev.ts`). Other adapters can be added later without touching any consumer.
- **The gate** (`src/gateway/gate/`) is the first consumer. It owns its four questions in neutral form, the policy table, a rules fallback equal to today's behaviour, a context builder, and a runner (mode, timeout, fallback, per-event memo, logs, metrics).
- `gateway.ts` calls the runner before engagement is written or a turn is dispatched.

**Tech Stack:** Bun + TypeScript, `bun test`, `src/net/outbound-policy.ts` (`safeFetch`), Slack Web API client (`conversations.replies`, `reactions.add`), the brain's `gather()` search.

**Spec:** `docs/superpowers/specs/2026-10-25-teammate-agent-epic-design.md` §7 (Phase B), with §2 rows "Decision-gate question type and key name", "Decision function is abstract" and "Gate unsure about a direct @mention", and §11.2 invariant 4.

## Global Constraints

- **Public repo:** generic placeholders only in code, tests, fixtures and commit text (CLAUDE.md "Working Rules"). Run the leak-scan grep over `git diff --cached -U0` before every commit. No `Co-Authored-By` or "Generated with" trailers; never commit under an AI identity.
- **Default is `off`:** with `gate.mode` `off` (the default, including when `SLAUDE_DECISION_CONFIG` is unset), engagement and dispatch behave exactly as today. This is spec §11.2 invariant 4, and Task 5's equivalence test proves it.
- **The decision core knows nothing about Slack, the gate or any provider.** Nothing outside `src/decision/adapters/<name>.ts` may import an adapter module. Consumers obtain an adapter only through the registry.
- **Process config only, never the SOUL. It's one JSON variable, `SLAUDE_DECISION_CONFIG`:**
  ```json
  {
    "timeoutMs": 800,
    "gate": { "mode": "off", "tAct": 0.8, "contextMessages": 8 },
    "adapter": {
      "type": "jev",
      "url": "https://api.typesafe.ai/v1/systemone",
      "model": "jev-latest",
      "apiKey": "env://TYPESAFE_API_KEY"
    }
  }
  ```

  | Field | Values | Default |
  |---|---|---|
  | `timeoutMs` | int > 0 | `800` |
  | `gate.mode` | `off` \| `shadow` \| `on` | `off` |
  | `gate.tAct` | 0–1 | `0.8` |
  | `gate.contextMessages` | int > 0 | `8` |
  | `adapter` | an object whose `type` names a registered adapter, or absent / `null` | absent: no adapter |
  | `adapter.*` (when `type` is `jev`) | `url` (default `https://api.typesafe.ai/v1/systemone`), `model` (default `jev-latest`), `apiKey` (**required**) | — |

  - **Unset or `{}`:** the gate is `off` and there is no adapter, exactly today's behaviour.
  - **Fields:** every field is optional except an adapter's required ones. Unknown top-level keys are rejected.
  - **Each adapter validates its own block** with its own schema. The core validates only `timeoutMs`, `gate` and `adapter.type`.
  - **Invalid JSON or a failed validation:** log one line at boot naming the bad field, never its value. The gate is then `off` and there is no adapter; the process does not crash.
  - **An adapter whose block is invalid, or whose secret won't resolve:** logged once. There is no adapter, so the gate uses its rules fallback.
- **Secrets inside the config are references, never values.** `apiKey` must be an `env://NAME` or `vault://…` reference, resolved at boot through the existing secret resolver (`src/secrets/`: `parseRef`, `createSecretResolver`). A literal string is rejected as invalid, so a key never sits in the config variable, which deploy tooling tends to print.
- **`SLAUDE_DECISION_CONFIG` and `TYPESAFE_API_KEY` are both gateway-only:** both go in `GATEWAY_ONLY_ENV_NAMES`, so the agent child never inherits them and a node refuses them. The config variable is listed too because its URL and references describe the operator's setup.
- **Jev contract** (spec §7.3, inside the Jev adapter only):
  - `POST <adapter.url>` with `Authorization: Bearer <key>` and `Content-Type: application/json`.
  - Body: `{ model, state, questions }`. Each neutral question maps to `{ type: "choice", instructions, criteria: { <option>: <text>, … } }`.
  - Answers are keyed by question id: `{ type: "choice", choice, probabilities, confidence }`.
  - Error handling:
    - 401 and 422 are not retried;
    - 429 and 529 get one retry, only if `retry-after` fits in the remaining time;
    - any error, timeout or invalid output rejects with a `DecisionError`. The consumer falls back, and never reads it as "no".
- **Policy (spec §7.4), with `T_act` defaulting to `0.8`:**

  | Situation | Action |
  |---|---|
  | mentioned, and `addressedToAgent` is yes with confidence ≥ `T_act` | `run` |
  | mentioned, any other case | `record_doubt`: record only, react `thinking_face`, log, engagement unchanged |
  | engaged and not mentioned, with `isQuestionOrRequest` yes ∧ `agentCanHelp` yes (each ≥ `T_act`) ∧ `alreadyAnswered` is not yes ≥ `T_act` | `run` |
  | engaged and not mentioned, any other case | `record` |

- **Bypass:** DMs, slash commands, interactive actions, and any thread with a `/1on1` lock never call the gate.
- **Metrics:**
  - `slaude_decision_requests_total{adapter,outcome}`, from the core, with `outcome` one of `ok|timeout|error`;
  - `slaude_gate_decisions_total{action,source,mode}`, from the gate, with `source` one of `adapter|rules`;
  - `slaude_gate_shadow_disagree_total{would,actual}`.
- **Progress tracking:** each task's commit ticks its line under "Progress → Phase B tasks" in the epic spec.
- **Ships as stable** (spec §5), behind the `off` default.
- **Deviation from spec §7.7, planned up front:** "a sim scenario per row of §7.4" is covered by gateway-level tests with an injected adapter (Task 5), the same substitution phase A made. The sim's stub agent has no way to choose a gate decision.

## Review Focus

1. **The two deliveries of one mention** (`app_mention` and the `message` copy) must make at most one adapter call per event on a replica, and must reach the same decision. Task 4 test: `two deliveries of one event share one adapter call`.
2. **An adapter returns an answer with an option the question didn't offer, or omits a question.** The core rejects it as `bad_output`, and the gate falls back to rules. Task 1 test: `answers outside the declared options are rejected`.
3. **A `record_doubt` mention in a brand-new thread with no session row.** It reacts 🤔, writes no session, and doesn't engage. A later real mention still works. Task 5 test: `doubt on a fresh thread creates no session`.
4. **Shadow mode must not add latency or change behaviour,** even when the adapter hangs past its timeout. Task 4 test: `shadow never delays dispatch`.
5. **Thread history fetch fails** (`conversations.replies` rejects or returns `ok:false`). The gate still decides with `recent: []` and doesn't throw. Task 3 test: `history failure yields empty recent`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/decision/types.ts` (create) | `DecisionQuestion`, `DecisionRequest`, `DecisionAnswer`, `DecisionResult`, `DecisionAdapter`, `DecisionError`. |
| `src/decision/registry.ts` (create) | `registerAdapter`, `adapterFromConfig`, `decide()` (validation, timeout, metrics). |
| `src/decision/adapters/jev.ts` (create) | The Jev adapter; registers itself as `"jev"`. |
| `src/decision/adapters/index.ts` (create) | Imports every adapter module (one line each) so their registrations run. |
| `src/gateway/gate/types.ts` (create) | `GateInput`, `GateDecision`, `GateAction`. |
| `src/gateway/gate/questions.ts` (create) | The gate's four neutral questions; `toGateDecision(answers)`. |
| `src/gateway/gate/policy.ts` (create) | `decideAction`, `rulesDecision`. |
| `src/gateway/gate/context.ts` (create) | `buildGateInput`. |
| `src/gateway/gate/runner.ts` (create) | `makeGateRunner`, `gateRunnerFromEnv`. |
| `src/decision/config.ts` (create) | `parseDecisionConfig`: the `SLAUDE_DECISION_CONFIG` JSON. |
| `src/config/env.ts`, `src/config/gateway-only-env.ts`, `src/metrics.ts`, `docs/site/_content/reference/configuration.md` (modify) | Config, secret and metrics wiring. |
| `src/gateway/core/gateway.ts` (modify) | `GatewayOptions.gateRunner?`; call sites. |
| `tests/decision/*.test.ts`, `tests/gateway/gate/*.test.ts`, `tests/gateway/core/decision-gate.test.ts` (create) | Tests. |

---

### Task 1: Decision core, gate questions, policy, rules fallback

**Files:**
- Create: `src/decision/types.ts`, `src/decision/registry.ts`, `src/decision/config.ts`, `src/decision/adapters/index.ts` (empty list for now), `src/gateway/gate/types.ts`, `src/gateway/gate/questions.ts`, `src/gateway/gate/policy.ts`
- Test: `tests/decision/registry.test.ts`, `tests/gateway/gate/policy.test.ts`

**Interfaces:**
- Produces (decision core):
```ts
export interface DecisionQuestion { instructions: string; options: Record<string, string> }       // option id → description; ≥ 2 options
export interface DecisionRequest { state: unknown; questions: Record<string, DecisionQuestion> }
export interface DecisionAnswer { choice: string; confidence: number }                              // choice ∈ the question's option ids; 0 ≤ confidence ≤ 1
export type DecisionResult = Record<string, DecisionAnswer>;                                         // exactly the request's question ids
export interface DecisionAdapter { readonly name: string; decide(req: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> }
export class DecisionError extends Error { constructor(readonly kind: "auth" | "invalid_request" | "rate_limited" | "overloaded" | "transport" | "timeout" | "bad_output", msg: string) }
// registry.ts
export type AdapterFactory = (block: Record<string, unknown>, deps: { resolveSecret: (ref: string) => Promise<string> }) => Promise<DecisionAdapter>; // throws on an invalid block
export function registerAdapter(type: string, factory: AdapterFactory): void;
export async function adapterFromConfig(block: unknown, deps: { resolveSecret: (ref: string) => Promise<string> }): Promise<DecisionAdapter | null>;
  // null for absent/null; an unknown type, a factory throw or a secret failure → null, logged once (field names only)
export async function decide(adapter: DecisionAdapter, req: DecisionRequest, timeoutMs: number): Promise<DecisionResult>; // timeout, validation, metrics
// config.ts (decision core)
export interface DecisionConfig { timeoutMs: number; gate: { mode: "off" | "shadow" | "on"; tAct: number; contextMessages: number }; adapter: Record<string, unknown> | null }
export function parseDecisionConfig(raw: string | undefined): { config: DecisionConfig; error?: string }; // error = field path only; on error the config is the all-default (gate off, adapter null)
```
- Produces (gate):
```ts
export type Trust = "trusted" | "allowed" | "restricted";
export interface GateInput { message: string; recent: { role: "agent" | "user"; text: string }[]; mentionsAgent: boolean; engaged: boolean; kbHitScore: number | null; channelTrust: Trust }
export interface Answer { value: boolean; confidence: number }
export interface GateDecision { addressedToAgent: Answer; isQuestionOrRequest: Answer; agentCanHelp: Answer; alreadyAnswered: Answer }
export type GateAction = "run" | "record" | "record_doubt";
export const GATE_QUESTIONS: Record<keyof GateDecision, DecisionQuestion>;   // questions.ts
export function toGateDecision(r: DecisionResult): GateDecision;             // "yes" → value true
export function decideAction(input: GateInput, d: GateDecision, tAct: number): GateAction;  // policy.ts
export function rulesDecision(input: GateInput): GateDecision;               // today's behaviour
```
- `GATE_QUESTIONS` copy (exact). Every question has `options: { yes: <yes text>, no: <no text> }`:
  - `addressedToAgent`:
    - instructions: "The state holds a new chat message and the recent thread. `<agent>` is an AI teammate. Decide whether the new message is said TO `<agent>` (asking, telling or replying to it), as opposed to only mentioning or talking ABOUT `<agent>` to other people."
    - yes: "spoken to <agent>"
    - no: "about <agent>, or to someone else"
  - `isQuestionOrRequest`:
    - instructions: "Decide whether the new message asks a question or requests that something be done."
    - yes: "a question or a request"
    - no: "a statement, reaction, thanks or chit-chat"
  - `agentCanHelp`:
    - instructions: "Decide whether an AI teammate with access to the team's knowledge base could usefully answer or act on the new message. `kbHitScore` is the top knowledge-base match score from 0 to 1, or null when unknown."
    - yes: "the teammate could add something useful"
    - no: "nothing useful to add"
  - `alreadyAnswered`:
    - instructions: "Decide whether someone in the recent thread has already answered or handled the new message."
    - yes: "already answered or handled"
    - no: "still open"

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/decision/registry.test.ts
it("decide returns the adapter's validated answers", ...);
it("answers outside the declared options are rejected", async () => { /* adapter returns choice "maybe" → rejects DecisionError kind "bad_output" */ });
it("a missing question or out-of-range confidence is rejected", ...);
it("decide times out", async () => { /* hanging adapter, timeoutMs 30 → DecisionError kind "timeout" within ~100ms */ });
it("adapterFromConfig: absent → null; unknown type → null; registered → that adapter; factory throw → null", ...);
it("parseDecisionConfig: unset or {} → gate off, no adapter, timeoutMs 800", ...);
it("parseDecisionConfig: invalid JSON or out-of-range field → all-default config and an error naming the field, not its value", async () => {
  const r = parseDecisionConfig('{"gate":{"tAct":2}}');
  expect(r.config.gate.mode).toBe("off"); expect(r.error).toContain("gate.tAct"); expect(r.error).not.toContain("2");
});
it("parseDecisionConfig: unknown top-level key is rejected", ...);
// tests/gateway/gate/policy.test.ts — yes = {value:true,confidence:1}, no = {value:false,confidence:1}
it("mention addressed with confidence ≥ tAct runs", () =>
  expect(decideAction({ ...base, mentionsAgent: true }, { ...allNo, addressedToAgent: { value: true, confidence: 0.8 } }, 0.8)).toBe("run"));
it("mention addressed below tAct is doubt", () =>
  expect(decideAction({ ...base, mentionsAgent: true }, { ...allNo, addressedToAgent: { value: true, confidence: 0.79 } }, 0.8)).toBe("record_doubt"));
it("mention judged not-addressed is doubt", () => expect(decideAction({ ...base, mentionsAgent: true }, allNo, 0.8)).toBe("record_doubt"));
it("engaged question the agent can help with, unanswered, runs", () =>
  expect(decideAction({ ...base, engaged: true }, { ...allNo, isQuestionOrRequest: yes, agentCanHelp: yes }, 0.8)).toBe("run"));
it("engaged but already answered records", () =>
  expect(decideAction({ ...base, engaged: true }, { ...allNo, isQuestionOrRequest: yes, agentCanHelp: yes, alreadyAnswered: yes }, 0.8)).toBe("record"));
it("engaged chit-chat records", () => expect(decideAction({ ...base, engaged: true }, allNo, 0.8)).toBe("record"));
it("rulesDecision + policy reproduce today: mention runs, engaged runs", () => {
  expect(decideAction({ ...base, mentionsAgent: true }, rulesDecision({ ...base, mentionsAgent: true }), 0.8)).toBe("run");
  expect(decideAction({ ...base, engaged: true }, rulesDecision({ ...base, engaged: true }), 0.8)).toBe("run");
});
it("GATE_QUESTIONS are yes/no and toGateDecision maps them", ...);
```

- [ ] **Step 2: Run them and confirm they fail.** `bun test tests/decision/ tests/gateway/gate/policy.test.ts`. Expected: FAIL, because the modules are missing.
- [ ] **Step 3: Implement.**
  - `decide` wraps the call in `AbortSignal.timeout(timeoutMs)`, validates the result against the request, and counts `slaude_decision_requests_total{adapter,outcome}`.
  - `rulesDecision` sets:
    - `addressedToAgent` = yes when `mentionsAgent`;
    - `isQuestionOrRequest` and `agentCanHelp` = yes;
    - `alreadyAnswered` = no;
    - every confidence = `1`.
  - `decideAction` follows the policy table exactly. A mention takes the mention rows even when the thread is engaged.
- [ ] **Step 4: Run the tests and typecheck.** `bun test tests/decision/ tests/gateway/gate/policy.test.ts && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Tick B1 and commit.** Message: `feat(decision): provider-neutral decision core; gate questions, policy and rules fallback`.

---

### Task 2: Jev adapter

**Files:**
- Create: `src/decision/adapters/jev.ts`
- Modify: `src/decision/adapters/index.ts` (add `import "./jev";`)
- Test: `tests/decision/jev-adapter.test.ts`. It uses a local `Bun.serve` fake on loopback, with `allowLoopback: true` passed through `outboundOpts`.

**Interfaces:**
- Consumes: the Task 1 decision types and `registerAdapter`; `safeFetch` and `OutboundPolicyOptions` from `src/net/outbound-policy.ts`.
- Produces:
```ts
export interface JevOpts { url: string; apiKey: string; model: string; outboundOpts?: OutboundPolicyOptions }
export function makeJevAdapter(o: JevOpts): DecisionAdapter;   // name "jev"
// module side effect: registerAdapter("jev", factory). The factory validates the block
// { type:"jev", url?: string (default "https://api.typesafe.ai/v1/systemone"), model?: string (default "jev-latest"), apiKey: string }
// with a strict schema, requires apiKey to parse with parseRef (env:// or vault://; a literal is rejected), resolves it via deps.resolveSecret,
// and returns makeJevAdapter(...).
```

- [ ] **Step 1: Write the failing tests.** The fake records each request and replies with a canned body or status.

```ts
it("maps a neutral request to Jev: model, state, choice questions with option criteria, bearer auth", async () => { /* body.questions.q.type==="choice"; criteria equals the options map; Authorization: Bearer k */ });
it("maps Jev answers back to { choice, confidence }", async () => { /* {type:"choice",choice:"no",probabilities:{...},confidence:0.9} → {choice:"no",confidence:0.9} */ });
it("401 throws auth without retry", async () => { /* 1 request; kind "auth" */ });
it("429 with retry-after inside the remaining time retries once", async () => { /* retry-after: 0 then 200 → resolves; 2 requests */ });
it("529 with retry-after beyond the remaining time throws overloaded without retry", async () => { /* retry-after: 5, 800ms signal → kind "overloaded"; 1 request */ });
it("a non-JSON or answer-less 200 throws bad_output", ...);
it("factory: env:// apiKey resolves; a literal apiKey or a missing apiKey is rejected", async () => { /* adapterFromConfig({type:"jev",apiKey:"env://K"}, {resolveSecret}) → name "jev"; {apiKey:"sk-live-x"} → null; {} → null */ });
it("factory: url and model default when omitted; unknown block keys rejected", ...);
```

- [ ] **Step 2: Run them and confirm they fail.** `bun test tests/decision/jev-adapter.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Status mapping:
  - 401 → `auth`;
  - 422 → `invalid_request`;
  - 429 → `rate_limited`;
  - 529 → `overloaded`;
  - other non-2xx and transport failures → `transport`.

  A 429 or 529 gets one retry, only when `retry-after` (in seconds) fits in the time before the signal's deadline. Never log the API key or the request body.
- [ ] **Step 4: Run the tests and typecheck.** `bun test tests/decision/ && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Tick B2 and commit.** Message: `feat(decision): Jev adapter`.

---

### Task 3: Gate input builder

**Files:**
- Create: `src/gateway/gate/context.ts`
- Test: `tests/gateway/gate/context.test.ts`

**Interfaces:**
- Consumes: the Task 1 gate types; `rankScore(hit)` from `src/knowledge/gather.ts`.
- Produces:
```ts
export interface GateContextDeps {
  replies: (channel: string, threadTs: string, limit: number) => Promise<Array<{ user?: string; bot_id?: string; text?: string; ts: string }>>;
  kbSearch: ((query: string) => Promise<Array<{ score?: number; rerank_score?: number }>>) | null; // null when the brain is off
  selfIds: { botUserId: string; botIds: Set<string> };
}
export async function buildGateInput(e: { channel: string; ts: string; thread_ts?: string; text: string },
  o: { mentionsAgent: boolean; engaged: boolean; channelTrust: Trust; contextMessages: number }, d: GateContextDeps): Promise<GateInput>;
export function resolveMentions(text: string, botUserId: string): string; // <@BOT> → <agent>, other <@U…> → <user>
```

- [ ] **Step 1: Write the failing tests.**

```ts
it("resolves mentions to roles", () => expect(resolveMentions("<@UBOT> ask <@U123> pls", "UBOT")).toBe("<agent> ask <user> pls"));
it("recent excludes the new message, keeps the last N, maps roles", async () => { /* 12 replies incl. self bot and the event ts; contextMessages 8 → 8 items, none with the event ts, self → "agent" */ });
it("top-level message has empty recent and no replies call", ...);
it("history failure yields empty recent", async () => { /* replies rejects → recent [], no throw */ });
it("kbHitScore is the clamped top rankScore, null without a brain or on error", async () => { /* [{score:0.4},{rerank_score:1.7}] → 1; kbSearch null → null; rejects → null */ });
```

- [ ] **Step 2: Run them and confirm they fail.** `bun test tests/gateway/gate/context.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Fetch `contextMessages + 1` replies and drop the event's own ts. A message is `agent` when `user === botUserId` or its `bot_id` is in `botIds`.
  - `kbHitScore` = `Math.min(1, Math.max(0, rankScore(top)))`. Normalisation across engines is left to the builder (spec §12); keep it to this clamp.
- [ ] **Step 4: Run the tests and typecheck.** `bun test tests/gateway/gate/context.test.ts && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Tick B3 and commit.** Message: `feat(gate): build gate input from the thread and a KB score`.

---

### Task 4: Gate runner, config, metrics, secret handling

**Files:**
- Create: `src/gateway/gate/runner.ts`
- Modify:
  - `src/config/env.ts`: add `decisionConfigRaw()` returning `opt("SLAUDE_DECISION_CONFIG")`, next to `autoEvolve`;
  - `src/config/gateway-only-env.ts`: add `"SLAUDE_DECISION_CONFIG"` and `"TYPESAFE_API_KEY"`;
  - `src/metrics.ts`: add `decisionRequestsTotal`, `gateDecisionsTotal` and `gateShadowDisagreeTotal` to `m`;
  - `docs/site/_content/reference/configuration.md`: add one row for `SLAUDE_DECISION_CONFIG` with the field table and the JSON example, plus a commented example in the env block.
- Test: `tests/gateway/gate/runner.test.ts`, plus a `tests/config` case asserting that `isGatewayOnlyEnv` holds for both names.

**Interfaces:**
- Consumes: Tasks 1–3; `parseDecisionConfig`, `adapterFromConfig`, `decide`.
- Produces:
```ts
export type GateMode = "off" | "shadow" | "on";
export interface GateResult { action: GateAction; mode: GateMode; source: "adapter" | "rules"; adapter: string | null; decision: GateDecision; latencyMs: number }
export interface GateRunner {
  readonly mode: GateMode;
  readonly contextMessages: number;
  /** off → undefined (caller keeps today's path). shadow → resolves "run" immediately; the decision runs detached and is logged. on → the decided action. */
  gate(key: string, input: () => Promise<GateInput>, actual: GateAction): Promise<GateAction | undefined>;
}
export function makeGateRunner(o: { mode: GateMode; adapter: DecisionAdapter | null; tAct: number; timeoutMs: number; contextMessages: number; log?: (line: string) => void; memoTtlMs?: number }): GateRunner;
export async function gateRunnerFromEnv(deps: { resolveSecret: (ref: string) => Promise<string> }): Promise<GateRunner>;
  // imports src/decision/adapters/index.ts; parseDecisionConfig(env.decisionConfigRaw()); logs its error once; adapterFromConfig(config.adapter, deps)
```
- The gateway builds `resolveSecret` from the existing secret resolver (`createSecretResolver` in `src/secrets/index.ts`), the same way provider credentials are resolved. It awaits `gateRunnerFromEnv` once at boot. Until it resolves, the gate is treated as `off`.
- With `adapter === null`, the decision is `rulesDecision(input)` with `source: "rules"`, and no core call happens.
- Memo: the key is `${channel}:${eventTs}`, with a default TTL of `60_000` ms. It stores the in-flight promise.
- Log line format: `[gate] mode=<m> source=<s> adapter=<a|-> action=<a> ms=<n> key=<k> a=<v>:<c> q=<v>:<c> h=<v>:<c> d=<v>:<c>`. Never log message text.

- [ ] **Step 1: Write the failing tests.** Use a fake adapter that counts calls and can resolve, reject, or hang.

```ts
it("off returns undefined and never calls the adapter", ...);
it("on returns the policy action from the adapter's answers", ...);
it("no adapter uses rules without a core call", ...);
it("adapter error or timeout falls back to rules with source rules", ...);
it("two deliveries of one event share one adapter call", async () => { /* same key twice concurrently → 1 call, same action */ });
it("shadow never delays dispatch", async () => { /* hanging adapter; gate() resolves "run" in < 20ms; a later "record" answer counts a disagreement */ });
it("gateRunnerFromEnv: unset config → mode off; invalid JSON → mode off, one log line without the raw value", ...);
it("gateRunnerFromEnv: valid config with an unresolvable secret → configured mode, rules source", ...);
```

- [ ] **Step 2: Run them and confirm they fail.** `bun test tests/gateway/gate/runner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Count `gateDecisionsTotal{action,source,mode}` for every decision, shadow included.
  - In shadow mode, increment `gateShadowDisagreeTotal{would,actual}` when the action differs from `actual`.
  - All config validation lives in `parseDecisionConfig` (Task 1) and in the adapter factories (Task 2). The runner only consumes the parsed config.
- [ ] **Step 4: Run the tests and typecheck.** `bun test tests/decision/ tests/gateway/gate/ tests/config/ && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Tick B4 and commit.** Message: `feat(gate): runner with modes, rules fallback, memo and metrics; config and secret wiring`.

---

### Task 5: Wire the gate into the gateway

**Files:**
- Modify: `src/gateway/core/gateway.ts`:
  - `GatewayOptions` (line ~233): add `gateRunner?: GateRunner`; the default is the runner `gateRunnerFromEnv(...)` resolves to at boot, treated as `off` until it does;
  - the `app_mention` handler (~3065);
  - the `mentionsBot` branch (~3133);
  - the `mentionedPersona` branch (~3148);
  - the engaged plain-message branches (~3216, ~3224, ~3239).
- Test: `tests/gateway/core/decision-gate.test.ts`. Reuse the `makeGw` / `msg` / `mention` / `nextTs` helpers pattern from `tests/gateway/core/durable-gates.test.ts:63-91`, and inject `gateRunner` (built with a fake adapter) through `createGateway(agent, t, { gateRunner })`.

**Interfaces:**
- Consumes: `GateRunner.gate` and `buildGateInput`. The gateway builds the deps:
  - `replies` from `args.client.conversations.replies`;
  - `kbSearch` from `gather()` over `resolveBrainScope({ ...(await brainGateFor(ctx)), kbSources: personaKbSourceIds(personaId) })` when `brainEnabled()`, else `null`;
  - `selfIds` from `getBotId` and `getSelfBots`.

  Also `channelTrustFor`, `OneOnOne.find`, and the runner's `gate.contextMessages`. Expose `contextMessages` on `GateRunner` as a readonly field.

Gate placement:
- **Mention paths** (`app_mention`, `mentionsBot`, `mentionedPersona`):
  - before `engageOnMention`, unless the thread has a `/1on1` lock, compute `act = await gateRunner.gate(key, () => buildGateInput(...), "run")`;
  - `undefined` or `"run"` → today's code, unchanged;
  - `"record_doubt"` → `reactions.add({ channel, timestamp: e.ts, name: "thinking_face" })` (failure caught and logged). Then, if a session row exists for the thread, `handleMessage(args, { suppress: true, personaId })`; otherwise log and stop. Never call `engageOnMention`.
- **Engaged plain branches:**
  - before `handleMessage(args, …)`, unless the thread is locked, compute the action with `actual "run"`;
  - `undefined` or `"run"` → unchanged;
  - `"record"` → `handleMessage(args, { suppress: true, personaId })`.
- **Bypassed:** DMs, the colleague-mention disengage path, mention-only threads and slash commands are not touched.

- [ ] **Step 1: Write the failing tests.**

```ts
it("off: every existing engagement scenario is unchanged", ...);
it("on with no adapter equals off", ...);
it("doubt on a mention reacts thinking_face and does not engage", ...);
it("doubt on a fresh thread creates no session", ...);
it("engaged chit-chat is recorded, a helpful question runs", ...);
it("a /1on1-locked thread never calls the gate", ...);
it("DMs never call the gate", ...);
it("shadow behaves exactly like off", ...);
```

- [ ] **Step 2: Run them and confirm they fail.** `bun test tests/gateway/core/decision-gate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the placement above.** Pass the persona id through to `handleMessage` exactly as the existing branch does.
- [ ] **Step 4: Run the tests and the engagement suites.** `bun test tests/gateway/core/decision-gate.test.ts tests/gateway/core/durable-gates.test.ts tests/gateway/core/pass-engagement.test.ts tests/gateway/core/multi-app-self.test.ts tests/gateway/core/tombstoned-persona.test.ts && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Tick B5 and commit.** Message: `feat(gateway): consult the decision gate before mention and engaged-thread turns`.

---

### Task 6: Field note, full suite, phase close-out

**Files:**
- Create: `docs/site/_content/field-notes/2026-10-25-decision-gate.md`
- Modify: `CLAUDE.md` (Findings Log, newest first); the epic spec Progress section.

- [ ] **Step 1: Write the field note.**
  - **Mechanism:** a provider-neutral decision core with adapters (Jev the first), consumed by a gate that runs before the turn. Covers the policy table, the rules fallback equal to today's behaviour, the per-event memo, the doubt reaction, and shadow mode as the evaluation path.
  - **Spec adjustments:** two-option Choice questions instead of Noul, because the confidence field is needed; `TYPESAFE_API_KEY` is gateway-only.
  - **Data egress:** thread text goes to a third party only when an adapter is configured.
  - **Not verified:** the live Jev API (the contract comes from a third-party reference, and the vendor docs host was unreachable from the build environment); shadow data from real threads; latency under load.
- [ ] **Step 2: Index it at the top of the Findings Log in `CLAUDE.md`.**
- [ ] **Step 3: Run the whole suite and typecheck.** `bun test && bun run typecheck`. Expected: no failures beyond the environment-only set recorded for phase A. List any other failure and check it on the base commit.
- [ ] **Step 4: Mark Phase B done and commit.** Tick B6 and set Phase B to "done (unreleased)". Message: `docs: phase B field note; mark phase B done in the epic`.
