# Mock LLM Server (Plan 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stateless, Anthropic-compatible mock LLM server that the real Claude CLI can run whole turns against, with tag-selected scenarios and tag-driven fault injection, packaged as a container image.

**Architecture:** Pure, fully unit-tested logic in `e2e/mock-llm/core/` (tag parsing, history-derived phase, scenarios, fault planning). A thin `server.ts` wires it to `@copilotkit/aimock`: aimock serves happy-path content (SSE encoding, tool_use, thinking), and a front HTTP handler applies faults that depend only on the tag and request headers (delay, HTTP error, stream cut, hang, malformed SSE), answers `count_tokens`, and keeps its own request journal. The server is bundled to one Node file and shipped in a small image.

**Tech Stack:** Bun + TypeScript (`bun test`), `@copilotkit/aimock` 1.43.0 (pinned, devDependency), Node 22 at runtime, Docker.

**Spec:** `docs/superpowers/specs/2026-09-30-e2e-mock-llm-design.md` (sections 1 and 3). Plans 2 (cluster and Slack harness) and 3 (HA scenarios and nightly workflow) are written after Task 1's decision, because they depend on it.

## Global Constraints

- Bun + TypeScript; tests are `*.test.ts` picked up by root `bun test`.
- Root `bunfig.toml` enforces coverage thresholds: line 0.97, function 0.80, statement 0.97. Everything under `e2e/mock-llm/core/` is loaded in-process by tests and must stay covered. `server.ts` and `main.ts` are exercised only in a spawned child process, so they are not loaded in-process and do not count.
- Root `tsc --noEmit` typechecks `e2e/`; it must stay clean (`bun run typecheck`).
- `@copilotkit/aimock` is pinned to the exact version `1.43.0` in root `devDependencies` (no caret).
- Statelessness rule: a response is a pure function of the request (body plus headers). No server-side counters, no `sequenceIndex`, no `turnIndex`. The only mutable state allowed is the request journal, which is observation only and never influences a reply. Amended after the Task 1 spike (see the Ruling in the ledger): the one exception is a fault-only per-(system prompt, history) attempt counter in the front handler, which never changes reply content.
- Scenario tag grammar: `[[mock:<name> key=value key=value]]`, lowercase names and keys, values contain no whitespace or `]`. The current turn's tag is the tag in the **most recent user message that carries one**.
- Persona marker: a test persona's `SOUL.md` contains a line `Persona-ID: <id>`; the mock reads it from the system prompt.
- Public repo: no real names, org names, workspace or channel identifiers, or internal service names anywhere (code, tests, comments, docs, commit messages). Use placeholders.
- Commits: granular, one logical change each, conventional style, **no `Co-Authored-By` or "Generated with" trailers**. Before every `git add`, run the pre-commit leak scan from `CLAUDE.md`:
  `git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names'`
  Any hit that is not an intentional placeholder is replaced before committing.
- Work happens in the worktree `/Users/barock/Code/slaude/.claude/worktrees/e2e-test-with-mock-llm` on branch `worktree-e2e-test-with-mock-llm`.

## Review Focus

Failure modes the spec implies but a happy-path test would miss, most likely first:

1. **Untagged requests.** The Claude CLI makes side calls (for example title generation) with no tag. The mock must answer them with a valid response, never an error or a hang. Owned by Task 4 (`resolveReply`) and Task 6 (server test).
2. **Tag echoed back.** `echo` repeats user text; if it repeated the tag, the assistant text would carry a tag and could re-select a scenario on a later turn. The reply must have tags stripped. Owned by Task 4.
3. **Second turn with a different tag.** A resumed thread's later user message carries its own tag; the most recent tag must win and earlier tool results must not count toward the new turn's phase. Owned by Tasks 2 and 3.
4. **Hostile bodies.** Non-JSON, empty, or very large request bodies must not crash the front handler or stop it serving the next request. Owned by Task 6.
5. **Client abort during hang, delay or stream.** Timers and sockets are released and the server keeps serving. Owned by Task 6.

Also covered: two concurrent requests with different tags do not interfere (Task 6).

---

### Task 1: Spike, prove the real CLI works against aimock (throwaway)

Nothing in this task is committed except the findings note. All code lives in the scratchpad. **Decision gate:** the outcome decides whether Tasks 2 to 7 proceed as written.

**Files:**
- Create (scratchpad only): `$S/spike/spike.mjs` where `S=/private/tmp/claude-501/-Users-barock-Code-slaude/ae585cb7-b85b-45b4-9431-4e06c5a13f5b/scratchpad`
- Create: `docs/site/_content/field-notes/2026-09-30-e2e-mock-llm-spike.md`
- Modify: `CLAUDE.md` (add one index line at the top of the Findings Log list)

**Interfaces:**
- Produces: a written go/no-go and five recorded answers that Tasks 3 and 6 rely on (message shape, endpoints hit, retry header, custom header, Bun compatibility).

- [ ] **Step 1: Write the spike script**

```bash
mkdir -p "$S/spike" && cd "$S/spike" && ln -sfn ../aimock/node_modules node_modules
```

`$S/spike/spike.mjs`:

```js
import { LLMock } from "@copilotkit/aimock";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scenario = process.env.SCENARIO ?? "tools"; // tools | fail-once
const seen = [];
let failed = false;

const mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "info", chunkSize: 16 });

mock.mount("/v1/messages/count_tokens", {
  async handleRequest(_req, res) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: 1 }));
    return true;
  },
});

mock.on({ predicate: () => true }, (req) => {
  seen.push({ ctx: req._context, msgs: JSON.parse(JSON.stringify(req.messages)) });
  if (scenario === "fail-once" && !failed) {
    failed = true;
    return { error: { message: "overloaded", type: "overloaded_error" }, status: 529 };
  }
  const tools = req.messages.filter((m) => m.role === "tool").length;
  if (scenario === "tools" && tools < 2) {
    return { toolCalls: [{ name: "Bash", arguments: JSON.stringify({ command: `echo step-${tools + 1}` }), id: `toolu_mock_${tools + 1}` }] };
  }
  return { content: "spike done" };
});

const url = await mock.start();
const home = mkdtempSync(join(tmpdir(), "spike-claude-"));
const child = spawn(
  "claude",
  ["-p", "run two commands", "--output-format", "json", "--allowedTools", "Bash", "--max-turns", "6", "--model", "claude-sonnet-5-5"],
  {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: "sk-mock",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      ...(process.env.CUSTOM_HEADERS ? { ANTHROPIC_CUSTOM_HEADERS: process.env.CUSTOM_HEADERS } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
child.on("close", async (code) => {
  console.log("--- claude exit", code, "\n", out.slice(0, 1500));
  console.log("--- journal");
  for (const r of mock.getRequests()) {
    console.log(JSON.stringify({ path: r.path, status: r.response.status, retry: r.headers["x-stainless-retry-count"], ctx: r.headers["x-aimock-context"], ua: r.headers["user-agent"] }));
  }
  console.log("--- normalized history of the LAST request");
  console.log(JSON.stringify(seen.at(-1), null, 1)?.slice(0, 3000));
  await mock.stop();
});
```

- [ ] **Step 2: Run the tool-loop probe**

Run: `cd "$S/spike" && SCENARIO=tools node spike.mjs`
Expected: `claude exit 0`, the journal lists `/v1/messages` requests, the last request's normalized history contains two `role: "tool"` messages (or two `tool_result` parts, record which), and the output contains `spike done`.

- [ ] **Step 3: Run the retry-header probe**

Run: `cd "$S/spike" && SCENARIO=fail-once node spike.mjs`
Expected: the journal shows a first request with status 529 and a second request. Record the exact value of `x-stainless-retry-count` on the second request (expected `1`; `undefined` means the CLI does not forward it and fault scenarios must fall back to counting attempts in the front handler's journal keyed by history hash).

- [ ] **Step 4: Run the custom-header probe**

Run: `cd "$S/spike" && SCENARIO=tools CUSTOM_HEADERS="X-AIMock-Context: t1" node spike.mjs`
Expected: journal entries show `ctx: t1`. This is optional; record yes or no.

- [ ] **Step 5: Run under Bun**

Run: `cd "$S/spike" && SCENARIO=tools bun spike.mjs`
Expected: record whether aimock starts and completes the same run under Bun. If not, the production image stays on Node (already the plan).

- [ ] **Step 6: Record findings and the decision**

Create `docs/site/_content/field-notes/2026-09-30-e2e-mock-llm-spike.md` with front matter and these sections, filled with what you observed (endpoints seen, message shape, retry header value, custom header result, Bun result, anything the CLI did that surprised you):

```markdown
---
title: "Can the real Claude CLI run a turn against a mock LLM?"
date: 2026-09-30
---

**Decision:** build on aimock | fall back to a thin custom server (pick one, with the reason).

## What the CLI called
## What the mock saw in `messages[]`
## Retry header
## Custom header
## Bun
```

Add this line at the top of the Findings Log list in `CLAUDE.md`, above the current newest entry, matching the existing style (one sentence of mechanism, no internal specifics):

```markdown
- [2026-09-30 — Mock LLM spike: <one sentence of the deciding finding>](docs/site/_content/field-notes/2026-09-30-e2e-mock-llm-spike.md)
```

- [ ] **Step 7: Apply the decision**

If the decision is "aimock": continue with Task 2. If the CLI's history shape differs from `role: "tool"` messages, note it in the findings; Task 3's `viewHistory` already handles both shapes. If the decision is "custom server": stop, amend the spec section 1, and rewrite Tasks 2 to 7 against a hand-written `/v1/messages` SSE encoder before continuing. Do not improvise.

- [ ] **Step 8: Commit**

```bash
cd /Users/barock/Code/slaude/.claude/worktrees/e2e-test-with-mock-llm
git add docs/site/_content/field-notes/2026-09-30-e2e-mock-llm-spike.md CLAUDE.md
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "docs(e2e): record mock-LLM spike findings and decision"
```

Note: the spike uses the dummy key `sk-mock`, which is not a secret; if the leak scan flags it in the findings note, write it as `<dummy key>` there.

---

### Task 2: Shared types and tag parsing

**Files:**
- Modify: `package.json` (add devDependency)
- Create: `e2e/mock-llm/core/types.ts`
- Create: `e2e/mock-llm/core/tag.ts`
- Test: `e2e/mock-llm/core/tag.test.ts`

**Interfaces:**
- Produces (`types.ts`): `MockContentPart`, `MockMessage`, `MockRequest`, `Tag`, `ToolCallSpec`, `MockReply`, `HistoryView`, `ScenarioCtx`, `Scenario` (exact shapes below).
- Produces (`tag.ts`): `parseTag(text: string): Tag | null`, `lastTagIn(text: string): Tag | null`, `stripTags(text: string): string`, `messageText(m: MockMessage): string`, `findTag(req: MockRequest): { index: number; tag: Tag } | null`, `paramInt(tag: Tag, key: string, dflt: number): number`, `parseDurationMs(raw: string | undefined, dflt: number): number`.

- [ ] **Step 1: Add the pinned dependency**

Run: `bun add -d --exact @copilotkit/aimock@1.43.0`
Expected: `package.json` `devDependencies` contains `"@copilotkit/aimock": "1.43.0"` (no caret) and `bun.lock` updates.

- [ ] **Step 2: Write the types**

`e2e/mock-llm/core/types.ts`:

```ts
export interface MockContentPart {
  type: string;
  text?: string;
}

/** The subset of aimock's normalized chat message the scenarios read. */
export interface MockMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | MockContentPart[] | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface MockRequest {
  messages: MockMessage[];
}

export interface Tag {
  name: string;
  params: Record<string, string>;
}

export interface ToolCallSpec {
  /** Deterministic id, derived from the request, never from server state. */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type MockReply =
  | { kind: "text"; content: string; reasoning?: string }
  | { kind: "tools"; calls: ToolCallSpec[] };

/** What a scenario may learn from the conversation so far. */
export interface HistoryView {
  /** Text of each tool result since the current turn's tagged user message. */
  toolResults: string[];
  /** Value of the `Persona-ID:` line in the system prompt, if any. */
  persona: string | null;
}

export interface ScenarioCtx {
  tag: Tag;
  view: HistoryView;
  /** The tagged user message with every tag removed. */
  userText: string;
}

export interface Scenario {
  name: string;
  reply(ctx: ScenarioCtx): MockReply;
}
```

- [ ] **Step 3: Write the failing tests**

`e2e/mock-llm/core/tag.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { findTag, lastTagIn, messageText, paramInt, parseDurationMs, parseTag, stripTags } from "./tag";
import type { MockRequest } from "./types";

describe("parseTag", () => {
  test("parses a bare tag", () => {
    expect(parseTag("hi [[mock:echo]] there")).toEqual({ name: "echo", params: {} });
  });
  test("parses params", () => {
    expect(parseTag("[[mock:multi-tool n=3 tool=Bash]]")).toEqual({
      name: "multi-tool",
      params: { n: "3", tool: "Bash" },
    });
  });
  test("returns null without a tag, and for uppercase or unterminated tags", () => {
    expect(parseTag("no tag here")).toBeNull();
    expect(parseTag("[[MOCK:echo]]")).toBeNull();
    expect(parseTag("[[mock:echo")).toBeNull();
  });
  test("ignores params that break the grammar", () => {
    expect(parseTag("[[mock:echo Bad=1]]")).toBeNull();
  });
});

describe("lastTagIn", () => {
  test("returns the last of several tags", () => {
    expect(lastTagIn("[[mock:echo]] a [[mock:think]] b")?.name).toBe("think");
  });
  test("returns null when there is none", () => {
    expect(lastTagIn("nothing")).toBeNull();
  });
});

describe("stripTags", () => {
  test("removes tags and collapses whitespace", () => {
    expect(stripTags("  hello [[mock:echo n=1]]   world ")).toBe("hello world");
  });
});

describe("messageText", () => {
  test("handles string, part arrays and null", () => {
    expect(messageText({ role: "user", content: "a" })).toBe("a");
    expect(messageText({ role: "user", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })).toBe("a\n\nb");
    expect(messageText({ role: "user", content: null })).toBe("");
  });
});

describe("findTag", () => {
  const req = (...msgs: MockRequest["messages"]): MockRequest => ({ messages: msgs });

  test("picks the most recent user message that carries a tag", () => {
    const found = findTag(
      req(
        { role: "user", content: "[[mock:echo]] first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "[[mock:think]] second" },
      ),
    );
    expect(found).toEqual({ index: 2, tag: { name: "think", params: {} } });
  });

  test("ignores tags inside assistant messages", () => {
    const found = findTag(
      req({ role: "user", content: "[[mock:echo]] q" }, { role: "assistant", content: "[[mock:think]] echoed" }),
    );
    expect(found?.tag.name).toBe("echo");
    expect(found?.index).toBe(0);
  });

  test("skips user messages without a tag, and returns null when none has one", () => {
    expect(findTag(req({ role: "user", content: "plain" }))).toBeNull();
    expect(findTag(req({ role: "user", content: "[[mock:echo]]" }, { role: "user", content: "plain" }))?.index).toBe(0);
  });
});

describe("paramInt", () => {
  test("parses, defaults on missing or non-numeric", () => {
    const tag = { name: "x", params: { n: "3", bad: "abc" } };
    expect(paramInt(tag, "n", 9)).toBe(3);
    expect(paramInt(tag, "missing", 9)).toBe(9);
    expect(paramInt(tag, "bad", 9)).toBe(9);
  });
});

describe("parseDurationMs", () => {
  test("parses ms, s and bare numbers; defaults otherwise", () => {
    expect(parseDurationMs("500ms", 0)).toBe(500);
    expect(parseDurationMs("2s", 0)).toBe(2000);
    expect(parseDurationMs("750", 0)).toBe(750);
    expect(parseDurationMs(undefined, 7)).toBe(7);
    expect(parseDurationMs("soon", 7)).toBe(7);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun test e2e/mock-llm/core/tag.test.ts --coverage=false`
Expected: FAIL, cannot find module `./tag`.

- [ ] **Step 5: Implement `tag.ts`**

`e2e/mock-llm/core/tag.ts`:

```ts
import type { MockMessage, MockRequest, Tag } from "./types";

const TAG_SRC = String.raw`\[\[mock:([a-z][a-z0-9-]*)((?:\s+[a-z][a-z0-9-]*=[^\s\]]+)*)\s*\]\]`;
const PARAM_RE = /([a-z][a-z0-9-]*)=([^\s\]]+)/g;

function toTag(name: string, rawParams: string): Tag {
  const params: Record<string, string> = {};
  for (const p of rawParams.matchAll(PARAM_RE)) params[p[1]!] = p[2]!;
  return { name, params };
}

export function parseTag(text: string): Tag | null {
  const m = new RegExp(TAG_SRC).exec(text);
  return m ? toTag(m[1]!, m[2] ?? "") : null;
}

/** Last tag in free text. Raw request bodies carry one tag per turn. */
export function lastTagIn(text: string): Tag | null {
  let last: Tag | null = null;
  for (const m of text.matchAll(new RegExp(TAG_SRC, "g"))) last = toTag(m[1]!, m[2] ?? "");
  return last;
}

export function stripTags(text: string): string {
  return text.replace(new RegExp(TAG_SRC, "g"), "").replace(/\s+/g, " ").trim();
}

export function messageText(m: MockMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => p.text ?? "").join("\n");
  return "";
}

/** The current turn's tag: the most recent user message that carries one. */
export function findTag(req: MockRequest): { index: number; tag: Tag } | null {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user") continue;
    const tag = parseTag(messageText(m));
    if (tag) return { index: i, tag };
  }
  return null;
}

export function paramInt(tag: Tag, key: string, dflt: number): number {
  const n = Number.parseInt(tag.params[key] ?? "", 10);
  return Number.isFinite(n) ? n : dflt;
}

export function parseDurationMs(raw: string | undefined, dflt: number): number {
  const m = /^(\d+)(ms|s)?$/.exec(raw ?? "");
  if (!m) return dflt;
  return Number(m[1]) * (m[2] === "s" ? 1000 : 1);
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test e2e/mock-llm/core/tag.test.ts --coverage=false && bun run typecheck`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock e2e/mock-llm/core/types.ts e2e/mock-llm/core/tag.ts e2e/mock-llm/core/tag.test.ts
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "feat(e2e): mock-llm scenario tag parsing and shared types"
```

---

### Task 3: History-derived phase and persona

**Files:**
- Create: `e2e/mock-llm/core/history.ts`
- Test: `e2e/mock-llm/core/history.test.ts`

**Interfaces:**
- Consumes: `MockRequest`, `HistoryView` (Task 2), `messageText` (Task 2).
- Produces: `viewHistory(req: MockRequest, tagIndex: number): HistoryView`.

- [ ] **Step 1: Write the failing tests**

`e2e/mock-llm/core/history.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { viewHistory } from "./history";
import type { MockRequest } from "./types";

describe("viewHistory", () => {
  test("no tool results yet", () => {
    const req: MockRequest = { messages: [{ role: "user", content: "[[mock:multi-tool]] go" }] };
    expect(viewHistory(req, 0)).toEqual({ toolResults: [], persona: null });
  });

  test("collects role:tool results after the tagged message", () => {
    const req: MockRequest = {
      messages: [
        { role: "user", content: "[[mock:multi-tool n=2]] go" },
        { role: "assistant", content: null, tool_calls: [{ id: "t1", function: { name: "Bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", content: "step-1" },
      ],
    };
    expect(viewHistory(req, 0).toolResults).toEqual(["step-1"]);
  });

  test("also counts tool_result parts inside user messages", () => {
    const req: MockRequest = {
      messages: [
        { role: "user", content: "[[mock:multi-tool]] go" },
        { role: "assistant", content: null },
        { role: "user", content: [{ type: "tool_result", text: "step-1" }] },
      ],
    };
    expect(viewHistory(req, 0).toolResults).toEqual(["step-1"]);
  });

  test("ignores tool results from before the current turn's tagged message", () => {
    const req: MockRequest = {
      messages: [
        { role: "user", content: "[[mock:multi-tool n=1]] one" },
        { role: "tool", tool_call_id: "t1", content: "old" },
        { role: "assistant", content: "done" },
        { role: "user", content: "[[mock:multi-tool n=1]] two" },
      ],
    };
    expect(viewHistory(req, 3).toolResults).toEqual([]);
  });

  test("reads the persona marker from the system prompt", () => {
    const req: MockRequest = {
      messages: [
        { role: "system", content: "You are helpful.\nPersona-ID: alpha_1\nBe brief." },
        { role: "user", content: "[[mock:echo]] hi" },
      ],
    };
    expect(viewHistory(req, 1).persona).toBe("alpha_1");
  });

  test("reads the persona marker from system parts arrays", () => {
    const req: MockRequest = {
      messages: [
        { role: "system", content: [{ type: "text", text: "x" }, { type: "text", text: "Persona-ID: beta" }] },
        { role: "user", content: "[[mock:echo]] hi" },
      ],
    };
    expect(viewHistory(req, 1).persona).toBe("beta");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test e2e/mock-llm/core/history.test.ts --coverage=false`
Expected: FAIL, cannot find module `./history`.

- [ ] **Step 3: Implement**

`e2e/mock-llm/core/history.ts`:

```ts
import { messageText } from "./tag";
import type { HistoryView, MockRequest } from "./types";

const PERSONA_RE = /Persona-ID:\s*([A-Za-z0-9_-]+)/;

/**
 * Derive everything a scenario may know about the conversation from the request
 * alone. Tool results count only when they follow the current turn's tagged
 * user message, so a resumed thread starts each turn at phase zero.
 */
export function viewHistory(req: MockRequest, tagIndex: number): HistoryView {
  const toolResults: string[] = [];
  for (const m of req.messages.slice(tagIndex + 1)) {
    if (m.role === "tool") {
      toolResults.push(messageText(m));
    } else if (m.role === "user" && Array.isArray(m.content)) {
      for (const part of m.content) if (part.type === "tool_result") toolResults.push(part.text ?? "");
    }
  }
  const system = req.messages.filter((m) => m.role === "system").map(messageText).join("\n");
  return { toolResults, persona: PERSONA_RE.exec(system)?.[1] ?? null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test e2e/mock-llm/core/history.test.ts --coverage=false`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e/mock-llm/core/history.ts e2e/mock-llm/core/history.test.ts
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "feat(e2e): derive turn phase and persona from request history"
```

---

### Task 4: Scenarios and the reply resolver

**Files:**
- Create: `e2e/mock-llm/core/scenarios.ts`
- Create: `e2e/mock-llm/core/registry.ts`
- Test: `e2e/mock-llm/core/registry.test.ts`

**Interfaces:**
- Consumes: `Scenario`, `ScenarioCtx`, `MockReply`, `MockRequest` (Task 2); `findTag`, `messageText`, `stripTags`, `paramInt` (Task 2); `viewHistory` (Task 3).
- Produces: `SCENARIOS: Map<string, Scenario>` (names `echo`, `multi-tool`, `long-stream`, `think`) and `resolveReply(req: MockRequest): MockReply`.

- [ ] **Step 1: Write the failing tests**

`e2e/mock-llm/core/registry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolveReply } from "./registry";
import type { MockRequest } from "./types";

const user = (text: string): MockRequest => ({ messages: [{ role: "user", content: text }] });

describe("resolveReply", () => {
  test("untagged requests get a valid text reply, never an error", () => {
    expect(resolveReply(user("write a title for this chat"))).toEqual({ kind: "text", content: "mock: untagged request" });
  });

  test("unknown scenario names are reported in the reply", () => {
    expect(resolveReply(user("[[mock:nope]] hi"))).toEqual({ kind: "text", content: "mock: unknown scenario nope" });
  });

  describe("echo", () => {
    test("echoes text with the persona and strips tags", () => {
      const req: MockRequest = {
        messages: [
          { role: "system", content: "Persona-ID: alpha" },
          { role: "user", content: "[[mock:echo]] hello there" },
        ],
      };
      expect(resolveReply(req)).toEqual({ kind: "text", content: "[alpha] hello there" });
    });

    test("never repeats a tag, so it cannot re-select a scenario next turn", () => {
      const reply = resolveReply(user("[[mock:echo]] again [[mock:think]]"));
      expect(reply.kind).toBe("text");
      expect((reply as { content: string }).content).not.toContain("[[mock:");
    });

    test("falls back to an unknown persona label", () => {
      expect(resolveReply(user("[[mock:echo]] hi"))).toEqual({ kind: "text", content: "[unknown] hi" });
    });
  });

  describe("multi-tool", () => {
    const withResults = (n: number, tag = "[[mock:multi-tool n=2]] go"): MockRequest => ({
      messages: [
        { role: "user", content: tag },
        ...Array.from({ length: n }, (_, i) => ({ role: "tool" as const, tool_call_id: `toolu_mock_${i + 1}`, content: `step-${i + 1}` })),
      ],
    });

    test("issues tool call 1 first, with a deterministic id", () => {
      expect(resolveReply(withResults(0))).toEqual({
        kind: "tools",
        calls: [{ id: "toolu_mock_1", name: "Bash", args: { command: "echo step-1" } }],
      });
    });

    test("issues tool call 2 after one result", () => {
      const r = resolveReply(withResults(1));
      expect(r.kind === "tools" && r.calls[0]!.id).toBe("toolu_mock_2");
    });

    test("summarises once all n results are in", () => {
      expect(resolveReply(withResults(2))).toEqual({ kind: "text", content: "done after 2 tools" });
    });

    test("defaults to two tools and accepts a tool name", () => {
      const r = resolveReply(withResults(0, "[[mock:multi-tool tool=Read]] go"));
      expect(r.kind === "tools" && r.calls[0]!.name).toBe("Read");
      expect(resolveReply(withResults(2, "[[mock:multi-tool]] go"))).toEqual({ kind: "text", content: "done after 2 tools" });
    });

    test("a second turn with its own tag starts again at phase zero", () => {
      const req: MockRequest = {
        messages: [
          { role: "user", content: "[[mock:multi-tool n=1]] one" },
          { role: "tool", tool_call_id: "toolu_mock_1", content: "step-1" },
          { role: "assistant", content: "done after 1 tools" },
          { role: "user", content: "[[mock:multi-tool n=1]] two" },
        ],
      };
      const r = resolveReply(req);
      expect(r.kind === "tools" && r.calls[0]!.id).toBe("toolu_mock_1");
    });
  });

  describe("long-stream", () => {
    test("produces the requested number of chunks", () => {
      const r = resolveReply(user("[[mock:long-stream chunks=5]] go"));
      expect(r.kind).toBe("text");
      expect((r as { content: string }).content.match(/chunk-\d+/g)).toHaveLength(5);
    });
    test("defaults to twenty chunks", () => {
      const r = resolveReply(user("[[mock:long-stream]] go"));
      expect((r as { content: string }).content.match(/chunk-\d+/g)).toHaveLength(20);
    });
  });

  describe("think", () => {
    test("returns reasoning separate from the answer", () => {
      expect(resolveReply(user("[[mock:think]] q"))).toEqual({
        kind: "text",
        content: "thought about it",
        reasoning: "private reasoning that must never reach Slack",
      });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test e2e/mock-llm/core/registry.test.ts --coverage=false`
Expected: FAIL, cannot find module `./registry`.

- [ ] **Step 3: Implement scenarios**

`e2e/mock-llm/core/scenarios.ts`:

```ts
import { paramInt } from "./tag";
import type { Scenario } from "./types";

const echo: Scenario = {
  name: "echo",
  reply: ({ view, userText }) => ({ kind: "text", content: `[${view.persona ?? "unknown"}] ${userText}` }),
};

const multiTool: Scenario = {
  name: "multi-tool",
  reply: ({ tag, view }) => {
    const n = paramInt(tag, "n", 2);
    const done = view.toolResults.length;
    if (done >= n) return { kind: "text", content: `done after ${n} tools` };
    return {
      kind: "tools",
      calls: [{ id: `toolu_mock_${done + 1}`, name: tag.params["tool"] ?? "Bash", args: { command: `echo step-${done + 1}` } }],
    };
  },
};

const longStream: Scenario = {
  name: "long-stream",
  reply: ({ tag }) => {
    const chunks = paramInt(tag, "chunks", 20);
    return { kind: "text", content: Array.from({ length: chunks }, (_, i) => `chunk-${i} `).join("").trimEnd() };
  },
};

const think: Scenario = {
  name: "think",
  reply: () => ({
    kind: "text",
    content: "thought about it",
    reasoning: "private reasoning that must never reach Slack",
  }),
};

export const SCENARIOS: Map<string, Scenario> = new Map([echo, multiTool, longStream, think].map((s) => [s.name, s]));
```

- [ ] **Step 4: Implement the resolver**

`e2e/mock-llm/core/registry.ts`:

```ts
import { viewHistory } from "./history";
import { SCENARIOS } from "./scenarios";
import { findTag, messageText, stripTags } from "./tag";
import type { MockReply, MockRequest } from "./types";

/** Pure: the same request always yields the same reply. */
export function resolveReply(req: MockRequest): MockReply {
  const found = findTag(req);
  if (!found) return { kind: "text", content: "mock: untagged request" };
  const scenario = SCENARIOS.get(found.tag.name);
  if (!scenario) return { kind: "text", content: `mock: unknown scenario ${found.tag.name}` };
  return scenario.reply({
    tag: found.tag,
    view: viewHistory(req, found.index),
    userText: stripTags(messageText(req.messages[found.index]!)),
  });
}
```

- [ ] **Step 5: Run tests, typecheck, and check coverage of core**

Run: `bun test e2e/mock-llm --coverage=false && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add e2e/mock-llm/core/scenarios.ts e2e/mock-llm/core/registry.ts e2e/mock-llm/core/registry.test.ts
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "feat(e2e): echo, multi-tool, long-stream and think mock scenarios"
```

---

### Task 5: Fault planning

Faults are orthogonal tag parameters, so any scenario can be combined with any fault. They depend only on the tag and the retry count, never on server state.

**Files:**
- Create: `e2e/mock-llm/core/faults.ts`
- Test: `e2e/mock-llm/core/faults.test.ts`

**Interfaces:**
- Consumes: `Tag` (Task 2); `paramInt`, `parseDurationMs` (Task 2).
- Produces: `FaultAction` (`"proxy" | "error" | "drop" | "malformed" | "hang"`), `FaultPlan`, `planFaults(tag: Tag | null, retryCount: number): FaultPlan`, `errorBody(status: number): { type: "error"; error: { type: string; message: string } }`.

Tag parameters: `ttft=<dur>` (delay before responding), `interval=<dur>` (pause between streamed events), `fail=<status>` with `until-retry=<n>` (default 1: fail attempts whose retry count is below n), `drop=<k>` (cut the stream after k events), `malformed=1`, `hang=1`, `overflow=1` (400 prompt-too-long). Precedence when several are present: hang, overflow, fail, drop, malformed.

- [ ] **Step 1: Write the failing tests**

`e2e/mock-llm/core/faults.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { errorBody, planFaults } from "./faults";
import type { Tag } from "./types";

const tag = (params: Record<string, string>): Tag => ({ name: "echo", params });

describe("planFaults", () => {
  test("no tag, or a tag with no fault params, proxies untouched", () => {
    const none = { action: "proxy", delayMs: 0, intervalMs: 0, status: 0, dropAfterEvents: 0 };
    expect(planFaults(null, 0)).toEqual(none);
    expect(planFaults(tag({}), 0)).toEqual(none);
  });

  test("ttft and interval set timing without changing the action", () => {
    expect(planFaults(tag({ ttft: "2s", interval: "50ms" }), 0)).toMatchObject({ action: "proxy", delayMs: 2000, intervalMs: 50 });
  });

  test("fail returns the status on the first attempt and succeeds on the retry", () => {
    expect(planFaults(tag({ fail: "529" }), 0)).toMatchObject({ action: "error", status: 529 });
    expect(planFaults(tag({ fail: "529" }), 1).action).toBe("proxy");
  });

  test("until-retry keeps failing until that many retries have happened", () => {
    const t = tag({ fail: "429", "until-retry": "2" });
    expect(planFaults(t, 0).action).toBe("error");
    expect(planFaults(t, 1).action).toBe("error");
    expect(planFaults(t, 2).action).toBe("proxy");
  });

  test("drop cuts the stream after k events", () => {
    expect(planFaults(tag({ drop: "3" }), 0)).toMatchObject({ action: "drop", dropAfterEvents: 3 });
  });

  test("malformed and hang", () => {
    expect(planFaults(tag({ malformed: "1" }), 0).action).toBe("malformed");
    expect(planFaults(tag({ hang: "1" }), 0).action).toBe("hang");
  });

  test("overflow is a 400 prompt-too-long error", () => {
    expect(planFaults(tag({ overflow: "1" }), 0)).toMatchObject({ action: "error", status: 400 });
  });

  test("precedence: hang > overflow > fail > drop > malformed", () => {
    const all = { hang: "1", overflow: "1", fail: "529", drop: "2", malformed: "1" };
    expect(planFaults(tag(all), 0).action).toBe("hang");
    const { hang: _h, ...noHang } = all;
    expect(planFaults(tag(noHang), 0)).toMatchObject({ action: "error", status: 400 });
    const { overflow: _o, ...noOverflow } = noHang;
    expect(planFaults(tag(noOverflow), 0)).toMatchObject({ action: "error", status: 529 });
    const { fail: _f, ...noFail } = noOverflow;
    expect(planFaults(tag(noFail), 0).action).toBe("drop");
  });
});

describe("errorBody", () => {
  test("maps statuses to Anthropic error types", () => {
    expect(errorBody(429).error.type).toBe("rate_limit_error");
    expect(errorBody(529).error.type).toBe("overloaded_error");
    expect(errorBody(400).error.type).toBe("invalid_request_error");
    expect(errorBody(401).error.type).toBe("authentication_error");
    expect(errorBody(500).error.type).toBe("api_error");
  });
  test("the 400 body reads like a real prompt-too-long error", () => {
    expect(errorBody(400).error.message).toContain("prompt is too long");
    expect(errorBody(400).type).toBe("error");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test e2e/mock-llm/core/faults.test.ts --coverage=false`
Expected: FAIL, cannot find module `./faults`.

- [ ] **Step 3: Implement**

`e2e/mock-llm/core/faults.ts`:

```ts
import { paramInt, parseDurationMs } from "./tag";
import type { Tag } from "./types";

export type FaultAction = "proxy" | "error" | "drop" | "malformed" | "hang";

export interface FaultPlan {
  action: FaultAction;
  /** Sleep before responding (time to first token). */
  delayMs: number;
  /** Pause between streamed events. */
  intervalMs: number;
  /** HTTP status when action is "error". */
  status: number;
  /** Events to pass through before cutting the stream when action is "drop". */
  dropAfterEvents: number;
}

const NONE: FaultPlan = { action: "proxy", delayMs: 0, intervalMs: 0, status: 0, dropAfterEvents: 0 };

/**
 * Pure: depends only on the tag and the client's retry count (the Anthropic SDK
 * sends it as `x-stainless-retry-count`), never on server state, so a retry
 * landing on a different replica gets the same answer.
 */
export function planFaults(tag: Tag | null, retryCount: number): FaultPlan {
  if (!tag) return NONE;
  const p = tag.params;
  const plan: FaultPlan = {
    ...NONE,
    delayMs: parseDurationMs(p["ttft"], 0),
    intervalMs: parseDurationMs(p["interval"], 0),
  };
  if (p["hang"] === "1") return { ...plan, action: "hang" };
  if (p["overflow"] === "1") return { ...plan, action: "error", status: 400 };
  const failStatus = paramInt(tag, "fail", 0);
  if (failStatus > 0 && retryCount < paramInt(tag, "until-retry", 1)) {
    return { ...plan, action: "error", status: failStatus };
  }
  const drop = paramInt(tag, "drop", 0);
  if (drop > 0) return { ...plan, action: "drop", dropAfterEvents: drop };
  if (p["malformed"] === "1") return { ...plan, action: "malformed" };
  return plan;
}

const TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  429: "rate_limit_error",
  529: "overloaded_error",
};

export function errorBody(status: number): { type: "error"; error: { type: string; message: string } } {
  const type = TYPES[status] ?? "api_error";
  const message = status === 400 ? "prompt is too long: 250000 tokens > 200000 maximum" : `mock ${type}`;
  return { type: "error", error: { type, message } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test e2e/mock-llm --coverage=false && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add e2e/mock-llm/core/faults.ts e2e/mock-llm/core/faults.test.ts
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "feat(e2e): tag-driven, stateless fault planning for the mock LLM"
```

---

### Task 6: The server (aimock plus front handler) and its process-level test

**Files:**
- Create: `e2e/mock-llm/server.ts`
- Create: `e2e/mock-llm/main.ts`
- Test: `e2e/mock-llm/server.test.ts`

**Interfaces:**
- Consumes: `resolveReply` (Task 4), `planFaults`, `errorBody` (Task 5), `lastTagIn` (Task 2), `MockReply`, `MockRequest` (Task 2).
- Produces (`server.ts`): `startServer(port: number): Promise<{ port: number; stop(): Promise<void> }>`. HTTP surface: `GET /healthz`, `GET|DELETE /__mock/journal` (rows `{ ts, method, path, retryCount, tag, action, messages, historyHash }`), `POST /v1/messages/count_tokens`, `/__aimock/*` passthrough, everything else proxied to aimock with the fault plan applied.
- Produces (`main.ts`): entry that starts the server on `PORT` (default 8080) and prints `mock-llm listening on <port>`.

Tool-call ids are deterministic (`toolu_mock_<n>`), so two replicas answer the same request identically.

- [ ] **Step 1: Write the server**

`e2e/mock-llm/server.ts`:

```ts
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LLMock } from "@copilotkit/aimock";
import type { FixtureResponse } from "@copilotkit/aimock";
import { errorBody, planFaults } from "./core/faults";
import type { FaultPlan } from "./core/faults";
import { resolveReply } from "./core/registry";
import { lastTagIn } from "./core/tag";
import type { MockReply, MockRequest } from "./core/types";

interface JournalRow {
  ts: number;
  method: string;
  path: string;
  retryCount: number;
  tag: string | null;
  action: string;
  messages: number;
  historyHash: string;
}

function toFixtureResponse(r: MockReply): FixtureResponse {
  if (r.kind === "tools") {
    return { toolCalls: r.calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.args) })) };
  }
  return r.reasoning ? { content: r.content, reasoning: r.reasoning } : { content: r.content };
}

/** Resolves after ms, or as soon as the client goes away. */
function delay(ms: number, res: http.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      res.off("close", done);
      resolve();
    }
    res.once("close", done);
  });
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Split an upstream byte stream into whole SSE events; a non-SSE body is one event. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      yield buf.slice(0, i + 2);
      buf = buf.slice(i + 2);
    }
  }
  buf += decoder.decode();
  if (buf) yield buf;
}

const HOP_HEADERS = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"]);

function hash(body: string): string {
  let messages: unknown = body;
  try {
    messages = (JSON.parse(body) as { messages?: unknown }).messages ?? body;
  } catch {}
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 16);
}

function messageCount(body: string): number {
  try {
    const m = (JSON.parse(body) as { messages?: unknown }).messages;
    return Array.isArray(m) ? m.length : 0;
  } catch {
    return 0;
  }
}

export async function startServer(port: number): Promise<{ port: number; stop(): Promise<void> }> {
  const mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "warn", chunkSize: 16 });
  mock.on({ predicate: () => true }, (req) => toFixtureResponse(resolveReply(req as unknown as MockRequest)));
  const upstream = await mock.start();
  const journal: JournalRow[] = [];

  async function proxy(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse, plan: FaultPlan): Promise<void> {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !HOP_HEADERS.has(k) && k !== "host") headers.set(k, Array.isArray(v) ? v.join(",") : v);
    }
    const up = await fetch(upstream + (req.url ?? "/"), {
      method: req.method,
      headers,
      body: body.length && req.method !== "GET" ? body : undefined,
    });
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => {
      if (!HOP_HEADERS.has(k)) out[k] = v;
    });
    res.writeHead(up.status, out);
    if (!up.body) {
      res.end();
      return;
    }
    let n = 0;
    for await (const ev of sseEvents(up.body)) {
      if (res.destroyed) return;
      if (plan.action === "drop" && n >= plan.dropAfterEvents) {
        res.destroy();
        return;
      }
      if (plan.intervalMs && n > 0) await delay(plan.intervalMs, res);
      res.write(ev);
      n++;
    }
    res.end();
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (path === "/__mock/journal") {
      if (req.method === "DELETE") journal.length = 0;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(req.method === "DELETE" ? [] : journal));
      return;
    }
    if (path === "/v1/messages/count_tokens") {
      await readBody(req);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const body = await readBody(req);
    if (path.startsWith("/__aimock")) {
      await proxy(req, body, res, planFaults(null, 0));
      return;
    }
    const text = body.toString("utf8");
    const tag = lastTagIn(text);
    const retryCount = Number.parseInt(String(req.headers["x-stainless-retry-count"] ?? "0"), 10) || 0;
    const plan = planFaults(tag, retryCount);
    journal.push({
      ts: Date.now(),
      method: req.method ?? "GET",
      path,
      retryCount,
      tag: tag?.name ?? null,
      action: plan.action,
      messages: messageCount(text),
      historyHash: hash(text),
    });
    if (plan.delayMs) await delay(plan.delayMs, res);
    if (res.destroyed) return;
    switch (plan.action) {
      case "hang":
        await new Promise<void>((resolve) => res.once("close", resolve));
        return;
      case "error":
        res.writeHead(plan.status, { "content-type": "application/json" }).end(JSON.stringify(errorBody(plan.status)));
        return;
      case "malformed":
        res.writeHead(200, { "content-type": "text/event-stream" }).end("event: message_start\ndata: {not json\n\n");
        return;
      default:
        await proxy(req, body, res, plan);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `mock failure: ${String(e)}` } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));

  return {
    port: (server.address() as AddressInfo).port,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mock.stop();
    },
  };
}
```

`e2e/mock-llm/main.ts`:

```ts
import { startServer } from "./server";

const running = await startServer(Number(process.env.PORT ?? 8080));
console.log(`mock-llm listening on ${running.port}`);

const shutdown = () => {
  void running.stop().finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

- [ ] **Step 2: Write the process-level test**

`e2e/mock-llm/server.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let child: ReturnType<typeof Bun.spawn>;
let base = "";

beforeAll(async () => {
  const out = join(mkdtempSync(join(tmpdir(), "mock-llm-")), "main.mjs");
  const built = Bun.spawnSync(["bun", "build", "e2e/mock-llm/main.ts", "--target=node", "--outfile", out]);
  if (built.exitCode !== 0) throw new Error(`bundle failed: ${built.stderr.toString()}`);
  child = Bun.spawn(["node", out], { env: { ...process.env, PORT: "0" }, stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let seen = "";
  while (!/listening on (\d+)/.test(seen)) {
    const { value, done } = await reader.read();
    if (done) throw new Error("mock exited before listening");
    seen += new TextDecoder().decode(value);
  }
  base = `http://127.0.0.1:${/listening on (\d+)/.exec(seen)![1]}`;
}, 60_000);

afterAll(() => {
  child?.kill();
});

const TOOLS = [{ name: "Bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } }];

function post(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-mock", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
}

function request(userText: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: "claude-sonnet-5-5", max_tokens: 256, stream: true, messages: [{ role: "user", content: userText }], ...extra };
}

async function events(res: Response): Promise<Array<{ event: string; data: any }>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const raw = /^data: (.*)$/m.exec(block)?.[1] ?? "";
      let data: unknown = raw;
      try {
        data = JSON.parse(raw);
      } catch {}
      return { event, data };
    });
}

const textOf = (evs: Array<{ data: any }>): string =>
  evs.map((e) => (e.data?.delta?.type === "text_delta" ? e.data.delta.text : "")).join("");

describe("mock-llm server", () => {
  test("healthz and count_tokens", async () => {
    expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok");
    const r = await fetch(`${base}/v1/messages/count_tokens`, { method: "POST", body: "{}" });
    expect((await r.json()) as { input_tokens: number }).toEqual({ input_tokens: 1 });
  });

  test("echo streams the persona-labelled text as Anthropic SSE", async () => {
    const res = await post(request("[[mock:echo]] hello", { system: "Persona-ID: alpha" }));
    expect(res.status).toBe(200);
    const evs = await events(res);
    expect(evs[0]!.event).toBe("message_start");
    expect(textOf(evs)).toBe("[alpha] hello");
    expect(evs.at(-1)!.event).toBe("message_stop");
  });

  test("untagged requests still get a valid reply (CLI side calls)", async () => {
    const res = await post(request("suggest a title"));
    expect(res.status).toBe(200);
    expect(textOf(await events(res))).toBe("mock: untagged request");
  });

  test("tool loop: tool_use first, then the summary once the tool_result is in the history", async () => {
    const first = await events(await post(request("[[mock:multi-tool n=1]] go", { tools: TOOLS })));
    const start = first.find((e) => e.data?.content_block?.type === "tool_use");
    expect(start?.data.content_block.name).toBe("Bash");
    expect(start?.data.content_block.id).toBe("toolu_mock_1");

    const second = await events(
      await post(
        request("x", {
          tools: TOOLS,
          messages: [
            { role: "user", content: "[[mock:multi-tool n=1]] go" },
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_mock_1", name: "Bash", input: { command: "echo step-1" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mock_1", content: "step-1" }] },
          ],
        }),
      ),
    );
    expect(textOf(second)).toBe("done after 1 tools");
  });

  test("the same request gets the same reply every time (stateless)", async () => {
    const a = textOf(await events(await post(request("[[mock:long-stream chunks=6]] go"))));
    const b = textOf(await events(await post(request("[[mock:long-stream chunks=6]] go"))));
    expect(a).toBe(b);
    expect(a.match(/chunk-\d+/g)).toHaveLength(6);
  });

  test("think reasoning arrives as a thinking block, not as answer text", async () => {
    const evs = await events(await post(request("[[mock:think]] q")));
    expect(evs.some((e) => e.data?.content_block?.type === "thinking")).toBe(true);
    expect(textOf(evs)).toBe("thought about it");
  });

  test("fail=529 errors on the first attempt and succeeds when the retry header says so", async () => {
    const body = request("[[mock:echo fail=529]] x");
    const first = await post(body);
    expect(first.status).toBe(529);
    expect(((await first.json()) as { error: { type: string } }).error.type).toBe("overloaded_error");
    const retry = await post(body, { "x-stainless-retry-count": "1" });
    expect(retry.status).toBe(200);
  });

  test("overflow returns a 400 prompt-too-long error", async () => {
    const res = await post(request("[[mock:echo overflow=1]] x"));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("prompt is too long");
  });

  test("malformed returns bad SSE", async () => {
    const res = await post(request("[[mock:echo malformed=1]] x"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("{not json");
  });

  test("drop=2 cuts the stream after two events", async () => {
    const res = await post(request("[[mock:long-stream chunks=30 drop=2]] go"));
    const text = await res.text().catch(() => "");
    expect(text.split("\n\n").filter(Boolean).length).toBeLessThanOrEqual(2);
    expect(text).not.toContain("message_stop");
  });

  test("ttft delays the first byte", async () => {
    const t0 = Date.now();
    await (await post(request("[[mock:echo ttft=300ms]] x"))).text();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
  });

  test("hang never answers, an abort releases it, and the server keeps serving", async () => {
    const ctl = new AbortController();
    const hung = post(request("[[mock:echo hang=1]] x"), {}, ctl.signal).catch((e: Error) => e.name);
    setTimeout(() => ctl.abort(), 200);
    expect(await hung).toBe("AbortError");
    expect((await post(request("[[mock:echo]] still up"))).status).toBe(200);
  });

  test("aborting mid-delay does not break later requests", async () => {
    const ctl = new AbortController();
    const slow = post(request("[[mock:echo ttft=5s]] x"), {}, ctl.signal).catch((e: Error) => e.name);
    setTimeout(() => ctl.abort(), 100);
    expect(await slow).toBe("AbortError");
    expect((await post(request("[[mock:echo]] fine"))).status).toBe(200);
  });

  test("hostile bodies never crash the server", async () => {
    for (const body of ["", "not json", "[[mock:echo]]", "{".repeat(50_000), JSON.stringify({ messages: "nope" })]) {
      const res = await post(body);
      expect(res.status).toBeLessThan(600);
      await res.text().catch(() => "");
    }
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  test("concurrent requests with different tags do not interfere", async () => {
    const texts = await Promise.all(
      ["one", "two", "three", "four"].map(async (w) => textOf(await events(await post(request(`[[mock:echo]] ${w}`))))),
    );
    expect(texts).toEqual(["[unknown] one", "[unknown] two", "[unknown] three", "[unknown] four"]);
  });

  test("the journal records tag, retry count, action and a history hash, and can be cleared", async () => {
    await fetch(`${base}/__mock/journal`, { method: "DELETE" });
    await post(request("[[mock:echo fail=529]] j"));
    await post(request("[[mock:echo fail=529]] j"), { "x-stainless-retry-count": "1" });
    const rows = (await (await fetch(`${base}/__mock/journal`)).json()) as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.tag, r.retryCount, r.action])).toEqual([
      ["echo", 0, "error"],
      ["echo", 1, "proxy"],
    ]);
    expect(rows[0]!.historyHash).toBe(rows[1]!.historyHash);
    expect(rows[0]!.messages).toBe(1);
  });

  test("aimock's own journal is reachable through the passthrough", async () => {
    const res = await fetch(`${base}/__aimock/journal`);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 3: Run the tests and fix mismatches against the real aimock**

Run: `bun test e2e/mock-llm/server.test.ts --coverage=false`
Expected: all PASS. This is the first time the code meets the real library, so expect small mismatches (for example whether `predicate: () => true` also needs `endpoint: "chat"`, whether thinking blocks stream as `content_block.type === "thinking"`, the exact `message_stop` event name). For each failure: read the actual SSE the mock produced (add a temporary `console.log(await res.text())`), correct the **assertion or adapter** to match the real Anthropic wire format, and never weaken a statelessness or fault assertion. Remove temporary logging before committing.

- [ ] **Step 4: Run the whole mock-llm suite with coverage, plus typecheck**

Run: `bun test e2e/mock-llm && bun run typecheck`
Expected: PASS; the coverage table shows every `e2e/mock-llm/core/*.ts` file at or above the thresholds (`server.ts` and `main.ts` do not appear because they only run in the child process). If a `core` line is uncovered, add the missing test rather than lowering anything.

- [ ] **Step 5: Commit**

```bash
git add e2e/mock-llm/server.ts e2e/mock-llm/main.ts e2e/mock-llm/server.test.ts
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "feat(e2e): mock LLM server on aimock with a fault-injecting front handler"
```

The dummy key `sk-mock` in the test is under the 20-character pattern and is not flagged; if the scan does flag anything, replace it with a shorter placeholder.

---

### Task 7: Image, build script, and a real-CLI check against the finished server

**Files:**
- Create: `e2e/mock-llm/Dockerfile`
- Create: `scripts/build-mock-llm.sh`
- Create: `e2e/mock-llm/README.md`

**Interfaces:**
- Consumes: `main.ts` (Task 6).
- Produces: image `slaude-mock-llm:dev` serving on port 8080, and the documented tag grammar that Plans 2 and 3 use.

- [ ] **Step 1: Write the Dockerfile**

`e2e/mock-llm/Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY main.mjs ./
ENV PORT=8080
EXPOSE 8080
USER node
HEALTHCHECK --interval=5s --timeout=2s --retries=10 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "main.mjs"]
```

- [ ] **Step 2: Write the build script**

`scripts/build-mock-llm.sh`:

```bash
#!/usr/bin/env bash
# Bundle the mock LLM into one Node file and build its image.
#   scripts/build-mock-llm.sh            -> image slaude-mock-llm:dev
#   IMAGE=name:tag scripts/build-mock-llm.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-slaude-mock-llm:dev}"
OUT="$ROOT/dist/mock-llm"

mkdir -p "$OUT"
bun build "$ROOT/e2e/mock-llm/main.ts" --target=node --outfile "$OUT/main.mjs"
cp "$ROOT/e2e/mock-llm/Dockerfile" "$OUT/Dockerfile"
docker build -t "$IMAGE" "$OUT"
echo "built $IMAGE"
```

Run: `chmod +x scripts/build-mock-llm.sh`

- [ ] **Step 3: Build and smoke-test the image**

Run:
```bash
scripts/build-mock-llm.sh
docker run -d --rm --name mock-llm-smoke -p 18080:8080 slaude-mock-llm:dev
sleep 2
curl -s localhost:18080/healthz
curl -s -X POST localhost:18080/v1/messages -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"m","max_tokens":64,"stream":false,"messages":[{"role":"user","content":"[[mock:echo]] hi"}]}'
docker rm -f mock-llm-smoke
```
Expected: `ok`, then a JSON message whose text is `[unknown] hi`.

- [ ] **Step 4: Repeat the spike's real-CLI run against the finished server**

Run the container again (`docker run -d --rm --name mock-llm-smoke -p 18080:8080 slaude-mock-llm:dev`), then:

```bash
H="$(mktemp -d)"
cd "$H" && HOME="$H" CLAUDE_CONFIG_DIR="$H/.claude" ANTHROPIC_BASE_URL=http://127.0.0.1:18080 ANTHROPIC_API_KEY=sk-mock \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 \
  claude -p "[[mock:multi-tool n=2]] run two commands" --output-format json --allowedTools Bash --max-turns 6 --model claude-sonnet-5-5
curl -s localhost:18080/__mock/journal
docker rm -f mock-llm-smoke
```
Expected: the CLI exits 0 with the result `done after 2 tools`, and the journal shows the tagged requests plus any untagged side calls, each with `action: "proxy"`. If the CLI fails on a side call the spike did not surface, fix it in `server.ts` with a test in `server.test.ts` first.

- [ ] **Step 5: Write the README**

`e2e/mock-llm/README.md`:

```markdown
# mock-llm

A stateless, Anthropic-compatible mock LLM for slaude's end-to-end tests. It is
built on aimock; every reply is a pure function of the request, so a turn that
is killed and re-delivered to another replica gets the same answer.

## Run

    scripts/build-mock-llm.sh            # image slaude-mock-llm:dev
    docker run --rm -p 8080:8080 slaude-mock-llm:dev

Point a client at it with `ANTHROPIC_BASE_URL=http://127.0.0.1:8080` and any key.

## Choosing a scenario

Put a tag in the user message: `[[mock:<name> key=value ...]]`. The most recent
user message that carries a tag decides the turn. Requests with no tag get
`mock: untagged request`.

| Scenario | Params | Reply |
|---|---|---|
| `echo` | | `[<persona>] <user text>`; persona is the `Persona-ID:` line in the system prompt |
| `multi-tool` | `n` (default 2), `tool` (default Bash) | `n` sequential tool calls, then `done after n tools` |
| `long-stream` | `chunks` (default 20) | Many small chunks |
| `think` | | A thinking block, then `thought about it` |

## Faults (work with any scenario)

| Param | Effect |
|---|---|
| `ttft=<dur>` | Delay before the first byte (`500ms`, `2s`) |
| `interval=<dur>` | Pause between streamed events |
| `fail=<status>` `until-retry=<n>` | Error while the client's retry count is below `n` (default 1) |
| `drop=<k>` | Cut the stream after `k` events |
| `malformed=1` | Bad SSE |
| `hang=1` | Never answer |
| `overflow=1` | 400 prompt-too-long |

Precedence: hang, overflow, fail, drop, malformed.

## Inspecting

`GET /__mock/journal` lists every request (tag, retry count, action, message
count, history hash); `DELETE` clears it. aimock's own journal is at
`/__aimock/journal`.
```

- [ ] **Step 6: Run the full verification**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; the whole suite passes with coverage thresholds met. The one unidentified failure seen in a baseline run before this work is a known flake; if it appears, re-run once and note it, do not chase it here.

- [ ] **Step 7: Commit**

```bash
git add e2e/mock-llm/Dockerfile e2e/mock-llm/README.md scripts/build-mock-llm.sh
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "feat(e2e): package the mock LLM as a container image with docs"
```

---

## Self-review notes (already applied)

- **Spec coverage.** Spec section 1 (aimock base, statelessness rule, spike, shape) is Tasks 1 to 7. The scenario rows `echo`, `multi-tool`, `long-stream`, `think` and every fault (`fail`/`until-retry`, `drop`, `malformed`, `hang`, `ttft`, `overflow`) are covered. The catalogue rows that need the cluster or Slack (`approval`, `surface-tools`, `cron-*`, `kb-*`, `skill-*`, `resume`, `connect-mcp`) and multi-persona journal checks belong to Plan 3, because they need Plan 2's harness.
- **Deliberate deviations from the spec, to fold back into it:** (1) the current turn's tag is the most recent tagged user message, not the first, so resumed threads work; (2) faults are orthogonal tag parameters instead of separate scenario names, so any scenario combines with any fault; (3) faults are applied by a front handler because aimock's `predicate` and `ResponseFactory` cannot see HTTP headers; (4) the persona is read from a `Persona-ID:` line in the system prompt.
- **Placeholder scan.** No TBD or vague steps. Task 1's findings note and Task 6 Step 3 are discovery steps with explicit acceptance criteria and an instruction for what to do on mismatch.
- **Type consistency.** `MockReply`, `ToolCallSpec` (`id`, `name`, `args`), `HistoryView`, `FaultPlan` field names (`dropAfterEvents`, `intervalMs`, `delayMs`, `status`) match across Tasks 2 to 6.
