# Phase B — Decision Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before any Claude turn, a cheap System One decision model decides whether an inbound mention or engaged-thread message deserves a turn. The gate is configurable `off | shadow | on`, and `off` is today's behaviour exactly.

**Architecture:**
- A provider-neutral gate lives in `src/gateway/gate/`. It has pure types and a policy table, a `rules` backend that reproduces today's behaviour, and a `jev` backend over the existing outbound-fetch policy.
- A context builder assembles the thread excerpt and a KB hit score. A runner applies the mode, timeout, fallback, per-event memo, logs and metrics.
- `gateway.ts` calls the runner at the three mention entry points and the engaged plain-message branches, before engagement is written or a turn is dispatched.

**Tech Stack:** Bun + TypeScript, `bun test`, `src/net/outbound-policy.ts` (`safeFetch`), Slack Web API client (`conversations.replies`, `reactions.add`), the brain's `gather()` search.

**Spec:** `docs/superpowers/specs/2026-10-25-teammate-agent-epic-design.md` §7 (Phase B), with §2 rows "Decision-gate question type and key name" and "Gate unsure about a direct @mention", and §11.2 invariant 4.

## Global Constraints

- **Public repo:** generic placeholders only in code, tests, fixtures and commit text (CLAUDE.md "Working Rules"). Run the leak-scan grep over `git diff --cached -U0` before every commit. No `Co-Authored-By` or "Generated with" trailers; never commit under an AI identity.
- **Default is `off`:** with `SLAUDE_DECISION_GATE=off` (the default), engagement and dispatch behave exactly as today. This is spec §11.2 invariant 4, and Task 5's equivalence test proves it.
- **Process config only, never the SOUL:**

  | Variable | Values | Default |
  |---|---|---|
  | `SLAUDE_DECISION_GATE` | `off` \| `shadow` \| `on` | `off` |
  | `SLAUDE_DECISION_BACKEND` | `jev` \| `rules` | `rules` |
  | `SLAUDE_DECISION_T_ACT` | 0–1 | `0.8` |
  | `SLAUDE_DECISION_TIMEOUT_MS` | int | `800` |
  | `SLAUDE_DECISION_CONTEXT_MESSAGES` | int | `8` |
  | `SLAUDE_DECISION_MODEL` | Jev model id | `jev-latest` |
  | `SLAUDE_DECISION_JEV_URL` | URL | `https://api.typesafe.ai/v1/systemone` (added so tests can point at a fake server) |
  | `TYPESAFE_API_KEY` | secret | none |

- **`TYPESAFE_API_KEY` is gateway-only:** it goes in `GATEWAY_ONLY_ENV_NAMES`, so the agent child never inherits it and a node refuses it.
- **Jev contract (spec §7.3):**
  - `POST <SLAUDE_DECISION_JEV_URL>` with `Authorization: Bearer <key>` and `Content-Type: application/json`.
  - Body: `{ model, state, questions }`.
  - Every question is `{ type: "choice", instructions, criteria: { yes: <text>, no: <text> } }`.
  - Answers are keyed by question id: `{ type: "choice", choice, probabilities, confidence }`.
  - Error handling:
    - 401 and 422 are not retried;
    - 429 and 529 get one retry, only if `retry-after` fits in the remaining timeout;
    - any error, timeout or invalid output falls back to `rules` and is never read as "no".
- **Policy (spec §7.4), with `T_act` defaulting to `0.8`:**

  | Situation | Action |
  |---|---|
  | mentioned, and `addressedToAgent` is yes with confidence ≥ `T_act` | `run` |
  | mentioned, any other case | `record_doubt`: record only, react `thinking_face`, log, engagement unchanged |
  | engaged and not mentioned, with `isQuestionOrRequest` yes ∧ `agentCanHelp` yes (each ≥ `T_act`) ∧ `alreadyAnswered` is not yes ≥ `T_act` | `run` |
  | engaged and not mentioned, any other case | `record` |

- **Bypass:** DMs, slash commands, interactive actions, and any thread with a `/1on1` lock never call the gate.
- **Metrics:** `slaude_gate_decisions_total{action,backend,mode}`, plus `slaude_gate_shadow_disagree_total{would,actual}`.
- **Progress tracking:** each task's commit ticks its line under "Progress → Phase B tasks" in the epic spec.
- **Ships as stable** (spec §5), behind the `off` default.
- **Deviation from spec §7.7, planned up front:** "a sim scenario per row of §7.4" is covered by gateway-level tests with an injected backend (Task 5), the same substitution phase A made. The sim's stub agent has no way to choose a gate decision.

## Review Focus

1. **The two deliveries of one mention** (`app_mention` and the `message` copy) must make at most one backend call per event on a replica, and must reach the same decision. Task 4 test: `two deliveries of one event share one backend call`.
2. **Jev returns 200 with an answer missing or malformed** (no `confidence`, or a `choice` outside yes/no). It must fall back to `rules`, never become "no". Task 2 test: `malformed answer falls back`.
3. **A `record_doubt` mention in a brand-new thread with no session row.** It reacts 🤔, writes no session, and doesn't engage. A later real mention still works. Task 5 test: `doubt on a fresh thread creates no session`.
4. **Shadow mode must not add latency or change behaviour,** even when the backend hangs past its timeout. Task 4 test: `shadow never delays dispatch`.
5. **Thread history fetch fails** (`conversations.replies` rejects or returns `ok:false`). The gate still decides with `recent: []` and doesn't throw. Task 3 test: `history failure yields empty recent`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/gateway/gate/types.ts` (create) | `GateInput`, `Answer`, `GateDecision`, `GateAction`, `DecisionBackend`. |
| `src/gateway/gate/policy.ts` (create) | `decideAction(input, decision, tAct)`, the table above. |
| `src/gateway/gate/rules-backend.ts` (create) | `rulesBackend`, which reproduces today's behaviour. |
| `src/gateway/gate/jev-backend.ts` (create) | `makeJevBackend(opts)`: request, response mapping, error handling. |
| `src/gateway/gate/context.ts` (create) | `buildGateInput(...)`: thread excerpt, role mapping, KB score. |
| `src/gateway/gate/runner.ts` (create) | `makeGateRunner(opts)`: mode, timeout, fallback, memo, logging, metrics. |
| `src/config/env.ts` (modify) | `decision*()` getters. |
| `src/config/gateway-only-env.ts` (modify) | Add `TYPESAFE_API_KEY`. |
| `src/metrics.ts` (modify) | Two counters. |
| `src/gateway/core/gateway.ts` (modify) | `GatewayOptions.gateRunner?`; call sites. |
| `docs/site/_content/reference/configuration.md` (modify) | The env rows. |
| `tests/gateway/gate/*.test.ts` (create) | Unit tests per module. |
| `tests/gateway/core/decision-gate.test.ts` (create) | Wiring and equivalence. |

---

### Task 1: Types, policy table, rules backend

**Files:**
- Create: `src/gateway/gate/types.ts`, `src/gateway/gate/policy.ts`, `src/gateway/gate/rules-backend.ts`
- Test: `tests/gateway/gate/policy.test.ts`

**Interfaces:**
- Produces:
```ts
export type Trust = "trusted" | "allowed" | "restricted";
export interface GateInput {
  message: string;                                   // mentions resolved to <agent> / <user>
  recent: { role: "agent" | "user"; text: string }[];
  mentionsAgent: boolean;
  engaged: boolean;
  kbHitScore: number | null;
  channelTrust: Trust;
}
export interface Answer { value: boolean; confidence: number }
export interface GateDecision {
  addressedToAgent: Answer; isQuestionOrRequest: Answer; agentCanHelp: Answer; alreadyAnswered: Answer;
}
export type GateAction = "run" | "record" | "record_doubt";
export interface DecisionBackend { readonly name: "jev" | "rules"; decide(input: GateInput, signal: AbortSignal): Promise<GateDecision> }
export function decideAction(input: GateInput, d: GateDecision, tAct: number): GateAction;   // policy.ts
export const rulesBackend: DecisionBackend;                                                     // rules-backend.ts
```

- [ ] **Step 1: Write the failing tests.** Use `yes = {value:true,confidence:1}` and `no = {value:false,confidence:1}`.

```ts
it("mention addressed with confidence ≥ tAct runs", () =>
  expect(decideAction({ ...base, mentionsAgent: true }, { ...allNo, addressedToAgent: { value: true, confidence: 0.8 } }, 0.8)).toBe("run"));
it("mention addressed below tAct is doubt", () =>
  expect(decideAction({ ...base, mentionsAgent: true }, { ...allNo, addressedToAgent: { value: true, confidence: 0.79 } }, 0.8)).toBe("record_doubt"));
it("mention judged not-addressed is doubt", () =>
  expect(decideAction({ ...base, mentionsAgent: true }, allNo, 0.8)).toBe("record_doubt"));
it("engaged question the agent can help with, unanswered, runs", () =>
  expect(decideAction({ ...base, engaged: true }, { ...allNo, isQuestionOrRequest: yes, agentCanHelp: yes }, 0.8)).toBe("run"));
it("engaged but already answered records", () =>
  expect(decideAction({ ...base, engaged: true }, { ...allNo, isQuestionOrRequest: yes, agentCanHelp: yes, alreadyAnswered: yes }, 0.8)).toBe("record"));
it("engaged chit-chat records", () => expect(decideAction({ ...base, engaged: true }, allNo, 0.8)).toBe("record"));
it("rules backend + policy reproduce today: mention runs, engaged runs", async () => {
  const s = new AbortController().signal;
  expect(decideAction({ ...base, mentionsAgent: true }, await rulesBackend.decide({ ...base, mentionsAgent: true }, s), 0.8)).toBe("run");
  expect(decideAction({ ...base, engaged: true }, await rulesBackend.decide({ ...base, engaged: true }, s), 0.8)).toBe("run");
});
```

- [ ] **Step 2: Run them and confirm they fail.** `bun test tests/gateway/gate/policy.test.ts`. Expected: FAIL, because the modules are missing.
- [ ] **Step 3: Implement.** `rulesBackend.decide` returns:
  - `addressedToAgent` = yes when `mentionsAgent`;
  - `isQuestionOrRequest` and `agentCanHelp` = yes;
  - `alreadyAnswered` = no;
  - every confidence = `1`.

  `decideAction` follows the Global Constraints policy table exactly. A mention takes the mention rows even when the thread is engaged.
- [ ] **Step 4: Run the tests and typecheck.** `bun test tests/gateway/gate/policy.test.ts && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Tick B1 and commit.** Message: `feat(gate): decision types, policy table and rules backend`.

---

### Task 2: Jev backend

**Files:**
- Create: `src/gateway/gate/jev-backend.ts`
- Test: `tests/gateway/gate/jev-backend.test.ts`. It uses a local `Bun.serve` fake on loopback, with `allowLoopback: true` passed through `outboundOpts`.

**Interfaces:**
- Consumes: the Task 1 types; `safeFetch(url, init, opts)` and `OutboundPolicyOptions` from `src/net/outbound-policy.ts`.
- Produces:
```ts
export interface JevOpts { url: string; apiKey: string; model: string; outboundOpts?: OutboundPolicyOptions; now?: () => number }
export function makeJevBackend(o: JevOpts): DecisionBackend;  // name "jev"
export class GateBackendError extends Error { constructor(readonly kind: "auth" | "invalid_request" | "rate_limited" | "overloaded" | "transport" | "bad_output", msg: string) }
export const JEV_QUESTIONS: Record<keyof GateDecision, { instructions: string; criteria: { yes: string; no: string } }>;
```
- Question copy (exact):
  - `addressedToAgent`:
    - instructions: "The state holds a new chat message and the recent thread. `<agent>` is an AI teammate. Decide whether the new message is said TO `<agent>` (asking, telling or replying to it), as opposed to only mentioning or talking ABOUT `<agent>` to other people."
    - criteria yes: "spoken to <agent>"
    - criteria no: "about <agent>, or to someone else"
  - `isQuestionOrRequest`:
    - instructions: "Decide whether the new message asks a question or requests that something be done."
    - criteria yes: "a question or a request"
    - criteria no: "a statement, reaction, thanks or chit-chat"
  - `agentCanHelp`:
    - instructions: "Decide whether an AI teammate with access to the team's knowledge base could usefully answer or act on the new message. `kbHitScore` is the top knowledge-base match score from 0 to 1, or null when unknown."
    - criteria yes: "the teammate could add something useful"
    - criteria no: "nothing useful to add"
  - `alreadyAnswered`:
    - instructions: "Decide whether someone in the recent thread has already answered or handled the new message."
    - criteria yes: "already answered or handled"
    - criteria no: "still open"
- Request body: `{ model, state: <the GateInput object>, questions: { <id>: { type: "choice", instructions, criteria } } }`.

- [ ] **Step 1: Write the failing tests.** The fake records each request and replies with a canned body or status.

```ts
it("posts model, state, four choice questions with bearer auth", async () => { /* assert path, Authorization: Bearer k, body.model, Object.keys(body.questions) sorted, every .type==="choice", body.state.message */ });
it("maps choice/confidence to Answer", async () => { /* answers.addressedToAgent = {type:"choice",choice:"no",probabilities:{yes:0.1,no:0.9},confidence:0.9} → {value:false,confidence:0.9} */ });
it("401 throws auth without retry", async () => { /* status 401 → GateBackendError kind "auth"; fake saw exactly 1 request */ });
it("429 with retry-after inside the budget retries once", async () => { /* first 429 retry-after:0, then 200 → resolves; 2 requests */ });
it("529 with retry-after beyond the remaining time throws overloaded without retry", async () => { /* retry-after: 5 with an 800ms signal → kind "overloaded"; 1 request */ });
it("malformed answer falls back", async () => { /* 200 with alreadyAnswered missing confidence, or choice "maybe" → kind "bad_output" */ });
it("aborts when the signal fires", async () => { /* fake never responds; AbortController aborts at 50ms → rejects */ });
```

- [ ] **Step 2: Run them and confirm they fail.** `bun test tests/gateway/gate/jev-backend.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `decide` builds the request and calls `safeFetch` with the signal. It maps statuses as follows:
  - 401 → `auth`;
  - 422 → `invalid_request`;
  - 429 → `rate_limited`;
  - 529 → `overloaded`;
  - other non-2xx and transport failures → `transport`.

  A 429 or 529 gets one retry, only when `retry-after` (in seconds) is within the time left before the signal's deadline. Every answer must have `choice ∈ {yes,no}` and a numeric `confidence` in [0,1]; anything else throws `bad_output`. Never log the API key or the request body.
- [ ] **Step 4: Run the tests and typecheck.** `bun test tests/gateway/gate/jev-backend.test.ts && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Tick B2 and commit.** Message: `feat(gate): Jev backend over the outbound-fetch policy`.

---

### Task 3: Gate input builder

**Files:**
- Create: `src/gateway/gate/context.ts`
- Test: `tests/gateway/gate/context.test.ts`

**Interfaces:**
- Consumes: the Task 1 types; `rankScore(hit)` from `src/knowledge/gather.ts`.
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
it("recent excludes the new message, keeps the last N, maps roles", async () => { /* replies returns 12 msgs incl. self bot and the event ts; contextMessages 8 → 8 items, none with the event ts, self → "agent" */ });
it("top-level message has empty recent and no replies call", async () => { /* no thread_ts → recent [] ; replies not called */ });
it("history failure yields empty recent", async () => { /* replies rejects → recent [] , no throw */ });
it("kbHitScore is the clamped top rankScore, null without a brain or on error", async () => { /* hits [{score:0.4},{rerank_score:1.7}] → 1; kbSearch null → null; kbSearch rejects → null */ });
```

- [ ] **Step 2: Run them and confirm they fail.** `bun test tests/gateway/gate/context.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Fetch `contextMessages + 1` replies and drop the event's own ts. A message is `agent` when `user === botUserId` or its `bot_id` is in `botIds`.
  - `kbHitScore` = `Math.min(1, Math.max(0, rankScore(top)))`.
  - Normalisation across engines is left to the builder (spec §12); keep it to this clamp.
- [ ] **Step 4: Run the tests and typecheck.** `bun test tests/gateway/gate/context.test.ts && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Tick B3 and commit.** Message: `feat(gate): build gate input from the thread and a KB score`.

---

### Task 4: Gate runner, config, metrics, secret handling

**Files:**
- Create: `src/gateway/gate/runner.ts`
- Modify:
  - `src/config/env.ts`: add getters next to `autoEvolve`;
  - `src/config/gateway-only-env.ts`: add `"TYPESAFE_API_KEY"`;
  - `src/metrics.ts`: add `gateDecisionsTotal` and `gateShadowDisagreeTotal` to `m`;
  - `docs/site/_content/reference/configuration.md`: add a row per variable and a commented block in the example env.
- Test: `tests/gateway/gate/runner.test.ts`, plus extend `tests/config` with a case asserting that `isGatewayOnlyEnv("TYPESAFE_API_KEY")` holds.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
```ts
export type GateMode = "off" | "shadow" | "on";
export interface GateResult { action: GateAction; mode: GateMode; backend: "jev" | "rules"; fallback: boolean; decision: GateDecision; latencyMs: number }
export interface GateRunner {
  readonly mode: GateMode;
  /** off → undefined (caller keeps today's path). shadow → resolves "run" immediately; the backend runs detached and is logged. on → the decided action. */
  gate(key: string, input: () => Promise<GateInput>, actual: GateAction): Promise<GateAction | undefined>;
}
export function makeGateRunner(o: { mode: GateMode; backend: DecisionBackend; tAct: number; timeoutMs: number; log?: (line: string) => void; memoTtlMs?: number }): GateRunner;
export function gateRunnerFromEnv(): GateRunner; // reads env.decision*(); jev requires TYPESAFE_API_KEY, else logs once and uses rules
// env.ts
decisionGate(): GateMode; decisionBackend(): "jev" | "rules"; decisionTAct(): number; decisionTimeoutMs(): number;
decisionContextMessages(): number; decisionModel(): string; decisionJevUrl(): string;
```
- `actual` is what today's path would do: `"run"` for a mention or an engaged message. It's used only to count shadow disagreements.
- Memo: the key is `${channel}:${eventTs}`, with a default TTL of `60_000` ms. It stores the in-flight promise, so the two deliveries of one event share one backend call.
- Log line format: `[gate] mode=<m> backend=<b> action=<a> fallback=<bool> ms=<n> key=<k> a=<v>:<c> q=<v>:<c> h=<v>:<c> d=<v>:<c>`. Never log message text.

- [ ] **Step 1: Write the failing tests.** Use a fake backend that counts calls and can resolve, reject, or hang.

```ts
it("off returns undefined and never calls the backend", ...);
it("on returns the policy action", ...);
it("backend error falls back to rules and flags fallback", async () => { /* reject → action "run" for a mention; log contains fallback=true */ });
it("timeout falls back to rules", async () => { /* hang, timeoutMs 30 → resolves within ~100ms with fallback */ });
it("two deliveries of one event share one backend call", async () => { /* same key twice concurrently → backend called once, same action */ });
it("shadow never delays dispatch", async () => { /* hanging backend; gate() resolves "run" in < 20ms; later disagreement counted when backend answers record */ });
it("bad env values fall back to defaults", () => { /* SLAUDE_DECISION_T_ACT="2" → 0.8; GATE="maybe" → "off"; TIMEOUT_MS="-1" → 800 */ });
it("jev without TYPESAFE_API_KEY uses rules", () => { /* gateRunnerFromEnv() with BACKEND=jev, no key → backend name "rules" */ });
```

- [ ] **Step 2: Run them and confirm they fail.** `bun test tests/gateway/gate/runner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Timeouts use `AbortSignal.timeout(timeoutMs)`.
  - On a fallback, use `rulesBackend`'s decision.
  - Count `gateDecisionsTotal{action,backend,mode}` for every decision, shadow included.
  - In shadow mode, increment `gateShadowDisagreeTotal{would,actual}` when the action differs from `actual`.
  - Env getters reject out-of-range values and fall back to the defaults in the Global Constraints table.
- [ ] **Step 4: Run the tests and typecheck.** `bun test tests/gateway/gate/ tests/config/ && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Tick B4 and commit.** Message: `feat(gate): runner with modes, timeout fallback, memo and metrics; config and secret wiring`.

---

### Task 5: Wire the gate into the gateway

**Files:**
- Modify: `src/gateway/core/gateway.ts`:
  - `GatewayOptions` (line ~233): add `gateRunner?: GateRunner`; the default is `gateRunnerFromEnv()`;
  - the `app_mention` handler (~3065);
  - the `mentionsBot` branch (~3133);
  - the `mentionedPersona` branch (~3148);
  - the engaged plain-message branches (~3216, ~3224, ~3239).
- Test: `tests/gateway/core/decision-gate.test.ts`. Reuse the `makeGw` / `msg` / `mention` / `nextTs` helpers pattern from `tests/gateway/core/durable-gates.test.ts:63-91`, and inject `gateRunner` through `createGateway(agent, t, { gateRunner })`.

**Interfaces:**
- Consumes: `GateRunner.gate`, `buildGateInput` (deps built in the gateway: `replies` from `args.client.conversations.replies`; `kbSearch` from `gather()` over `resolveBrainScope({ ...(await brainGateFor(ctx)), kbSources: personaKbSourceIds(personaId) })` when `brainEnabled()`, else `null`; `selfIds` from `getBotId` and `getSelfBots`), `channelTrustFor`, `OneOnOne.find`, `env.decisionContextMessages()`.

Gate placement:
- **Mention paths** (`app_mention`, `mentionsBot`, `mentionedPersona`):
  - before `engageOnMention`, unless the thread has a `/1on1` lock, compute `act = await gateRunner.gate(key, () => buildGateInput(...), "run")`;
  - `undefined` or `"run"` → today's code, unchanged;
  - `"record_doubt"` → `reactions.add({ channel, timestamp: e.ts, name: "thinking_face" })` (failure caught and logged). Then, if a session row exists for the thread, `handleMessage(args, { suppress: true, personaId })`; otherwise log and stop. Never call `engageOnMention`.
- **Engaged plain branches:**
  - before `handleMessage(args, …)`, unless the thread is locked, compute the action with `actual "run"`;
  - `undefined` or `"run"` → unchanged;
  - `"record"` → `handleMessage(args, { suppress: true, personaId })`.
- **Bypassed:** DMs (`channel_type === "im"`), the colleague-mention disengage path, mention-only threads and slash commands are not touched.

- [ ] **Step 1: Write the failing tests.**

```ts
it("off: every existing engagement scenario is unchanged", async () => { /* run the durable-gates engagement sequence with gateRunner mode off → same sends as without the option */ });
it("on + rules backend equals off", async () => { /* same sequence with makeGateRunner({mode:"on", backend: rulesBackend}) → identical sends and engaged state */ });
it("doubt on a mention reacts thinking_face and does not engage", async () => { /* fake backend: addressedToAgent no → reactions.add thinking_face; a plain follow-up is suppressed ("do NOT reply") */ });
it("doubt on a fresh thread creates no session", async () => { /* no prior row → no Sessions row for the thread; a later real mention (backend yes) runs normally */ });
it("engaged chit-chat is recorded, a helpful question runs", async () => { /* engaged thread; backend allNo → suppressed envelope; backend question+canHelp → normal dispatch */ });
it("a /1on1-locked thread never calls the gate", async () => { /* lock thread; backend call counter stays 0 */ });
it("DMs never call the gate", ...);
it("shadow behaves exactly like off", async () => { /* mode shadow with an always-doubt backend → same sends as off */ });
```

- [ ] **Step 2: Run them and confirm they fail.** `bun test tests/gateway/core/decision-gate.test.ts`. Expected: FAIL. The option doesn't exist, and doubt/record aren't applied.
- [ ] **Step 3: Implement the placement above.** Pass the persona id (`mentionedPersona.name` or the engaged row's `persona_id`) through to `handleMessage` exactly as the existing branch does.
- [ ] **Step 4: Run the tests and the engagement suites.** `bun test tests/gateway/core/decision-gate.test.ts tests/gateway/core/durable-gates.test.ts tests/gateway/core/pass-engagement.test.ts tests/gateway/core/multi-app-self.test.ts tests/gateway/core/tombstoned-persona.test.ts && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Tick B5 and commit.** Message: `feat(gateway): consult the decision gate before mention and engaged-thread turns`.

---

### Task 6: Field note, full suite, phase close-out

**Files:**
- Create: `docs/site/_content/field-notes/2026-10-25-decision-gate.md`
- Modify: `CLAUDE.md` (Findings Log, newest first); the epic spec Progress section.

- [ ] **Step 1: Write the field note.**
  - **Mechanism:** a System One gate before the turn, with a policy table, a rules fallback equal to today's behaviour, a per-event memo for the two deliveries, a doubt reaction, and shadow mode as the evaluation path.
  - **Spec adjustments:** two-option Choice questions instead of Noul, because the confidence field is needed; `TYPESAFE_API_KEY` is gateway-only.
  - **Data egress:** thread text goes to a third party only when `SLAUDE_DECISION_BACKEND=jev` and a key is set.
  - **Not verified:** the live Jev API (the contract comes from a third-party reference, and the vendor docs host was unreachable from the build environment); shadow-mode data from real threads; latency under load.
- [ ] **Step 2: Index it at the top of the Findings Log in `CLAUDE.md`.**
- [ ] **Step 3: Run the whole suite and typecheck.** `bun test && bun run typecheck`. Expected: no failures beyond the environment-only set recorded for phase A (missing gbrain module, kubectl-dependent deploy tests, proxy and hook-template tests, voice "child env is minimal"). List any other failure and check it on the base commit.
- [ ] **Step 4: Mark Phase B done and commit.** Tick B6 and set Phase B to "done (unreleased)". Message: `docs: phase B field note; mark phase B done in the epic`.
