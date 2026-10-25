# Teammate agent: natural voice, structured memory, background learning, proactiveness

**Date:** 2026-10-25
**Status:** Epic design. Nothing built. Phases are delivered in sequence (§5); each phase gets its own implementation plan written from this document.
**Ships as:** a series of releases. Phases A, C, D and E touch the agent loop or the DB schema, so each goes out as `vX.Y.Z-rc.N` first (CLAUDE.md "Release candidates").
**Inputs:** a brainstorm with the owner; an interview with a deployed persona about its own memory gaps (§4.5).

## Progress

Updated in the same commit as each piece of work lands. A phase is **done** when its plan's last task has merged.

| Phase | Plan | Status | Release |
|---|---|---|---|
| A. Natural voice | `docs/superpowers/plans/2026-10-25-phase-a-natural-voice.md` | done, merged (#152; unreleased — ships as RC) | — |
| B. Decision gate | — | planning | — |
| R. Runtime prompt as built-in skills | — | not started | — |
| C. Memory structure | — | not started | — |
| D. Background learning and budget | — | not started | — |
| E. Proactiveness | — | not started | — |

**Phase A tasks**
- [x] A1 Writing-style section; KB-first governs action, not wording (§6.1)
- [x] A2 `pass` surface tool; reply-or-pass rule; stop guard accepts pass (§6.2)
- [x] A3 Auto-evolve: no announcement, `<runtime-check>` wrapper, higher bar (§6.3)
- [x] A4 A mention that ends in pass does not re-engage (§6.4)
- [x] A5 Voice lint and live natural-voice scenario (§6.5)
- [x] A6 Field note; full suite green; phase closed

## 1. Goal

Make a slaude persona behave like a teammate rather than a tool:

1. **Natural voice.** It talks like a person in a team chat. It never narrates its own machinery ("from my KB", "I saved skill x"), and it can choose to stay quiet.
2. **Structured memory.** It remembers people, promises, investigations and corrections as distinct kinds of memory, not only as raw thread transcripts.
3. **Background learning.** Between conversations it distils what happened into that memory, maintains its own operating lessons, and retires skills that don't help, all under a daily budget.
4. **Proactiveness.** It keeps its promises unprompted, and, where the operator switches it on, speaks up when something is new and worth an interruption.

Memory is the foundation: per-person style, open loops and "who knows what" are what make the other three possible. The deployed persona put it this way: without them, "I'd only be guessing what's worth saying."

## 2. Decisions taken in the brainstorm

| Question | Decision |
|---|---|
| Proactive audiences | All three: the manager's DM, individual teammates, channels. The audience widens in steps (§10.4). |
| Who owns a person's profile | **The person.** One `profile-<id>` per person, shared by every agent, readable by that person and the agents only (not team-wide like `shared`). |
| Does a profile set in a /1on1 apply in channels? | **Yes, everywhere.** It holds only how the person wants to be treated, never what a /1on1 discussed. |
| Where the agent's lessons live | Its own slice, `agent-<id>/self/lessons`, freely edited. The SOUL in git stays operator-owned; the agent may only *propose* promoting a lesson. |
| Background budget | **$1 per agent per day** default, configurable globally and per persona. Cost = tokens × a configurable price table. |
| Does the post-turn skill check count against the budget? | **Yes.** |
| Who enables proactiveness | **Only the SOUL** (`## Proactive`, global plus per-channel). Never runtime: no `/soul` override, no command. |
| Are promises kept when proactiveness is off? | **Yes.** Promises are not "proactive"; someone is waiting on them. |
| May the agent chime in on an engaged thread without being addressed? | Yes, when it has something useful, **decided by a System One decision model** (Jev from TypeSafe AI), not by the LLM. |
| Where the decision gate is configured | **Process config** (gateway/node env), **not the SOUL**, and separate from proactiveness. `off` keeps today's engage/disengage behaviour exactly. |
| Is a decision-model backend available? | **Yes.** The owner has Jev access, so phase B stays second and its shadow mode can collect real decisions. |
| Gate unsure about a direct @mention | **Stay quiet**, with a doubt reaction (🤔) and a logged decision. |
| Delivery shape | One epic document, delivered phase by phase in sequence until complete. |
| Decision-gate question type and key name | Every gate question is a two-option **Choice** (`yes`/`no`), so each answer carries a confidence; the yes/no Noul type may not. The key variable is `TYPESAFE_API_KEY` (the SDK's own convention). |
| Growing system prompt | Move the runtime baseline into **read-only files shipped with the release**: a small always-on core, runtime-injected state modules, and **built-in skills** in a `slaude:` namespace (phase R, §7a). |
| How the model finds a built-in skill | **The core names it**, with a trigger ("before X, load `slaude:<name>`"); the model never guesses from descriptions. |
| Enforcement for tool-bound built-in skills | **A PreToolUse hook blocks the governed tool until its skill has been loaded once in the session.** |
| Can built-ins change at runtime? | **No.** `write_skill`/`delete_skill` refuse the `slaude:` namespace, no agent skill may shadow one, phase D's skill review and personas sync can't touch them. They change only with a release. |

## 3. Goals, non-goals, anti-goals

**Goals:** the four in §1, each measurable: fewer machinery mentions in replies; fewer replies nobody asked for; open loops closed without reminders; corrections that stick after being given once.

**Non-goals**
- Embedding providers, vector-store changes, or a new brain engine. Everything is brain pages and sources on the existing gbrain.
- Letting the agent edit its own SOUL (personas-as-code owns it; the sync wipes runtime overrides).
- Any non-Slack surface (CLAUDE.md scope).
- Consumer-assistant features: idea cards, a news feed, a goals UI, purchases, device control.

**Anti-goals** (failures even if everything technically works)
- **A bot people mute.** Any design choice that trades restraint for "engagement" is wrong.
- **A hidden file on coworkers.** No notes about a person they cannot see, no judgements of performance or private life.
- **A /1on1 leak.** Nothing said in a /1on1 may reach another person's turn, a channel, the agent's own slice or `shared` without that person's approval.
- **Silent spending.** Background work that runs over budget or hides what it spent.

## 4. Current state

### 4.1 Voice
- `RUNTIME_BASELINE` (`src/soul/loader.ts`) covers output mechanics, trust, KB use and skills. It has no writing-style guidance; the SOUL's "Voice" is one line.
- The KB-first rule ("mandatory, not advisory… Skipping this step is a breach") pushes the agent to *say* it consulted the KB ("from my KB…").
- The baseline rule "Every user message must result in at least one user-visible Slack tool call before the turn ends" forces a reply on every turn.

### 4.2 Auto-evolve
- `#shouldAutoEvolve` (`src/agent/manager.ts`) fires after any turn with ≥2 "substantive" tool calls and injects `AUTO_EVOLVE_PROMPT` **as a user message**.
- That prompt's step 4 tells the agent to reply `saved /<slug>`, which produces "I saved skill x" after trivial steps.
- Its "if NO, end silently" clashes with the baseline's must-reply rule. Observed live: the agent posted "Nothing to save as a skill from that turn" and, asked why, identified exactly that clash.

### 4.3 Engagement
In `src/gateway/core/gateway.ts` (around line 3074):
- Any mention of the bot sets `engaged = true` and starts a turn. A mention *about* the agent ("the agent did X yesterday") re-engages it just like one addressed to it.
- In an engaged thread every message starts a turn, and the must-reply rule means the agent always answers.
- A mention of another user disengages; suppressed turns already record messages into the transcript without running the model (`UserPromptSubmit` `continue:false`).

### 4.4 Memory
- Slices (`src/knowledge/scope.ts`): `agent-<id>` (the agent only), `user-<id>` (that person plus the agent), `shared` (team, approval-carded writes), `public`/`kb-*` (read-only).
- Read unions by turn type:

| Turn | Reads | Writes |
|---|---|---|
| Trusted channel / manager | agent + shared + public + KBs | agent |
| Own /1on1 or DM | user + agent + shared + public + KBs | user |
| Someone else's /1on1 | public only (manager included, for transcripts) | nothing |
| Background / cron | agent + shared + public + KBs | agent |
| `runAsUser` (cron created inside a /1on1) | that user's slice | that user's slice |

- Episodic memory (`src/memory/brain-provider.ts`) is one `conversations/<session>` page per thread. Turns are appended as **timeline entries**, and only the last N are recalled into the prompt for *that thread*.
- The KB tools expose no timeline read. The persona reports these pages as "thin shells without readable turns" from its side, so anything older than the recall window is effectively lost. **To verify in phase C:** whether timeline entries are chunked and searchable at all.
- No typed pages: no people, commitments, corrections or lessons. The only per-person knowledge is whatever was explicitly `kb_memoize`d.

### 4.5 What the persona said it lacks (interview, paraphrased)
- **Corrections that stick:** "too long" or "don't ping me for this" leave no trace.
- **Open loops:** "I'll check after the deploy" is dropped unless a cron was set.
- **Investigation state:** a recurring symptom starts cold.
- **Who knows what:** who owns or recently debugged something.
- **Outcome feedback:** whether a summary was used or a suggestion ignored.

### 4.6 Background work today
- `runNightlyMaintenance` (`src/knowledge/brain-cycle.ts`) is mechanical only: KB sync, link extraction, embedding sweep, orphan and purge checks. Nothing reflective.
- Cron jobs exist only when a user asks (`add_cron_job`).
- Token usage is counted per turn into Prometheus (`slaude_tokens_total`, by kind, channel and model). It is never priced in dollars, and the SDK's own cost figure assumes Anthropic list prices, which is wrong for other providers.

## 5. Epic structure and order

Six phases. Each is independently shippable and leaves the system working.

| Phase | Name | Depends on | Ships as |
|---|---|---|---|
| A | Natural voice | none | RC (agent-loop change) |
| B | Decision gate | none | stable, behind `SLAUDE_DECISION_GATE=off` default |
| R | Runtime prompt as built-in skills | A | RC (agent loop, system prompt) |
| C | Memory structure | R (its memory discipline is R's first built-in skill) | RC (brain sources and schema) |
| D | Background learning and budget | C | RC (agent loop, DB table) |
| E | Proactiveness | C, D | RC |

**Order: A → B → R → C → D → E.** A → B → C → D → E was my call (the owner asked for one sequence, not this specific order). R was added on 2026-10-25 and sits before C because C, D and E each add prompt text; it is cheapest to restructure before they do. B barely touches the prompt, so it goes first.

### Approaches considered for ordering

1. **Quick wins, then foundation (chosen): A and B first, then C → D → E.** A fixes every complaint raised in the brainstorm within days. B starts early because its shadow mode needs weeks of real threads before it can be trusted. Cost: the memory foundation starts third.
2. **Foundation first: C → D → E, then A and B.** Cleanest layering, but weeks before anyone notices a difference, and the gate's shadow data starts late.
3. **One promise end to end:** a thin slice of C, D and E built around promises only, then widened. It tests memory, background pass and budget together early, but bends the memory schema around one feature.

If delivered strictly one at a time, B can still be started in shadow right after A, since it only logs.

## 6. Phase A: natural voice

### 6.1 Writing-style section in `RUNTIME_BASELINE`
Add `## How you write` (the SOUL's Voice still sets persona-specific tone on top):
- Write like a teammate in a chat thread. Simple question, short answer; depth only when the question needs it. Depth is substance, not length.
- **Never narrate machinery.** No "from my KB/brain/memory", no tool or skill names, no page slugs, no "the cron is set". Say what it means for the reader ("we decided X on the 12th", "I'll check each morning"). Keep it truthful.
- **Sources only when they help the reader:** link the doc, name the person or thread. "My KB" is never a source.
- **Errors in plain words,** never raw error codes or stack traces unless the channel is `trusted` and the reader asked.
- **Acknowledge long tasks with a reaction,** not a "working on it" message; save the next message for the result.
- **When someone is sharing rather than asking,** engage with what they said; don't turn it into a service offer.
- **Match the reader's register;** use their profile (phase C) when present.
- Reword the KB-first rule so it governs *what the agent does* (consult before answering), not *what it says*. Add explicitly: "Do not mention that you checked."

### 6.2 Explicit "pass"
- Replace "every user message must result in at least one user-visible Slack tool call" with: **every turn ends in a reply or an explicit pass.**
- New surface tool `mcp__slaude_surface__pass({ reason, react? })`. It records a structured log line and optionally adds a reaction (e.g. `eyes`). It posts nothing.
- The adapter treats a pass like the current silent auto-evolve ending: no "no reply emitted" warning.
- A turn that ends with neither a reply nor a pass keeps today's warning (a real bug signal).

### 6.3 Auto-evolve fixes
- **Remove step 4** (`reply` with `saved /<slug>`) from `AUTO_EVOLVE_PROMPT`. Skill changes are reported in the weekly digest (phase D), or immediately only when the user asked for the skill.
- **Deliver the check as a system-tagged turn, not as a user message:** wrap it as `<runtime-check kind="auto-evolve">`, and add a baseline carve-out that runtime checks never require a reply. Both changes, because the persona said it could not be sure to resolve the clash correctly every time.
- **Raise the trigger:** ≥4 substantive tool calls *and* at least one mutating tool (Write/Edit/Bash/external MCP write), configurable via `SLAUDE_AUTO_EVOLVE_MIN_TOOLS`.
- Budget accounting arrives in phase D; until then the check runs as today.

### 6.4 Engagement: mentions *about* the agent
With the gate off (phase B), keep today's rule that a mention engages, with one change: if the turn ends in a `pass`, **revert `engaged` to its prior value**. A mention the agent decided wasn't for it doesn't re-engage the thread.

### 6.5 Verification
- Sim gateway scenarios:
  - a trivial two-tool turn produces no skill message;
  - a no-op auto-evolve produces no message;
  - a mention-about plus pass leaves the thread disengaged;
  - a pass with a reaction posts only a reaction.
- A golden-reply lint over sim transcripts: fail on `/\b(my|the) (KB|brain|memory)\b/i`, `saved /`, `skill` in non-skill turns.

## 7. Phase B: decision gate (System One)

### 7.1 Purpose
Decide, cheaply and **without an LLM turn**, whether an inbound message warrants a Claude turn. This replaces "every engaged message is a turn" and "every mention engages."

### 7.2 Where it runs
In the gateway's Slack ingress (`gateway.ts`, the engage/disengage block), before `handleMessage`. In mono it is the same process.
- It runs on every message that today would start a turn: bot mentions and engaged-thread messages.
- DMs, slash commands, approval clicks and `/1on1` lock changes **bypass it**.

### 7.3 Interface (provider-neutral)
```ts
interface DecisionBackend {
  decide(input: GateInput): Promise<GateDecision>;
}
type GateInput = {
  message: string;                      // the new message, mentions resolved to roles: <agent>, <user>
  recent: { role: "agent" | "user"; text: string }[]; // last N in thread (N configurable, default 8)
  mentionsAgent: boolean;
  engaged: boolean;
  kbHitScore: number | null;            // top score of a cheap KB search on the message, 0–1
  channelTrust: "trusted" | "allowed" | "restricted";
};
type GateDecision = {
  addressedToAgent: { value: boolean; confidence: number };
  isQuestionOrRequest: { value: boolean; confidence: number };
  agentCanHelp: { value: boolean; confidence: number };
  alreadyAnswered: { value: boolean; confidence: number };
};
```
- `kbHitScore` exists because the gate cannot see what the agent knows. It reuses `kb_search` scoring, scoped exactly as the turn would be, with no LLM call.
- The first backend is **Jev** (TypeSafe AI) via its API (`POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`), schema declared once at boot. Each `GateDecision` field is asked as a two-option **Choice** question (`yes`/`no`); `value` is the winning option and `confidence` is the answer's own `confidence` field. Each question is evaluated independently, so its `instructions` must carry its full meaning. A 401/422 is not retried; 429/529 back off within the timeout; any error or invalid output falls back to `rules`, and is never read as "no".
- A `rules` backend reproduces today's behaviour and is the fallback whenever the configured backend errors or times out (default 800 ms).

### 7.4 Policy (decision → action)
| Situation | Action |
|---|---|
| `mentionsAgent` and `addressedToAgent` ≥ `T_act` | run turn |
| `mentionsAgent` but `addressedToAgent` < `T_act` (unsure or about-not-to) | **record only + 🤔 reaction**, log; engagement unchanged |
| engaged, not mentioned, `isQuestionOrRequest` ∧ `agentCanHelp` ≥ `T_act` ∧ ¬`alreadyAnswered` | run turn (chime in) |
| engaged, not mentioned, otherwise | record only (suppressed turn, as today) |

- Defaults: `T_act = 0.8`. Thresholds are configurable.
- "Record only" uses the existing suppressed-turn path, so transcripts stay complete.

### 7.5 Configuration (process env, not SOUL)
| Variable | Values | Default |
|---|---|---|
| `SLAUDE_DECISION_GATE` | `off` \| `shadow` \| `on` | `off` |
| `SLAUDE_DECISION_BACKEND` | `jev` \| `rules` | `rules` |
| `SLAUDE_DECISION_T_ACT` | 0–1 | `0.8` |
| `SLAUDE_DECISION_TIMEOUT_MS` | int | `800` |
| `SLAUDE_DECISION_CONTEXT_MESSAGES` | int | `8` |
| `TYPESAFE_API_KEY` | secret | none |
| `SLAUDE_DECISION_MODEL` | Jev model id | `jev-latest`; pin a version (e.g. `jev-1.13.0`) once validated |

- `off` means today's behaviour, byte for byte. `shadow` runs the backend, logs what it *would* do next to what happened, and acts as `off`.
- The API key is a gateway-side secret: same handling as provider keys, never in a node bundle, never in the agent child's env.
- Outbound calls go through the existing outbound-fetch policy. Thread text leaving the deployment is a data-egress decision, so the operator opts in by setting the backend.

### 7.6 Observability
- Every decision emits a structured log line: thread, message ts, per-question value and confidence, action, backend, latency, fallback flag.
- Counter `slaude_gate_decisions_total{action,backend,mode}`.
- In shadow mode, a disagreement counter versus actual behaviour gives the evaluation set for turning it on.

### 7.7 Verification
- Unit tests of the policy table against fixed decisions.
- A sim scenario per row of §7.4.
- A backend timeout falls back to `rules`.
- `off` matches the current engagement sim suite unchanged.

## 7a. Phase R: runtime prompt as built-in skills

### 7a.1 Problem
`RUNTIME_BASELINE` is one template string in `src/soul/loader.ts`, assembled with ad-hoc placeholders (`{{KB_FALLBACK}}`, the brain flag, the /1on1 mode block). Phases C–E each add prompt text. A long prompt where every rule is always present makes each rule weaker, and string-building in code is hard to review or test per section.

### 7a.2 Three tiers, all read-only files shipped with the release
| Tier | Loaded | Contents |
|---|---|---|
| **1. Core** | Every turn | Output discipline, reply-or-pass, approval discipline, channel trust, harness overrides (memory to KB only, cron via slaude only), the short voice rules, and the **skill index** (§7a.3). A test enforces a size budget. |
| **2. State modules** | Injected by the runtime from session state | KB/brain basics when the brain is mounted; the /1on1 block when the thread is locked; /remote rules when an environment is bound; voice-call rules during a call; proactive rules when the SOUL enables them (phase E). Deterministic: never chosen by the model. |
| **3. Built-in skills** | Loaded by the model, **named by the core** | Procedures and long reference: `slaude:memory` (phase C's memory discipline), `slaude:skill-authoring`, `slaude:cron`, `slaude:heartbeat` (phase E), `slaude:provenance` ("how do you know that?"), lesson upkeep (phase D). |

- Rules that must hold on every turn are never put in a lazily loaded skill.
- The tier-1 and tier-2 text moves out of the TypeScript string into markdown files beside the code (e.g. `src/soul/runtime/core.md`, `src/soul/runtime/modules/<name>.md`), assembled by a small loader. The rendered prompt for a given state is the same as today's text plus whatever earlier phases changed. Phase R adds no new rules of its own.

### 7a.3 The skill index (in the core)
The core lists each built-in skill with an explicit trigger, so the model never guesses from descriptions:

```
- Before any kb_memoize write, or when asked what you remember → load `slaude:memory`
- Before write_skill / delete_skill → load `slaude:skill-authoring`
- Before add_cron_job / remove_cron_job → load `slaude:cron`
- When a heartbeat or promise check runs → load `slaude:heartbeat`
- When asked how you know something → load `slaude:provenance`
```
Entries appear only for skills that exist in the running release; a later phase adds its own entry when it adds its skill.

### 7a.4 Enforcement hook for tool-bound skills
- Each built-in skill may declare the tools it governs, in its frontmatter (e.g. `governs: [mcp__slaude_brain__kb_memoize]`).
- A **PreToolUse hook** blocks a governed tool until that skill has been loaded **once in the session**. The block reason names the skill: "Load `slaude:memory` first, then retry."
- "Loaded" is recorded when the session calls the `Skill` tool with that skill's name. It is kept per session id and cleared when the session reboots (a reboot is a fresh context, so the skill must be loaded again).
- Situation skills (provenance, "what do you know about me") have no governed tool. They rely on the index pointer only.
- The hook sits alongside the existing PreToolUse guards (the /remote built-in deny). It runs in mono and on nodes; on a node the loaded-set lives in the node process for that session.
- Runtime-check turns (`<runtime-check …>`) are not exempt: an auto-evolve turn that calls `write_skill` must still have `slaude:skill-authoring` loaded.

### 7a.5 Built-in skills are immutable at runtime
- **Location:** a directory inside the release (e.g. `<dist>/builtin/`), mounted as a read-only local plugin named `slaude`. The CLI already mounts `~/.slaude/` as a local plugin for agent skills (`src/agent/manager.ts`), and plugin skills are namespaced by plugin name, which yields `slaude:<name>`.
- **Write protection:** `write_skill` and `delete_skill` refuse the `slaude` namespace and any slug equal to a built-in's name, so no agent or persona skill can shadow a built-in.
- **Out of reach:** phase D's weekly skill review never lists or retires built-ins; a personas-as-code sync cannot add, change or remove them; `/soul` overrides do not apply.
- **Changed only by a release.** Each built-in carries the release version in its frontmatter, so a transcript shows which text the agent had.

### 7a.6 Verification
- A golden test per state: the assembled prompt (core plus modules) for a fixed set of states (channel trusted, /1on1 locked, brain off, /remote bound, voice call) matches a snapshot, and equals the pre-R prompt text for the same state.
- A size-budget test on the core.
- Hook tests:
  - a governed tool before its skill loads → blocked with the skill name;
  - after the `Skill` call → allowed;
  - after a session reboot → blocked again;
  - a non-governed tool → never blocked.
- Immutability tests:
  - `write_skill` / `delete_skill` on a `slaude:` name or a built-in's bare name → refused;
  - phase D's review excludes built-ins (added when D lands);
  - a personas sync leaves the built-in directory untouched.
- The skill index lists exactly the built-ins present in the release.

## 8. Phase C: memory structure

### 8.1 Sources
| Source | New? | Owner | Readers | Writers |
|---|---|---|---|---|
| `profile-<userId>` | **new** | the person | that person (via any agent) + all agents, on turns where that person is the speaker or the target of a proactive message | any agent, only on turns where the speaker *is* that person (auto-pass, no card); never on others' behalf |
| `user-<userId>` | existing | the person | unchanged | unchanged; also holds what is inferred inside their /1on1 |
| `agent-<agentId>` | existing | the agent | that agent | that agent |
| `shared` | existing | team | everyone | carded |

- **Profile visibility is deliberately narrower than `shared`:** humans other than the owner cannot read someone's profile.
- **Profile is added to every read union**, including channel turns and someone else's locked thread, as long as the speaker or target is the profile's owner. It never includes the rest of `user-<id>`: that slice holds /1on1 content and stays in its current union.

### 8.2 Page types
Pages carry frontmatter `type:` plus the common fields `as_of` (date), `source` (thread permalink or "told by <user>"), `confidence: told | inferred`, and `supersedes` (slug, optional).

| Type | Lives in | Content |
|---|---|---|
| `profile` | `profile-<id>/profile` (one page) | name to use, register (terse/detailed, tables/prose), ping preferences (topics yes/no, quiet hours, cooldown), mutes. Entries may carry `agent: <id>` to apply to one agent only. Only things the person said. |
| `person-note` | `agent-<id>/people/<userId>`, or `user-<id>/…` if learned in their /1on1 | agent's working observations about how to work with someone. Always `confidence: inferred`. Working style and ownership only. |
| `commitment` | the slice of the turn that made it | promiser, beneficiary, thread, due (time or event), check to run, what to say when nothing changed (`close-in-one-line` \| `silent`), status `open` \| `done` \| `dropped`. |
| `investigation` | the turn's slice | symptom, hypotheses with status, evidence links, last touched. |
| `correction` | `profile-<id>` if about how to treat that person, else `agent-<id>/self/lessons` candidates | what was corrected, by whom, when. |
| `outcome` | the turn's slice | an action the agent took and the signal afterwards (reaction, reply, "this was wrong"). |
| `lessons` | `agent-<id>/self/lessons` (one page) | operating lessons (phase D rules). |
| `heartbeat` | `agent-<id>/self/heartbeat` (one page) | the agent's own recurring checks (phase E). |
| `team-fact` | `shared/people/<userId>`, `shared/services/<name>` | ownership, "who debugged what". Carded, standing grant per thread as today. |

### 8.3 Rules
- **Newer replaces older:** a write on the same subject sets `supersedes`, and the old entry is marked superseded rather than left to contradict. This audit trail is what lets the agent answer "why do you think that?"
- **Told and inferred never share an entry.**
- **Never recorded:** credentials, government ids, payment data, health, performance judgements, private life.
- **/1on1 containment:** anything written during a /1on1 stays in that user's slice or their profile. Promotion to `agent-<id>` or `shared` requires that user's explicit approval (a card in their /1on1).
- **"What do you know about me?"** returns that person's profile plus any `person-note` about them from every source the current turn can read, each labelled told or inferred, with dates. A person can correct or delete entries in their own profile from any thread. Inferred notes are corrected on request by the agent that holds them.

### 8.3a When memory is captured (my call)
- **Live capture is primary.** The agent writes a `commitment` the moment it makes a promise, a `correction` or `profile` entry the moment someone corrects it, and an `investigation` update as it works. The baseline instructs this, and `kb_memoize` with `type` makes it one call.
- **The nightly review (phase D) is a backstop** for what live capture missed. It may write a `profile` entry only when it can quote that person's own words from a transcript it is reading as them (`runAsUser`). That is the single exception to invariant 2 (§11.2): the write is still sourced to the person's own turn, just recorded later.

### 8.3b Profile boundaries (my call)
- **One profile per person per Slack workspace (tenant).** The source id includes the team id: `profile-<teamId>-<userId>`. Every persona in that tenant shares it, and nothing crosses tenants, even on Enterprise Grid where user ids are global.
- **The agent never repeats a person's profile to anyone else.** It acts on it (e.g. holds a ping during that person's quiet hours) without stating it ("she has quiet hours until 08:00" is forbidden). Phase A adds the rule; phase C adds a test.

### 8.4 Per-turn core context
Injected in a `<memory-context>` block alongside today's recent turns:
- the agent's `self/lessons`;
- the speaker's `profile`;
- open `commitment`s involving the speaker or this thread;
- the channel's `shared/channels/<id>` page if present.

Bounded at about 2k tokens; truncate by recency.

### 8.5 Transcript readability fix
Make `conversations/<session>` recallable beyond the recent window. Either chunk and embed timeline entries, or write a rolling summary into the page body at thread quiet time (phase D's quiet-moment pass); left to the builder (§12), after verifying §4.4's suspicion.

### 8.6 Tools
- Extend `kb_memoize` with a `type` field and the common frontmatter, and a `target: "profile"` that resolves to the speaker's profile and is refused when the subject isn't the speaker.
- Add `memory_about({ userId })` for the "what do you know about me" view.

### 8.7 Verification
- Scope matrix tests extended with `profile-<id>` for every row of §4.4. Critically: someone else's locked thread reads only the speaker's profile, never the lock owner's.
- A sim /1on1 scenario proving a /1on1 inference never appears in a later channel turn.
- Supersede tests.

## 9. Phase D: background learning and budget

### 9.1 Passes
| Pass | Cadence | Does |
|---|---|---|
| Nightly review | daily, agent's local night | reads the day's transcripts (each in its own scope) and writes person-notes, commitments, investigations, corrections, outcomes; proposes lessons |
| Lessons upkeep | after nightly review | merges proposals into `self/lessons` under the lesson rules |
| Skill check (post-turn) | after qualifying turns (§6.3) | existing auto-evolve, now budgeted |
| Weekly skill review | weekly | audits skills against usage and outcomes; retires unused or harmful ones (soft delete, restorable) |
| Quiet-moment pass | when a thread with ≥ N turns goes quiet for M minutes, at most K times a day | the nightly review for one thread, sooner; writes the transcript summary (§8.5) |
| Weekly digest | weekly, to the manager's DM | lessons added/dropped, skills added/retired, spend vs budget, passes skipped |

**Approvals in background passes (my call):**
- Passes never call approval-carded or mutating tools directly. Their tool set is read-only, plus writes to slices that auto-pass.
- Anything that would need a card becomes a **proposal**: a `shared` team fact, promoting /1on1 content, any external mutation. Proposals queue in a small table and are delivered as cards:
  - the manager's in the weekly digest;
  - a person's in their DM, and only theirs for /1on1 promotion.
- Nothing is written until the card is approved. Unanswered proposals expire after 14 days.

**Skill retirement scope (my call):** the weekly review may soft-delete only skills the agent authored (`write_skill`). For skills installed from `slaude.json` or a personas repo, it can only propose removal to the operator in the digest, because a git sync would restore them.

**Scope rule:** a pass over /1on1 or DM content runs **as that person** (`runAsUser`, like cron jobs created in a /1on1), reads and writes only their slice and profile, and reports only to their /1on1 thread or DM. Agent-scope passes see only agent, shared and public content.

### 9.2 Lesson rules
- At most about 40 lines; when full, merge or drop before adding.
- A lesson needs a correction or a pattern seen twice; one unexplained failure is never a rule.
- Each lesson is dated and sourced, and supersedes rather than contradicts.
- Changes appear in the weekly digest. A lesson that keeps proving itself may be proposed for promotion into the SOUL; the operator merges it in git.

### 9.3 Budget
- **Scope:** all background passes plus the post-turn skill check. User-driven turns are not counted.
- **Unit:** USD. Cost per run = Σ tokens(kind) × price(model, kind) over input, output, cache read and cache write. Prices come from a price table, never from the SDK's cost figure.
- **Price table:** in process config (`SLAUDE_PRICE_TABLE`, a JSON path or inline), keyed by model id. It ships with Anthropic list prices as the default. Unknown model → the pass refuses to start and logs (never assume zero).
- **Ledger:** a DB table `background_runs`:

  | column | |
  |---|---|
  | `id` | |
  | `agent_id` | |
  | `pass` | |
  | `scope` | agent \| user-id, no content |
  | `model` | |
  | `tokens_*` | per kind |
  | `cost_usd` | |
  | `started_at` / `finished_at` | |
  | `outcome` | ok \| skipped-budget \| stopped-budget \| error |

- **Day:** midnight to midnight in the agent's timezone (my call). Configure per persona; default `UTC`.
- **Limit:** `SLAUDE_BACKGROUND_BUDGET_USD` (default `1`), overridable per persona in its bundle config. A pass starts only if the remaining budget ≥ its estimate (last run's cost, or a configured floor). It checks after every turn and stops once over; it may overshoot by at most one turn. Each pass also has a max-turns cap.
- **Priority when budget is short:** due commitments (phase E) → nightly review → quiet-moment → weekly skill review → skill check. Skipped passes are listed in the digest, not messaged (my call).
- **Metrics:** `slaude_background_cost_usd_total{agent,pass}`, `slaude_background_runs_total{agent,pass,outcome}`.

### 9.4 Verification
- Ledger arithmetic tests against a fixed price table.
- Budget stop and skip tests with a fake model.
- A sim scenario that runs a nightly review over a /1on1 transcript and proves writes land only in that user's slice and profile.
- The digest renders from the ledger.

## 10. Phase E: proactiveness

### 10.1 Promises (always on)
- Any `commitment` with a due time or event is checked by a scheduler pass. It is budgeted, but at the top of the priority list.
- When due, it runs the stored check in the commitment's scope and posts **in the same thread to the beneficiary**, or stays silent, per the commitment's `when-nothing-changed`.
- **Event-based due dates are polled (my call).** "After the deploy" is stored with a check to run, re-run on the scheduler's timer (default 15 min) until it resolves or expires (default 24 h, then a one-line "couldn't confirm" to the beneficiary). No webhook ingress is in scope.
- **Not gated by `## Proactive`.** The decision gate (phase B) does not apply; the promise is the authorization.
- A commitment never widens its audience: same thread, same person.

### 10.2 SOUL switch
```md
## Proactive
- Enabled: no            # yes | no — default no
- Quiet hours: 21:00–08:00
- Max per person per day: 1

## Channel <#C…>
### Proactive
- Enabled: yes           # per-channel override, either direction
```
- Parsed into `SoulData.proactive` and `ChannelOverride.proactive`.
- **Must never be added to the runtime override fields** (`src/soul/overrides.ts`). A test asserts the override field list excludes it.
- People can only lower it: a profile mute or quiet hours always wins. Nothing at runtime can raise it.

### 10.3 Heartbeat (when enabled)
- A timer pass (default every 30 minutes, budgeted) reads `agent-<id>/self/heartbeat` and runs each check.
- The agent maintains the checklist itself: what it checks is the agent's; whether it runs is the operator's.
- The pass may post only when the result is meaningfully new and worth an interruption. Unchanged, routine or no-op results stay silent (every notification interrupts someone).

### 10.4 Audience ladder
| Audience | Allowed when |
|---|---|
| Manager DM | `## Proactive` enabled |
| Another person's DM | enabled **and** that person's profile opts in to the topic |
| A channel | the channel's `### Proactive` resolves to enabled **and** the content concerns the channel |

Every proactive post also passes the restraint rules: silent on no news, per-person cooldown and daily cap, quiet hours, evidence-backed (hypotheses labelled as such), no new audience without one of the conditions above.

**Code vs model (my call):**
- **Enforced in code,** so testable deterministically: quiet hours, per-person cooldown, daily cap, the audience ladder's switch and opt-in checks, mutes. The posting tool refuses a proactive post that breaks any of them.
- **Left to the model,** so tested by sim evals rather than unit tests: whether a result is "meaningfully new" and whether content "concerns the channel".
- **Topics are free text** in the profile. The model matches them, and the code checks the model cited a profile topic for any DM to a non-manager.

### 10.5 Feedback loop
- Reactions or replies to proactive posts are recorded as `outcome`s.
- A "stop" or "not this" becomes a profile mute **for that topic only**; one dismissal is not a permanent opt-out.

### 10.6 Verification
- A sim test that a promise is kept with proactive off.
- A test that `## Proactive` is absent from overrides.
- Tests per ladder row, quiet hours, cooldown, and "unchanged result posts nothing".

## 11. Cross-cutting

### 11.1 Configuration summary
| Setting | Where | Phase |
|---|---|---|
| Writing style, pass, auto-evolve wording | code (baseline) | A |
| `SLAUDE_AUTO_EVOLVE_MIN_TOOLS` | process env | A |
| `SLAUDE_DECISION_*`, `TYPESAFE_API_KEY` | process env, gateway secret | B |
| Core prompt, state modules, built-in skills | read-only files shipped with the release | R |
| `SLAUDE_BACKGROUND_BUDGET_USD`, `SLAUDE_PRICE_TABLE` | process env, per-persona override in bundle | D |
| Agent timezone | persona config | D |
| `## Proactive` (global and per channel) | SOUL only | E |

### 11.2 Invariants
Every phase must keep these. Each gets a test.
1. Nothing from a /1on1 reaches another person's turn, a channel, `agent-<id>` or `shared` without that person's approval.
2. A profile is written only from that person's own words: live on their turn, or by a pass quoting their turn (§8.3a).
3. Proactiveness can be raised only by the SOUL.
4. `SLAUDE_DECISION_GATE=off` equals today's engagement behaviour.
5. Background spend never exceeds the day's budget by more than one turn per pass.
6. No reply narrates machinery (phase A lint).
7. Rules that must hold every turn live in the core or a state module, never only in a lazily loaded skill (phase R).
8. A governed tool never runs in a session that has not loaded its built-in skill (phase R hook).
9. Built-in skills cannot be created, changed, shadowed or deleted at runtime (phase R).

### 11.3 Public-repo hygiene
Specs, tests and fixtures use placeholder people, channels and services only (CLAUDE.md working rules).

## 12. Left to the builder
- The transcript recall fix (§8.5): chunk timeline entries vs a rolling summary, after verifying the cause.
- Exact Jev request shape (follow the vendor's API reference; the endpoint, auth and answer types in §7.3 come from a third-party reference dated 2026-10-09, so check them against the official docs once the host is reachable). Pin the model version.
- Phase R: the exact file layout under `src/soul/runtime/`, the frontmatter key name for governed tools, and the core's size budget.
- The `kbHitScore` normalization across engines.
- Quiet-moment thresholds N, M, K, and the heartbeat interval defaults.
- Pass estimate floors and max-turn caps.
- Exact prompt wording of each pass, within the rules above.
- Migration of the one existing hand-written `people/` page into `profile` vs `person-note`.

