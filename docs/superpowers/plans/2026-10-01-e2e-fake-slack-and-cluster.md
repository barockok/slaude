# Fake Slack and Cluster Harness (Plan 2 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fake Slack server that plays Slack's side of the wire for the HA suite, a tiny gateway seam that lets slaude talk to it, and a cluster harness that runs one real round trip (message in, mock-LLM turn, reply out) on the scale topology with no Slack credentials.

**Architecture:** `e2e/fake-slack/` is an out-of-process HTTP service: an in-memory Slack workspace behind a Web API subset (`/api/<method>`), an inbound sender that delivers correctly signed events and interactions to a chosen gateway with Slack's retry behaviour, and a control API for the test driver. A one-env-var seam (`SLAUDE_SLACK_API_URL`) points the gateway's Slack clients at it. The fake is proven first in-process against the real gateway and HTTP transport (no cluster), then packaged next to the mock LLM and deployed on `deploy/k8s-local` through a kustomize overlay.

**Tech Stack:** Bun + TypeScript (`bun test`), `node:http` (bundled with `bun build --target=node`, like the mock LLM), `@slack/web-api` (already a dependency; used in tests as the real client), minikube + kubectl for Part B.

**Spec:** `docs/superpowers/specs/2026-09-30-e2e-mock-llm-design.md` (section 2 "Cluster and fake-Slack harness", section 3 "Slack-side faults", and rollout steps 3 and 4). Plan 1 (`docs/superpowers/plans/2026-09-30-e2e-mock-llm-server.md`) built the mock LLM this plan deploys.

## Global Constraints

- Bun + TypeScript; tests are `*.test.ts` picked up by root `bun test`. Cluster tests are named `*.e2e.ts` so root `bun test` does not discover them; they run only when named explicitly.
- Root `bunfig.toml` coverage thresholds: line 0.97, function 0.80, statement 0.97, measured over the whole run. Everything under `e2e/fake-slack/` is loaded in-process by tests and must be thoroughly covered; add the missing test rather than lowering anything.
- Root `tsc --noEmit` must stay clean (`bun run typecheck`). Scripts that run inside a pod and import `/app/src/...` paths belong in a directory added to the `tsconfig.json` `exclude` list, like `deploy/k8s-local/probe`.
- The only production-code change is the `SLAUDE_SLACK_API_URL` seam (Task 1). It is off by default and must not change behaviour when unset.
- Slack wire facts to honour exactly: Web API calls are `POST <base>/api/<method>`, form-encoded or JSON, `Authorization: Bearer <bot token>`, response is HTTP 200 JSON `{ok: true, ...}` or `{ok: false, error}` (rate limits are HTTP 429 with `Retry-After`); events are `POST /slack/events` with `X-Slack-Request-Timestamp` and `X-Slack-Signature` (v0 HMAC over `v0:<ts>:<raw body>`), interactions are `POST /slack/interactions` with a form body `payload=<json>`. Signing reuses `signSlackRequest` from `src/gateway/slack/verify.ts`; never reimplement it.
- An unknown Web API method must answer `{ok: false, error: "unknown_method"}` and be recorded in the call log with `unknown: true`. It must never answer `ok: true`.
- Reply content from the mock LLM and fault attempt counting follow Plan 1 (single mock replica; unique prompts per case and per persona).
- Public repo: no real names, org names, workspace or channel identifiers, or internal service names anywhere. Use placeholders such as `T0FAKE`, `A0FAKE`, `U0MGR`, `U0BOT`, `C0TEAM`, `D0MGR`. Generated tokens are random per run and never committed.
- Commits: granular, one logical change each, conventional style, **no `Co-Authored-By` or "Generated with" trailers**. Before every `git add`, run the pre-commit leak scan from `CLAUDE.md`:
  `git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names'`
  Hits on the scan command's own text in docs are expected; any other hit is replaced with a placeholder. The fake's default bot tokens are intentionally fake and random per run: build them from parts in code (a Slack bot-token prefix, then a fake marker, then a random suffix) rather than writing a literal, so the scan stays silent.
- Stage explicit paths only (`.superpowers/` is not gitignored). Never commit anything under `dist/`.
- Amendment (after the Plan 1 spike): the mock LLM counts fault attempts per process, so the cluster overlay runs it with exactly one replica.
- Work happens in the worktree `/Users/barock/Code/slaude/.claude/worktrees/e2e-test-with-mock-llm` (or a fresh worktree off the merged Plan 1 branch).

## Review Focus

Failure modes the spec implies but happy-path tests would miss, most likely first:

1. **A new Slack method is silently accepted.** slaude calls methods beyond the spec's list (the existing transport test also fakes `assistant.threads.setStatus` and `users.profile.set`). The fake must reject unknown methods loudly, and the in-process gateway test (Task 6) must surface every method the gateway really uses at boot and per turn. Owned by Tasks 3 and 6.
2. **Signature breakage from re-serialization.** The signature covers the raw bytes. Signing one string and sending another (or re-stringifying the envelope) yields a 401. A stale timestamp (older than 5 minutes) is also rejected, so every retry must re-sign with a fresh timestamp. Owned by Task 4.
3. **Same message delivered twice, or retried.** A duplicate `event_id`, the same message `ts` under a new `event_id`, and a retry carrying `X-Slack-Retry-Num` must each produce exactly one reply. Owned by Task 6 (gateway dedup is `seen_events` by channel and ts).
4. **`response_url` unreachable from the gateway.** Button clicks make the gateway POST to the interaction's `response_url`. In the cluster that URL must be the fake's in-cluster address, not `127.0.0.1`. Owned by Tasks 5 and 8.
5. **State leaking between cases.** Channels, threads and call-log rows from one case must not satisfy another case's assertions. Cases use unique channels, and the control API can clear the call log and faults. Owned by Tasks 5 and 10.

---

## Part A: the seam and the fake Slack (locally testable, no cluster)

### Task 1: `SLAUDE_SLACK_API_URL` seam

**Files:**
- Modify: `src/config/env.ts` (add `slack.apiUrl`)
- Modify: `src/gateway/slack/http-transport.ts:80-90` (default `makeClient`)
- Modify: `src/persona/registry.ts:55` (user-token `WebClient`)
- Test: `tests/config.test.ts` (append), `tests/gateway/slack/slack-api-url.test.ts` (create)

**Interfaces:**
- Produces: `env.slack.apiUrl(): string | undefined` — the normalized Slack Web API base (always ends with `/`), or `undefined` when `SLAUDE_SLACK_API_URL` is unset or blank. Consumed by Task 6 and by the cluster overlay (Task 8).

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts`, next to the `slack.httpMaxBodyBytes` test (reuse that file's existing import of `env` and its env save/restore style):

```ts
  test("slack.apiUrl is unset by default and normalises a trailing slash", () => {
    const prev = process.env.SLAUDE_SLACK_API_URL;
    try {
      delete process.env.SLAUDE_SLACK_API_URL;
      expect(env.slack.apiUrl()).toBeUndefined();
      process.env.SLAUDE_SLACK_API_URL = "   ";
      expect(env.slack.apiUrl()).toBeUndefined();
      process.env.SLAUDE_SLACK_API_URL = "http://fake-slack:8080/api";
      expect(env.slack.apiUrl()).toBe("http://fake-slack:8080/api/");
      process.env.SLAUDE_SLACK_API_URL = "http://fake-slack:8080/api/";
      expect(env.slack.apiUrl()).toBe("http://fake-slack:8080/api/");
    } finally {
      if (prev === undefined) delete process.env.SLAUDE_SLACK_API_URL;
      else process.env.SLAUDE_SLACK_API_URL = prev;
    }
  });
```

Create `tests/gateway/slack/slack-api-url.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { __resetMasterKeyCache, encrypt } from "../../../src/db/crypto";
import { createHttpSlackTransport } from "../../../src/gateway/slack/http-transport";
import type { SlackAppRow } from "../../../src/db/slack-apps";

let prevKey: string | undefined;
let prevUrl: string | undefined;
const stops: Array<() => Promise<void> | void> = [];

beforeAll(() => {
  prevKey = process.env.SLAUDE_MASTER_KEY;
  prevUrl = process.env.SLAUDE_SLACK_API_URL;
  process.env.SLAUDE_MASTER_KEY = randomBytes(32).toString("base64");
  __resetMasterKeyCache();
});

afterAll(() => {
  if (prevKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
  else process.env.SLAUDE_MASTER_KEY = prevKey;
  if (prevUrl === undefined) delete process.env.SLAUDE_SLACK_API_URL;
  else process.env.SLAUDE_SLACK_API_URL = prevUrl;
  __resetMasterKeyCache();
});

afterEach(async () => {
  while (stops.length) await stops.pop()!();
});

function row(): SlackAppRow {
  return {
    api_app_id: "A0SEAM",
    team_id: "T0SEAM",
    tenant_id: "default",
    persona_id: "default",
    bot_token: encrypt("bot-token-seam"),
    signing_secret: encrypt("signing-secret-seam"),
    bot_user_id: "U0BOT",
    created_at: 1,
    updated_at: 1,
  };
}

test("with SLAUDE_SLACK_API_URL set, the transport's default client calls that base URL", async () => {
  const seen: Array<{ path: string; auth: string | null }> = [];
  const stub = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
      return Response.json({ ok: true, user_id: "U0BOT", team_id: "T0SEAM" });
    },
  });
  stops.push(() => stub.stop(true));
  process.env.SLAUDE_SLACK_API_URL = `http://127.0.0.1:${stub.port}/api`;

  const t = createHttpSlackTransport({ port: 0, loadApps: async () => [row()], log: () => {} });
  await t.start();
  stops.push(() => t.stop());

  const res = await t.client.auth.test();
  expect(res.ok).toBe(true);
  expect(seen).toEqual([{ path: "/api/auth.test", auth: "Bearer bot-token-seam" }]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/config.test.ts tests/gateway/slack/slack-api-url.test.ts --coverage=false`
Expected: FAIL (`env.slack.apiUrl is not a function`; the transport test never reaches the stub).

- [ ] **Step 3: Implement the accessor**

In `src/config/env.ts`, inside the `slack:` object next to `httpMaxBodyBytes`:

```ts
    /**
     * Override for the Slack Web API base URL. Unset (the default) means the
     * SDK's own https://slack.com/api/. Used by the end-to-end suite to point the
     * gateway at a fake Slack; production never sets it. Normalised to end in "/"
     * because the SDK appends the method name directly.
     */
    apiUrl: (): string | undefined => {
      const raw = opt("SLAUDE_SLACK_API_URL", "").trim();
      if (!raw) return undefined;
      return raw.endsWith("/") ? raw : `${raw}/`;
    },
```

- [ ] **Step 4: Use it in both client constructors**

`src/gateway/slack/http-transport.ts`, in the default `makeClient`:

```ts
      const { WebClient } = require("@slack/web-api") as typeof import("@slack/web-api");
      const slackApiUrl = env.slack.apiUrl();
      return new WebClient(botToken, slackApiUrl ? { slackApiUrl } : undefined) as unknown as WebClientLike;
```

`src/persona/registry.ts` (add `import { env } from "../config/env";` if absent):

```ts
    const slackApiUrl = env.slack.apiUrl();
    const outClient = config.userToken
      ? new WebClient(config.userToken, slackApiUrl ? { slackApiUrl } : undefined)
      : null;
```

- [ ] **Step 5: Cover the persona path**

Find the existing persona registry test (`ls tests | grep -i persona`) and add a case, in its own style, that loads a persona whose `config.json` has a `userToken` with `SLAUDE_SLACK_API_URL` set, and asserts `(persona.outClient as any).slackApiUrl` equals the normalized URL; and one with it unset asserting the SDK default (`https://slack.com/api/`). Restore the env var in a `finally`.

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test tests/config.test.ts tests/gateway/slack tests/persona --coverage=false` (adjust the persona path to what exists) and `bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/config/env.ts src/gateway/slack/http-transport.ts src/persona/registry.ts tests/config.test.ts tests/gateway/slack/slack-api-url.test.ts <the persona test file>
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "feat(gateway): SLAUDE_SLACK_API_URL to point Slack clients at a fake in tests"
```

---

### Task 2: Fake workspace state, clock and call log

**Files:**
- Create: `e2e/fake-slack/core/clock.ts`
- Create: `e2e/fake-slack/core/workspace.ts`
- Create: `e2e/fake-slack/core/call-log.ts`
- Test: `e2e/fake-slack/core/clock.test.ts`, `e2e/fake-slack/core/workspace.test.ts`, `e2e/fake-slack/core/call-log.test.ts`

**Interfaces:**
- Produces (`clock.ts`): `class TsClock { constructor(now?: () => number); next(): string }` — strictly increasing Slack-style timestamps `"<seconds>.<6 digits>"`, never going backwards if the clock does.
- Produces (`workspace.ts`): `class SlackError extends Error { code: string }`; interfaces `FakeUser {id, name, isBot}`, `FakeChannel {id, name, isIm, members: Set<string>, topic, purpose}`, `FakeApp {apiAppId, name, botUserId, botToken, signingSecret}`, `FakeMessage {ts, channel, user, text, blocks?, threadTs?, appId?, deleted, edited, pinned, reactions: Map<string, Set<string>>}`; `class Workspace` with `readonly teamId`, `readonly users`, `readonly channels`, `readonly apps`, and methods `addUser(id, name, isBot?)`, `addApp({apiAppId, name, botUserId?, botToken?, signingSecret?})`, `addChannel({id, name, isIm?, members?})`, `appByToken(token)`, `post({channel, user, text, blocks?, threadTs?, appId?})`, `update(channel, ts, {text?, blocks?})`, `remove(channel, ts)`, `message(channel, ts)`, `messages(channel)`, `replies(channel, ts)`, `react(channel, ts, name, user)`, `unreact(channel, ts, name, user)`, `pin(channel, ts)`, `unpin(channel, ts)`, `setTopic(channel, text)`, `setPurpose(channel, text)`, `members(channel)`, `search(query)`, `postEphemeral(channel, user, text)`, `ephemerals()`.
- Produces (`call-log.ts`): `interface CallRecord {seq, at, kind: "api" | "inbound" | "response_url", method, app?, ok, error?, status, args?, unknown?, detail?}`; `class CallLog { add(r, at?): CallRecord; all(): CallRecord[]; where(pred): CallRecord[]; count(method): number; clear(): void }`; `redactArgs(args: Record<string, unknown>): Record<string, unknown>` (removes the `token` key).

- [ ] **Step 1: Write the failing tests**

`e2e/fake-slack/core/clock.test.ts`:

```ts
import { expect, test } from "bun:test";
import { TsClock } from "./clock";

test("timestamps have Slack's shape and strictly increase within one second", () => {
  const c = new TsClock(() => 1_700_000_000_500);
  const a = c.next();
  const b = c.next();
  expect(a).toMatch(/^\d+\.\d{6}$/);
  expect(a).toBe("1700000000.000001");
  expect(b).toBe("1700000000.000002");
});

test("follows the clock forward and resets the sequence", () => {
  let now = 1_700_000_000_000;
  const c = new TsClock(() => now);
  c.next();
  now += 5_000;
  expect(c.next()).toBe("1700000005.000001");
});

test("never goes backwards when the clock does", () => {
  let now = 1_700_000_010_000;
  const c = new TsClock(() => now);
  const a = c.next();
  now -= 60_000;
  const b = c.next();
  expect(Number(b)).toBeGreaterThan(Number(a));
});
```

`e2e/fake-slack/core/call-log.test.ts`:

```ts
import { expect, test } from "bun:test";
import { CallLog, redactArgs } from "./call-log";

test("assigns increasing seq numbers and supports filtering and counting", () => {
  const log = new CallLog();
  log.add({ kind: "api", method: "chat.postMessage", ok: true, status: 200 }, 10);
  log.add({ kind: "api", method: "auth.test", ok: true, status: 200 }, 11);
  log.add({ kind: "api", method: "chat.postMessage", ok: false, error: "channel_not_found", status: 200 }, 12);
  expect(log.all().map((r) => r.seq)).toEqual([1, 2, 3]);
  expect(log.count("chat.postMessage")).toBe(2);
  expect(log.where((r) => !r.ok)).toHaveLength(1);
  expect(log.all()[0]!.at).toBe(10);
});

test("clear empties the log but keeps numbering monotonic", () => {
  const log = new CallLog();
  log.add({ kind: "api", method: "a", ok: true, status: 200 });
  log.clear();
  expect(log.all()).toEqual([]);
  expect(log.add({ kind: "api", method: "b", ok: true, status: 200 }).seq).toBe(2);
});

test("redactArgs drops the token", () => {
  expect(redactArgs({ token: "t", channel: "C1", text: "hi" })).toEqual({ channel: "C1", text: "hi" });
});
```

`e2e/fake-slack/core/workspace.test.ts`:

```ts
import { beforeEach, expect, test } from "bun:test";
import { SlackError, Workspace } from "./workspace";

let ws: Workspace;
beforeEach(() => {
  ws = new Workspace("T0FAKE");
  ws.addUser("U0MGR", "manager");
  ws.addApp({ apiAppId: "A0FAKE", name: "agent", botUserId: "U0BOT" });
  ws.addChannel({ id: "C0TEAM", name: "team", members: ["U0MGR", "U0BOT"] });
  ws.addChannel({ id: "D0MGR", name: "dm", isIm: true, members: ["U0MGR", "U0BOT"] });
});

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof SlackError ? e.code : String(e);
  }
  return "no-error";
};

test("addApp creates a bot user, a unique token and a signing secret", () => {
  const app = ws.apps.get("A0FAKE")!;
  expect(app.botUserId).toBe("U0BOT");
  expect(ws.users.get("U0BOT")!.isBot).toBe(true);
  expect(app.botToken.length).toBeGreaterThan(10);
  expect(app.signingSecret.length).toBeGreaterThanOrEqual(16);
  const other = ws.addApp({ apiAppId: "A0OTHER", name: "other" });
  expect(other.botToken).not.toBe(app.botToken);
  expect(other.botUserId).not.toBe("U0BOT");
  expect(ws.appByToken(app.botToken)).toBe(app);
  expect(ws.appByToken("nope")).toBeUndefined();
});

test("post creates messages with increasing ts; replies attach to a thread root", () => {
  const root = ws.post({ channel: "C0TEAM", user: "U0MGR", text: "hello" });
  const reply = ws.post({ channel: "C0TEAM", user: "U0BOT", text: "hi", threadTs: root.ts, appId: "A0FAKE" });
  expect(Number(reply.ts)).toBeGreaterThan(Number(root.ts));
  expect(reply.threadTs).toBe(root.ts);
  expect(ws.replies("C0TEAM", root.ts).map((m) => m.text)).toEqual(["hello", "hi"]);
});

test("replies of a message without a thread is just the message", () => {
  const root = ws.post({ channel: "C0TEAM", user: "U0MGR", text: "alone" });
  expect(ws.replies("C0TEAM", root.ts)).toHaveLength(1);
});

test("unknown channel and unknown thread are Slack errors", () => {
  expect(code(() => ws.post({ channel: "C0NOPE", user: "U0MGR", text: "x" }))).toBe("channel_not_found");
  expect(code(() => ws.post({ channel: "C0TEAM", user: "U0MGR", text: "x", threadTs: "1.000001" }))).toBe("thread_not_found");
  expect(code(() => ws.replies("C0TEAM", "1.000001"))).toBe("thread_not_found");
});

test("update edits text, remove hides the message from threads", () => {
  const root = ws.post({ channel: "C0TEAM", user: "U0BOT", text: "v1", appId: "A0FAKE" });
  const reply = ws.post({ channel: "C0TEAM", user: "U0BOT", text: "r", threadTs: root.ts });
  expect(ws.update("C0TEAM", root.ts, { text: "v2" }).edited).toBe(true);
  expect(ws.message("C0TEAM", root.ts)!.text).toBe("v2");
  ws.remove("C0TEAM", reply.ts);
  expect(ws.replies("C0TEAM", root.ts)).toHaveLength(1);
  expect(code(() => ws.update("C0TEAM", reply.ts, { text: "x" }))).toBe("message_not_found");
  expect(code(() => ws.remove("C0TEAM", "9.000001"))).toBe("message_not_found");
});

test("reactions: add once, remove once", () => {
  const m = ws.post({ channel: "C0TEAM", user: "U0MGR", text: "react to me" });
  ws.react("C0TEAM", m.ts, "eyes", "U0BOT");
  expect(code(() => ws.react("C0TEAM", m.ts, "eyes", "U0BOT"))).toBe("already_reacted");
  expect([...ws.message("C0TEAM", m.ts)!.reactions.get("eyes")!]).toEqual(["U0BOT"]);
  ws.unreact("C0TEAM", m.ts, "eyes", "U0BOT");
  expect(code(() => ws.unreact("C0TEAM", m.ts, "eyes", "U0BOT"))).toBe("no_reaction");
  expect(code(() => ws.react("C0TEAM", "9.000001", "eyes", "U0BOT"))).toBe("message_not_found");
});

test("pins: pin once, unpin once", () => {
  const m = ws.post({ channel: "C0TEAM", user: "U0MGR", text: "pin me" });
  ws.pin("C0TEAM", m.ts);
  expect(code(() => ws.pin("C0TEAM", m.ts))).toBe("already_pinned");
  ws.unpin("C0TEAM", m.ts);
  expect(code(() => ws.unpin("C0TEAM", m.ts))).toBe("not_pinned");
});

test("topic, purpose, members, search and ephemerals", () => {
  ws.setTopic("C0TEAM", "the topic");
  ws.setPurpose("C0TEAM", "the purpose");
  expect(ws.channels.get("C0TEAM")!.topic).toBe("the topic");
  expect(ws.channels.get("C0TEAM")!.purpose).toBe("the purpose");
  expect(ws.members("C0TEAM")).toEqual(["U0MGR", "U0BOT"]);
  expect(code(() => ws.members("C0NOPE"))).toBe("channel_not_found");
  ws.post({ channel: "C0TEAM", user: "U0MGR", text: "Deploy the Thing" });
  expect(ws.search("deploy the").map((m) => m.text)).toEqual(["Deploy the Thing"]);
  const ts = ws.postEphemeral("C0TEAM", "U0MGR", "only you");
  expect(ws.ephemerals()).toEqual([{ channel: "C0TEAM", user: "U0MGR", text: "only you", ts }]);
});

test("messages(channel) returns post order including replies", () => {
  const a = ws.post({ channel: "D0MGR", user: "U0MGR", text: "one" });
  ws.post({ channel: "D0MGR", user: "U0BOT", text: "two", threadTs: a.ts });
  expect(ws.messages("D0MGR").map((m) => m.text)).toEqual(["one", "two"]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test e2e/fake-slack/core --coverage=false`
Expected: FAIL (modules do not exist).

- [ ] **Step 3: Implement**

`e2e/fake-slack/core/clock.ts`:

```ts
/** Strictly increasing Slack-style message timestamps: "<seconds>.<6 digits>". */
export class TsClock {
  #sec = 0;
  #seq = 0;
  constructor(private readonly now: () => number = Date.now) {}

  next(): string {
    const sec = Math.max(this.#sec, Math.floor(this.now() / 1000));
    this.#seq = sec === this.#sec ? this.#seq + 1 : 1;
    this.#sec = sec;
    return `${sec}.${String(this.#seq).padStart(6, "0")}`;
  }
}
```

`e2e/fake-slack/core/call-log.ts`:

```ts
export interface CallRecord {
  seq: number;
  at: number;
  kind: "api" | "inbound" | "response_url";
  method: string;
  app?: string;
  ok: boolean;
  error?: string;
  status: number;
  args?: Record<string, unknown>;
  /** Set when the method is not one the fake implements. */
  unknown?: boolean;
  detail?: Record<string, unknown>;
}

export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { token: _token, ...rest } = args;
  return rest;
}

/** Ordered record of everything that crossed the fake's wire. Tests assert on it. */
export class CallLog {
  #rows: CallRecord[] = [];
  #seq = 0;

  add(r: Omit<CallRecord, "seq" | "at">, at: number = Date.now()): CallRecord {
    const row: CallRecord = { ...r, seq: ++this.#seq, at };
    this.#rows.push(row);
    return row;
  }

  all(): CallRecord[] {
    return [...this.#rows];
  }

  where(pred: (r: CallRecord) => boolean): CallRecord[] {
    return this.#rows.filter(pred);
  }

  count(method: string): number {
    return this.#rows.filter((r) => r.method === method).length;
  }

  clear(): void {
    this.#rows = [];
  }
}
```

`e2e/fake-slack/core/workspace.ts`:

```ts
import { randomBytes } from "node:crypto";
import { TsClock } from "./clock";

export class SlackError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export interface FakeUser {
  id: string;
  name: string;
  isBot: boolean;
}
export interface FakeChannel {
  id: string;
  name: string;
  isIm: boolean;
  members: Set<string>;
  topic: string;
  purpose: string;
}
export interface FakeApp {
  apiAppId: string;
  name: string;
  botUserId: string;
  botToken: string;
  signingSecret: string;
}
export interface FakeMessage {
  ts: string;
  channel: string;
  user: string;
  text: string;
  blocks?: unknown;
  threadTs?: string;
  appId?: string;
  deleted: boolean;
  edited: boolean;
  pinned: boolean;
  reactions: Map<string, Set<string>>;
}

/** An in-memory Slack workspace: users, apps, channels, messages, threads. */
export class Workspace {
  readonly users = new Map<string, FakeUser>();
  readonly channels = new Map<string, FakeChannel>();
  readonly apps = new Map<string, FakeApp>();
  readonly #messages = new Map<string, FakeMessage[]>();
  readonly #ephemerals: Array<{ channel: string; user: string; text: string; ts: string }> = [];
  readonly clock: TsClock;
  #botCount = 0;

  constructor(readonly teamId = "T0FAKE", clock: TsClock = new TsClock()) {
    this.clock = clock;
  }

  addUser(id: string, name: string, isBot = false): FakeUser {
    const u = { id, name, isBot };
    this.users.set(id, u);
    return u;
  }

  addApp(a: { apiAppId: string; name: string; botUserId?: string; botToken?: string; signingSecret?: string }): FakeApp {
    const botUserId = a.botUserId ?? `U0B${String(++this.#botCount).padStart(4, "0")}`;
    const app: FakeApp = {
      apiAppId: a.apiAppId,
      name: a.name,
      botUserId,
      // Built from parts so no literal token shape appears in source.
      botToken: a.botToken ?? `${"xoxb"}-fake-${randomBytes(12).toString("hex")}`,
      signingSecret: a.signingSecret ?? randomBytes(16).toString("hex"),
    };
    this.apps.set(app.apiAppId, app);
    this.addUser(botUserId, a.name, true);
    return app;
  }

  addChannel(c: { id: string; name: string; isIm?: boolean; members?: string[] }): FakeChannel {
    const ch: FakeChannel = {
      id: c.id,
      name: c.name,
      isIm: c.isIm ?? false,
      members: new Set(c.members ?? []),
      topic: "",
      purpose: "",
    };
    this.channels.set(ch.id, ch);
    this.#messages.set(ch.id, []);
    return ch;
  }

  appByToken(token: string): FakeApp | undefined {
    for (const app of this.apps.values()) if (app.botToken === token) return app;
    return undefined;
  }

  #channel(id: string): FakeChannel {
    const ch = this.channels.get(id);
    if (!ch) throw new SlackError("channel_not_found");
    return ch;
  }

  #find(channel: string, ts: string): FakeMessage {
    this.#channel(channel);
    const m = this.#messages.get(channel)!.find((x) => x.ts === ts && !x.deleted);
    if (!m) throw new SlackError("message_not_found");
    return m;
  }

  post(i: { channel: string; user: string; text: string; blocks?: unknown; threadTs?: string; appId?: string }): FakeMessage {
    this.#channel(i.channel);
    if (i.threadTs) {
      const parent = this.#messages.get(i.channel)!.find((x) => x.ts === i.threadTs && !x.deleted && !x.threadTs);
      if (!parent) throw new SlackError("thread_not_found");
    }
    const m: FakeMessage = {
      ts: this.clock.next(),
      channel: i.channel,
      user: i.user,
      text: i.text,
      blocks: i.blocks,
      threadTs: i.threadTs,
      appId: i.appId,
      deleted: false,
      edited: false,
      pinned: false,
      reactions: new Map(),
    };
    this.#messages.get(i.channel)!.push(m);
    return m;
  }

  update(channel: string, ts: string, patch: { text?: string; blocks?: unknown }): FakeMessage {
    const m = this.#find(channel, ts);
    if (patch.text !== undefined) m.text = patch.text;
    if (patch.blocks !== undefined) m.blocks = patch.blocks;
    m.edited = true;
    return m;
  }

  remove(channel: string, ts: string): void {
    this.#find(channel, ts).deleted = true;
  }

  message(channel: string, ts: string): FakeMessage | undefined {
    return this.#messages.get(channel)?.find((x) => x.ts === ts && !x.deleted);
  }

  /** Every live message in post order, replies included. */
  messages(channel: string): FakeMessage[] {
    this.#channel(channel);
    return this.#messages.get(channel)!.filter((m) => !m.deleted);
  }

  /** The root message followed by its replies in ts order (just the root if unthreaded). */
  replies(channel: string, ts: string): FakeMessage[] {
    const root = this.#messages.get(this.#channel(channel).id)!.find((x) => x.ts === ts && !x.deleted);
    if (!root) throw new SlackError("thread_not_found");
    const replies = this.#messages.get(channel)!.filter((x) => x.threadTs === ts && !x.deleted);
    return [root, ...replies];
  }

  react(channel: string, ts: string, name: string, user: string): void {
    const m = this.#find(channel, ts);
    const set = m.reactions.get(name) ?? new Set<string>();
    if (set.has(user)) throw new SlackError("already_reacted");
    set.add(user);
    m.reactions.set(name, set);
  }

  unreact(channel: string, ts: string, name: string, user: string): void {
    const m = this.#find(channel, ts);
    const set = m.reactions.get(name);
    if (!set?.delete(user)) throw new SlackError("no_reaction");
    if (set.size === 0) m.reactions.delete(name);
  }

  pin(channel: string, ts: string): void {
    const m = this.#find(channel, ts);
    if (m.pinned) throw new SlackError("already_pinned");
    m.pinned = true;
  }

  unpin(channel: string, ts: string): void {
    const m = this.#find(channel, ts);
    if (!m.pinned) throw new SlackError("not_pinned");
    m.pinned = false;
  }

  setTopic(channel: string, text: string): void {
    this.#channel(channel).topic = text;
  }

  setPurpose(channel: string, text: string): void {
    this.#channel(channel).purpose = text;
  }

  members(channel: string): string[] {
    return [...this.#channel(channel).members];
  }

  search(query: string): FakeMessage[] {
    const q = query.toLowerCase();
    const out: FakeMessage[] = [];
    for (const list of this.#messages.values()) for (const m of list) if (!m.deleted && m.text.toLowerCase().includes(q)) out.push(m);
    return out;
  }

  postEphemeral(channel: string, user: string, text: string): string {
    this.#channel(channel);
    const ts = this.clock.next();
    this.#ephemerals.push({ channel, user, text, ts });
    return ts;
  }

  ephemerals(): Array<{ channel: string; user: string; text: string; ts: string }> {
    return [...this.#ephemerals];
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test e2e/fake-slack/core --coverage=false && bun run typecheck`
Expected: PASS, typecheck clean. Fix any strict-flag typing nit in the smallest way.

- [ ] **Step 5: Commit**

```bash
git add e2e/fake-slack/core
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "feat(e2e): fake Slack workspace state, clock and call log"
```

---

### Task 3: Web API handlers

**Files:**
- Create: `e2e/fake-slack/core/web-api.ts`
- Test: `e2e/fake-slack/core/web-api.test.ts`

**Interfaces:**
- Consumes: `Workspace`, `SlackError`, `FakeMessage` (Task 2); `CallLog`, `redactArgs` (Task 2).
- Produces: `interface ApiResult { status: number; headers?: Record<string, string>; body: Record<string, unknown> }`; `interface FaultRule { method: string; status: number; retryAfterSec?: number; times: number }`; `class FaultStore { add(rule: FaultRule): void; clear(): void; consume(method: string): FaultRule | undefined }` (a rule with `method: "*"` matches any method; `times` is decremented per use and the rule removed at zero); `parseParams(contentType: string | null, raw: string): Record<string, unknown>`; `createWebApi(ws: Workspace, log: CallLog, faults: FaultStore): (method: string, params: Record<string, unknown>, bearer: string | null) => ApiResult`; `KNOWN_METHODS: readonly string[]`.

Implemented methods (`KNOWN_METHODS`): `auth.test`, `chat.postMessage`, `chat.update`, `chat.delete`, `chat.postEphemeral`, `reactions.add`, `reactions.remove`, `users.info`, `users.profile.set`, `conversations.replies`, `conversations.info`, `conversations.members`, `conversations.setTopic`, `conversations.setPurpose`, `search.messages`, `pins.add`, `pins.remove`, `files.info`, `assistant.threads.setStatus`. Task 6 adds any further method the real gateway proves it calls.

- [ ] **Step 1: Write the failing tests**

`e2e/fake-slack/core/web-api.test.ts`:

```ts
import { beforeEach, expect, test } from "bun:test";
import { CallLog } from "./call-log";
import { FaultStore, KNOWN_METHODS, createWebApi, parseParams } from "./web-api";
import { Workspace } from "./workspace";

let ws: Workspace;
let log: CallLog;
let faults: FaultStore;
let api: ReturnType<typeof createWebApi>;
let token: string;

beforeEach(() => {
  ws = new Workspace("T0FAKE");
  const app = ws.addApp({ apiAppId: "A0FAKE", name: "agent", botUserId: "U0BOT" });
  token = app.botToken;
  ws.addUser("U0MGR", "manager");
  ws.addChannel({ id: "C0TEAM", name: "team", members: ["U0MGR", "U0BOT"] });
  log = new CallLog();
  faults = new FaultStore();
  api = createWebApi(ws, log, faults);
});

const call = (method: string, params: Record<string, unknown> = {}, bearer: string | null = token) => api(method, params, bearer);

test("parseParams reads form bodies, JSON bodies, and JSON-encodes nothing twice", () => {
  const form = parseParams("application/x-www-form-urlencoded", "channel=C1&text=hi&blocks=%5B%7B%22type%22%3A%22divider%22%7D%5D");
  expect(form).toEqual({ channel: "C1", text: "hi", blocks: [{ type: "divider" }] });
  const json = parseParams("application/json; charset=utf-8", JSON.stringify({ channel: "C1", blocks: [{ type: "divider" }] }));
  expect(json).toEqual({ channel: "C1", blocks: [{ type: "divider" }] });
  expect(parseParams(null, "")).toEqual({});
  expect(parseParams("application/json", "not json")).toEqual({});
  expect(parseParams("application/x-www-form-urlencoded", "blocks=not-json").blocks).toBe("not-json");
});

test("auth.test identifies the bot for the token", () => {
  const r = call("auth.test");
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ok: true, user_id: "U0BOT", team_id: "T0FAKE", bot_id: expect.any(String) });
});

test("a bad or missing token is invalid_auth", () => {
  expect(call("auth.test", {}, "nope").body).toEqual({ ok: false, error: "invalid_auth" });
  expect(call("chat.postMessage", { channel: "C0TEAM", text: "x" }, null).body).toEqual({ ok: false, error: "invalid_auth" });
});

test("the token can come from the token param when there is no bearer", () => {
  expect(call("auth.test", { token }, null).body).toMatchObject({ ok: true });
});

test("chat.postMessage posts as the bot, supports threads and blocks", () => {
  const root = call("chat.postMessage", { channel: "C0TEAM", text: "hello" }).body as any;
  expect(root).toMatchObject({ ok: true, channel: "C0TEAM", ts: expect.any(String), message: { user: "U0BOT", text: "hello" } });
  const reply = call("chat.postMessage", { channel: "C0TEAM", text: "re", thread_ts: root.ts, blocks: [{ type: "divider" }] }).body as any;
  expect(reply.message.thread_ts).toBe(root.ts);
  expect(ws.replies("C0TEAM", root.ts).map((m) => m.text)).toEqual(["hello", "re"]);
  expect((ws.message("C0TEAM", reply.ts)!.blocks as unknown[]).length).toBe(1);
});

test("chat.postMessage errors are Slack errors in an HTTP 200", () => {
  expect(call("chat.postMessage", { channel: "C0NOPE", text: "x" })).toMatchObject({ status: 200, body: { ok: false, error: "channel_not_found" } });
  expect(call("chat.postMessage", { text: "x" }).body).toEqual({ ok: false, error: "channel_not_found" });
  expect(call("chat.postMessage", { channel: "C0TEAM" }).body).toEqual({ ok: false, error: "no_text" });
});

test("chat.update, chat.delete, reactions, pins", () => {
  const ts = (call("chat.postMessage", { channel: "C0TEAM", text: "v1" }).body as any).ts as string;
  expect(call("chat.update", { channel: "C0TEAM", ts, text: "v2" }).body).toMatchObject({ ok: true, text: "v2" });
  expect(call("reactions.add", { channel: "C0TEAM", timestamp: ts, name: "eyes" }).body).toEqual({ ok: true });
  expect(call("reactions.add", { channel: "C0TEAM", timestamp: ts, name: "eyes" }).body).toEqual({ ok: false, error: "already_reacted" });
  expect(call("reactions.remove", { channel: "C0TEAM", timestamp: ts, name: "eyes" }).body).toEqual({ ok: true });
  expect(call("pins.add", { channel: "C0TEAM", timestamp: ts }).body).toEqual({ ok: true });
  expect(call("pins.remove", { channel: "C0TEAM", timestamp: ts }).body).toEqual({ ok: true });
  expect(call("chat.delete", { channel: "C0TEAM", ts }).body).toMatchObject({ ok: true, ts });
  expect(call("chat.update", { channel: "C0TEAM", ts, text: "v3" }).body).toEqual({ ok: false, error: "message_not_found" });
});

test("chat.postEphemeral does not enter the channel's messages", () => {
  const r = call("chat.postEphemeral", { channel: "C0TEAM", user: "U0MGR", text: "psst" }).body as any;
  expect(r).toMatchObject({ ok: true, message_ts: expect.any(String) });
  expect(ws.messages("C0TEAM")).toHaveLength(0);
  expect(ws.ephemerals()).toHaveLength(1);
});

test("users.info and conversations.* read the workspace", () => {
  expect(call("users.info", { user: "U0MGR" }).body).toMatchObject({ ok: true, user: { id: "U0MGR", name: "manager", is_bot: false } });
  expect(call("users.info", { user: "U0NOPE" }).body).toEqual({ ok: false, error: "user_not_found" });
  expect(call("conversations.info", { channel: "C0TEAM" }).body).toMatchObject({ ok: true, channel: { id: "C0TEAM", name: "team", is_im: false } });
  expect(call("conversations.members", { channel: "C0TEAM" }).body).toMatchObject({ ok: true, members: ["U0MGR", "U0BOT"] });
  expect(call("conversations.setTopic", { channel: "C0TEAM", topic: "t" }).body).toMatchObject({ ok: true });
  expect(call("conversations.setPurpose", { channel: "C0TEAM", purpose: "p" }).body).toMatchObject({ ok: true });
  expect(ws.channels.get("C0TEAM")).toMatchObject({ topic: "t", purpose: "p" });
});

test("conversations.replies returns the thread", () => {
  const root = (call("chat.postMessage", { channel: "C0TEAM", text: "root" }).body as any).ts as string;
  call("chat.postMessage", { channel: "C0TEAM", text: "child", thread_ts: root });
  const r = call("conversations.replies", { channel: "C0TEAM", ts: root }).body as any;
  expect(r.ok).toBe(true);
  expect(r.messages.map((m: any) => m.text)).toEqual(["root", "child"]);
  expect(call("conversations.replies", { channel: "C0TEAM", ts: "1.000001" }).body).toEqual({ ok: false, error: "thread_not_found" });
});

test("search.messages, files.info, assistant.threads.setStatus, users.profile.set", () => {
  call("chat.postMessage", { channel: "C0TEAM", text: "needle in a haystack" });
  const s = call("search.messages", { query: "needle" }).body as any;
  expect(s.ok).toBe(true);
  expect(s.messages.total).toBe(1);
  expect(s.messages.matches[0].text).toBe("needle in a haystack");
  expect(call("files.info", { file: "F0NOPE" }).body).toEqual({ ok: false, error: "file_not_found" });
  expect(call("assistant.threads.setStatus", { channel_id: "C0TEAM", thread_ts: "1.000001", status: "thinking" }).body).toEqual({ ok: true });
  expect(call("users.profile.set", { profile: "{}" }).body).toEqual({ ok: true });
});

test("an unknown method fails loudly, is flagged in the log, and never succeeds", () => {
  const r = call("nonsense.method", { a: 1 });
  expect(r).toMatchObject({ status: 200, body: { ok: false, error: "unknown_method" } });
  const row = log.all().at(-1)!;
  expect(row).toMatchObject({ kind: "api", method: "nonsense.method", ok: false, error: "unknown_method", unknown: true });
});

test("every call is logged with the token redacted, app attributed, and ok/error recorded", () => {
  call("chat.postMessage", { channel: "C0TEAM", text: "logged", token: "secret" });
  call("chat.postMessage", { channel: "C0NOPE", text: "bad" });
  const [a, b] = log.all();
  expect(a).toMatchObject({ method: "chat.postMessage", app: "A0FAKE", ok: true, status: 200 });
  expect(a!.args).toEqual({ channel: "C0TEAM", text: "logged" });
  expect(b).toMatchObject({ ok: false, error: "channel_not_found" });
});

test("fault rules return 429 with Retry-After or a 5xx, then expire", () => {
  faults.add({ method: "chat.postMessage", status: 429, retryAfterSec: 3, times: 1 });
  const limited = call("chat.postMessage", { channel: "C0TEAM", text: "x" });
  expect(limited.status).toBe(429);
  expect(limited.headers).toEqual({ "retry-after": "3" });
  expect(limited.body).toEqual({ ok: false, error: "ratelimited" });
  expect(call("chat.postMessage", { channel: "C0TEAM", text: "x" }).status).toBe(200);
  expect(ws.messages("C0TEAM")).toHaveLength(1); // the faulted call had no effect

  faults.add({ method: "*", status: 503, times: 2 });
  expect(call("auth.test").status).toBe(503);
  expect(call("users.info", { user: "U0MGR" }).status).toBe(503);
  expect(call("auth.test").status).toBe(200);
  expect(log.where((r) => r.status === 429 || r.status === 503)).toHaveLength(3);
});

test("FaultStore.clear removes pending rules", () => {
  faults.add({ method: "*", status: 500, times: 5 });
  faults.clear();
  expect(faults.consume("auth.test")).toBeUndefined();
});

test("KNOWN_METHODS lists exactly what the dispatcher implements", () => {
  for (const m of KNOWN_METHODS) expect(call(m, {}).body.error).not.toBe("unknown_method");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test e2e/fake-slack/core/web-api.test.ts --coverage=false`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement**

`e2e/fake-slack/core/web-api.ts`:

```ts
import type { CallLog } from "./call-log";
import { redactArgs } from "./call-log";
import { SlackError, type FakeMessage, type Workspace } from "./workspace";

export interface ApiResult {
  status: number;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}

export interface FaultRule {
  /** A method name, or "*" for any method. */
  method: string;
  status: number;
  retryAfterSec?: number;
  times: number;
}

export class FaultStore {
  #rules: FaultRule[] = [];
  add(rule: FaultRule): void {
    this.#rules.push({ ...rule });
  }
  clear(): void {
    this.#rules = [];
  }
  /** Take one use of the first matching rule, if any. */
  consume(method: string): FaultRule | undefined {
    const i = this.#rules.findIndex((r) => r.times > 0 && (r.method === "*" || r.method === method));
    if (i < 0) return undefined;
    const rule = this.#rules[i]!;
    rule.times -= 1;
    if (rule.times <= 0) this.#rules.splice(i, 1);
    return rule;
  }
}

const JSON_FIELDS = ["blocks", "attachments", "metadata"];

/** Decode a Web API request body (form or JSON) into plain params. */
export function parseParams(contentType: string | null, raw: string): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  if ((contentType ?? "").includes("application/json")) {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) out = v as Record<string, unknown>;
    } catch {
      return {};
    }
  } else if (raw) {
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  }
  for (const k of JSON_FIELDS) {
    const v = out[k];
    if (typeof v === "string") {
      try {
        out[k] = JSON.parse(v);
      } catch {}
    }
  }
  return out;
}

type Params = Record<string, unknown>;
type Handler = (p: Params, ctx: { ws: Workspace; botUserId: string; appId: string }) => Record<string, unknown>;

const str = (p: Params, k: string): string | undefined => (typeof p[k] === "string" && p[k] !== "" ? (p[k] as string) : undefined);

function need(p: Params, k: string, err = "invalid_arguments"): string {
  const v = str(p, k);
  if (v === undefined) throw new SlackError(err);
  return v;
}

function apiMessage(ws: Workspace, m: FakeMessage): Record<string, unknown> {
  const replyCount = m.threadTs ? 0 : ws.messages(m.channel).filter((x) => x.threadTs === m.ts).length;
  return {
    type: "message",
    user: m.user,
    text: m.text,
    ts: m.ts,
    ...(m.threadTs ? { thread_ts: m.threadTs } : replyCount ? { thread_ts: m.ts, reply_count: replyCount } : {}),
    ...(m.appId ? { app_id: m.appId, bot_id: `B${m.appId.slice(1)}` } : {}),
    ...(m.blocks ? { blocks: m.blocks } : {}),
    ...(m.reactions.size
      ? { reactions: [...m.reactions].map(([name, users]) => ({ name, count: users.size, users: [...users] })) }
      : {}),
  };
}

const HANDLERS: Record<string, Handler> = {
  "auth.test": (_p, { ws, botUserId }) => ({
    ok: true,
    url: "https://fake.invalid/",
    team: "Fake Team",
    user: ws.users.get(botUserId)?.name ?? "agent",
    team_id: ws.teamId,
    user_id: botUserId,
    bot_id: `B${botUserId.slice(1)}`,
  }),
  "chat.postMessage": (p, { ws, botUserId, appId }) => {
    const channel = need(p, "channel", "channel_not_found");
    if (str(p, "text") === undefined && p.blocks === undefined) throw new SlackError("no_text");
    const m = ws.post({ channel, user: botUserId, text: str(p, "text") ?? "", blocks: p.blocks, threadTs: str(p, "thread_ts"), appId });
    return { ok: true, channel, ts: m.ts, message: apiMessage(ws, m) };
  },
  "chat.update": (p, { ws }) => {
    const channel = need(p, "channel", "channel_not_found");
    const m = ws.update(channel, need(p, "ts", "message_not_found"), { text: str(p, "text"), blocks: p.blocks });
    return { ok: true, channel, ts: m.ts, text: m.text, message: apiMessage(ws, m) };
  },
  "chat.delete": (p, { ws }) => {
    const channel = need(p, "channel", "channel_not_found");
    const ts = need(p, "ts", "message_not_found");
    ws.remove(channel, ts);
    return { ok: true, channel, ts };
  },
  "chat.postEphemeral": (p, { ws }) => ({
    ok: true,
    message_ts: ws.postEphemeral(need(p, "channel", "channel_not_found"), need(p, "user", "user_not_found"), str(p, "text") ?? ""),
  }),
  "reactions.add": (p, { ws, botUserId }) => {
    ws.react(need(p, "channel", "channel_not_found"), need(p, "timestamp", "message_not_found"), need(p, "name", "invalid_name"), botUserId);
    return { ok: true };
  },
  "reactions.remove": (p, { ws, botUserId }) => {
    ws.unreact(need(p, "channel", "channel_not_found"), need(p, "timestamp", "message_not_found"), need(p, "name", "invalid_name"), botUserId);
    return { ok: true };
  },
  "users.info": (p, { ws }) => {
    const u = ws.users.get(need(p, "user", "user_not_found"));
    if (!u) throw new SlackError("user_not_found");
    return {
      ok: true,
      user: { id: u.id, team_id: ws.teamId, name: u.name, real_name: u.name, is_bot: u.isBot, profile: { display_name: u.name, real_name: u.name } },
    };
  },
  "users.profile.set": () => ({ ok: true }),
  "conversations.replies": (p, { ws }) => {
    const msgs = ws.replies(need(p, "channel", "channel_not_found"), need(p, "ts", "thread_not_found"));
    return { ok: true, messages: msgs.map((m) => apiMessage(ws, m)), has_more: false };
  },
  "conversations.info": (p, { ws }) => {
    const ch = ws.channels.get(need(p, "channel", "channel_not_found"));
    if (!ch) throw new SlackError("channel_not_found");
    return {
      ok: true,
      channel: {
        id: ch.id,
        name: ch.name,
        is_channel: !ch.isIm,
        is_im: ch.isIm,
        is_member: true,
        topic: { value: ch.topic },
        purpose: { value: ch.purpose },
      },
    };
  },
  "conversations.members": (p, { ws }) => ({
    ok: true,
    members: ws.members(need(p, "channel", "channel_not_found")),
    response_metadata: { next_cursor: "" },
  }),
  "conversations.setTopic": (p, { ws }) => {
    const channel = need(p, "channel", "channel_not_found");
    ws.setTopic(channel, str(p, "topic") ?? "");
    return { ok: true, channel: { id: channel } };
  },
  "conversations.setPurpose": (p, { ws }) => {
    const channel = need(p, "channel", "channel_not_found");
    ws.setPurpose(channel, str(p, "purpose") ?? "");
    return { ok: true, channel: { id: channel } };
  },
  "search.messages": (p, { ws }) => {
    const hits = ws.search(str(p, "query") ?? "");
    return {
      ok: true,
      query: str(p, "query") ?? "",
      messages: { total: hits.length, matches: hits.map((m) => ({ ...apiMessage(ws, m), channel: { id: m.channel } })) },
    };
  },
  "pins.add": (p, { ws }) => {
    ws.pin(need(p, "channel", "channel_not_found"), need(p, "timestamp", "message_not_found"));
    return { ok: true };
  },
  "pins.remove": (p, { ws }) => {
    ws.unpin(need(p, "channel", "channel_not_found"), need(p, "timestamp", "message_not_found"));
    return { ok: true };
  },
  "files.info": () => {
    throw new SlackError("file_not_found");
  },
  "assistant.threads.setStatus": () => ({ ok: true }),
};

export const KNOWN_METHODS: readonly string[] = Object.keys(HANDLERS);

export function createWebApi(
  ws: Workspace,
  log: CallLog,
  faults: FaultStore,
): (method: string, params: Params, bearer: string | null) => ApiResult {
  return (method, params, bearer) => {
    const token = bearer ?? (typeof params.token === "string" ? params.token : null);
    const app = token ? ws.appByToken(token) : undefined;
    const args = redactArgs(params);
    const done = (status: number, body: Record<string, unknown>, headers?: Record<string, string>, unknown?: boolean): ApiResult => {
      log.add({
        kind: "api",
        method,
        app: app?.apiAppId,
        ok: body.ok === true,
        error: typeof body.error === "string" ? body.error : undefined,
        status,
        args,
        ...(unknown ? { unknown: true } : {}),
      });
      return { status, body, ...(headers ? { headers } : {}) };
    };

    const fault = faults.consume(method);
    if (fault) {
      const headers = fault.retryAfterSec !== undefined ? { "retry-after": String(fault.retryAfterSec) } : undefined;
      return done(fault.status, { ok: false, error: fault.status === 429 ? "ratelimited" : "fatal_error" }, headers);
    }
    if (!app) return done(200, { ok: false, error: "invalid_auth" });
    const handler = HANDLERS[method];
    if (!handler) return done(200, { ok: false, error: "unknown_method" }, undefined, true);
    try {
      return done(200, handler(params, { ws, botUserId: app.botUserId, appId: app.apiAppId }));
    } catch (e) {
      if (e instanceof SlackError) return done(200, { ok: false, error: e.code });
      throw e;
    }
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test e2e/fake-slack/core --coverage=false && bun run typecheck`
Expected: PASS, typecheck clean. If a test expectation conflicts with how the real `@slack/web-api` shapes arguments, adapt the **fake** to the SDK's real behaviour (Task 5 verifies against the real client), not the other way round.

- [ ] **Step 5: Commit**

```bash
git add e2e/fake-slack/core/web-api.ts e2e/fake-slack/core/web-api.test.ts
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "feat(e2e): fake Slack Web API with loud unknown-method failure and fault rules"
```

---

### Task 4: Inbound sender (signed events and interactions, Slack-style retries)

**Files:**
- Create: `e2e/fake-slack/core/inbound.ts`
- Test: `e2e/fake-slack/core/inbound.test.ts`

**Interfaces:**
- Consumes: `Workspace`, `FakeApp`, `FakeMessage` (Task 2); `signSlackRequest`, `verifySlackSignature` from `src/gateway/slack/verify.ts`.
- Produces: `signedHeaders(secret: string, raw: string, contentType: string, nowMs?: number): Record<string, string>`; `messageEnvelope(ws: Workspace, app: FakeApp, msg: FakeMessage, opts?: { eventId?: string }): Record<string, unknown>`; `blockActionsPayload(i: { ws: Workspace; app: FakeApp; user: string; channel: string; messageTs: string; actionId: string; value?: string; blockId?: string; responseUrl: string }): Record<string, unknown>`; `interface DeliverOptions { fetchFn?: typeof fetch; ackTimeoutMs?: number; retryDelaysMs?: number[]; sleep?: (ms: number) => Promise<void>; nowMs?: () => number; retryNum?: number }`; `interface DeliveryAttempt { retryNum: number; status: number | "timeout" | "error" }`; `interface DeliveryResult { attempts: DeliveryAttempt[]; finalStatus: number | "timeout" | "error" }`; `deliverEvent(url: string, secret: string, envelope: object, opts?: DeliverOptions): Promise<DeliveryResult>`; `deliverInteraction(url: string, secret: string, payload: object, opts?: DeliverOptions): Promise<DeliveryResult>`.

Slack's documented retry behaviour: on a non-2xx response or no acknowledgement within 3 seconds, Slack retries up to three times (immediately, after about a minute, after about five minutes) with `X-Slack-Retry-Num` (1 to 3) and `X-Slack-Retry-Reason` (`http_timeout` or `http_error`). Each attempt carries a fresh signature. The default delays are `[0, 60000, 300000]`; tests and the control API pass tiny values.

- [ ] **Step 1: Write the failing tests**

`e2e/fake-slack/core/inbound.test.ts`:

```ts
import { beforeEach, expect, test } from "bun:test";
import { verifySlackSignature } from "../../../src/gateway/slack/verify";
import { blockActionsPayload, deliverEvent, deliverInteraction, messageEnvelope, signedHeaders } from "./inbound";
import { Workspace, type FakeApp } from "./workspace";

let ws: Workspace;
let app: FakeApp;

beforeEach(() => {
  ws = new Workspace("T0FAKE");
  app = ws.addApp({ apiAppId: "A0FAKE", name: "agent", botUserId: "U0BOT", signingSecret: "sekret" });
  ws.addUser("U0MGR", "manager");
  ws.addChannel({ id: "C0TEAM", name: "team", members: ["U0MGR", "U0BOT"] });
  ws.addChannel({ id: "D0MGR", name: "dm", isIm: true, members: ["U0MGR", "U0BOT"] });
});

test("signedHeaders produces a signature the gateway's verifier accepts", () => {
  const raw = '{"a":1}';
  const h = signedHeaders("sekret", raw, "application/json", 1_700_000_000_000);
  expect(h["content-type"]).toBe("application/json");
  expect(
    verifySlackSignature({
      signingSecret: "sekret",
      rawBody: raw,
      timestamp: h["x-slack-request-timestamp"]!,
      signature: h["x-slack-signature"]!,
      nowMs: 1_700_000_000_000,
    }),
  ).toEqual({ ok: true });
  expect(
    verifySlackSignature({ signingSecret: "wrong", rawBody: raw, timestamp: h["x-slack-request-timestamp"]!, signature: h["x-slack-signature"]!, nowMs: 1_700_000_000_000 }),
  ).toEqual({ ok: false, reason: "mismatch" });
});

test("messageEnvelope carries the fields the gateway routes on", () => {
  const m = ws.post({ channel: "C0TEAM", user: "U0MGR", text: "<@U0BOT> hi" });
  const env = messageEnvelope(ws, app, m, { eventId: "Ev0TEST" }) as any;
  expect(env).toMatchObject({
    type: "event_callback",
    api_app_id: "A0FAKE",
    team_id: "T0FAKE",
    event_id: "Ev0TEST",
    event: { type: "message", channel: "C0TEAM", channel_type: "channel", user: "U0MGR", text: "<@U0BOT> hi", ts: m.ts, team: "T0FAKE" },
    authorizations: [{ team_id: "T0FAKE", user_id: "U0BOT", is_bot: true }],
  });
  expect(env.event.thread_ts).toBeUndefined();
  expect(typeof env.event_time).toBe("number");
});

test("messageEnvelope marks DMs as im and threads replies; event ids are unique by default", () => {
  const root = ws.post({ channel: "D0MGR", user: "U0MGR", text: "dm" });
  const reply = ws.post({ channel: "D0MGR", user: "U0MGR", text: "again", threadTs: root.ts });
  const a = messageEnvelope(ws, app, root) as any;
  const b = messageEnvelope(ws, app, reply) as any;
  expect(a.event.channel_type).toBe("im");
  expect(b.event.thread_ts).toBe(root.ts);
  expect(a.event_id).not.toBe(b.event_id);
});

test("blockActionsPayload has what the approval handler reads, and is form-encodable", () => {
  const p = blockActionsPayload({
    ws,
    app,
    user: "U0MGR",
    channel: "C0TEAM",
    messageTs: "1700000000.000001",
    actionId: "slaude_appr:approve:abc",
    responseUrl: "http://fake-slack:8080/response/r1",
  }) as any;
  expect(p).toMatchObject({
    type: "block_actions",
    api_app_id: "A0FAKE",
    team: { id: "T0FAKE" },
    user: { id: "U0MGR", team_id: "T0FAKE" },
    channel: { id: "C0TEAM" },
    container: { type: "message", message_ts: "1700000000.000001", channel_id: "C0TEAM" },
    response_url: "http://fake-slack:8080/response/r1",
    actions: [{ type: "button", action_id: "slaude_appr:approve:abc" }],
  });
});

function recorder(statuses: Array<number | "hang" | "throw">) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let i = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const s = statuses[Math.min(i++, statuses.length - 1)]!;
    if (s === "throw") throw new Error("connection refused");
    if (s === "hang") {
      return new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    }
    return new Response("", { status: s });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const noSleep = async () => {};

test("deliverEvent: a 2xx on the first try is one attempt with no retry headers", async () => {
  const r = recorder([200]);
  const res = await deliverEvent("http://gw/slack/events", "sekret", { a: 1 }, { fetchFn: r.fetchFn, sleep: noSleep });
  expect(res).toEqual({ attempts: [{ retryNum: 0, status: 200 }], finalStatus: 200 });
  expect(r.calls[0]!.headers["x-slack-retry-num"]).toBeUndefined();
  expect(r.calls[0]!.body).toBe('{"a":1}');
});

test("deliverEvent: a 500 then a 200 retries once, with Slack's retry headers and a fresh signature", async () => {
  const r = recorder([500, 200]);
  const stamps = [1_700_000_000_000, 1_700_000_001_000];
  let n = 0;
  const res = await deliverEvent("http://gw/slack/events", "sekret", { a: 1 }, { fetchFn: r.fetchFn, sleep: noSleep, retryDelaysMs: [0, 0, 0], nowMs: () => stamps[Math.min(n++, 1)]! });
  expect(res.attempts.map((a) => [a.retryNum, a.status])).toEqual([[0, 500], [1, 200]]);
  expect(r.calls[1]!.headers["x-slack-retry-num"]).toBe("1");
  expect(r.calls[1]!.headers["x-slack-retry-reason"]).toBe("http_error");
  expect(r.calls[1]!.headers["x-slack-request-timestamp"]).not.toBe(r.calls[0]!.headers["x-slack-request-timestamp"]);
  // every attempt sends the SAME raw body bytes that were signed
  expect(r.calls[1]!.body).toBe(r.calls[0]!.body);
});

test("deliverEvent: gives up after the configured retries, reporting the last status", async () => {
  const r = recorder([503]);
  const res = await deliverEvent("http://gw/slack/events", "sekret", { a: 1 }, { fetchFn: r.fetchFn, sleep: noSleep, retryDelaysMs: [0, 0, 0] });
  expect(res.attempts).toHaveLength(4);
  expect(res.finalStatus).toBe(503);
});

test("deliverEvent: a slow acknowledgement is a timeout and retries as http_timeout", async () => {
  const r = recorder(["hang", 200]);
  const res = await deliverEvent("http://gw/slack/events", "sekret", { a: 1 }, { fetchFn: r.fetchFn, sleep: noSleep, ackTimeoutMs: 20, retryDelaysMs: [0] });
  expect(res.attempts.map((a) => [a.retryNum, a.status])).toEqual([[0, "timeout"], [1, 200]]);
  expect(r.calls[1]!.headers["x-slack-retry-reason"]).toBe("http_timeout");
});

test("deliverEvent: a connection error is an error attempt and retries", async () => {
  const r = recorder(["throw", 200]);
  const res = await deliverEvent("http://gw/slack/events", "sekret", { a: 1 }, { fetchFn: r.fetchFn, sleep: noSleep, retryDelaysMs: [0] });
  expect(res.attempts.map((a) => a.status)).toEqual(["error", 200]);
});

test("deliverEvent: retryNum option marks a single delivery as a retry (for dedup tests)", async () => {
  const r = recorder([200]);
  await deliverEvent("http://gw/slack/events", "sekret", { a: 1 }, { fetchFn: r.fetchFn, sleep: noSleep, retryNum: 2 });
  expect(r.calls[0]!.headers["x-slack-retry-num"]).toBe("2");
});

test("deliverInteraction posts payload=<json> form-encoded, signed over the raw form body, without retrying", async () => {
  const r = recorder([500]);
  const payload = { type: "block_actions", actions: [{ action_id: "x" }] };
  const res = await deliverInteraction("http://gw/slack/interactions", "sekret", payload, { fetchFn: r.fetchFn, sleep: noSleep });
  expect(res.attempts).toHaveLength(1);
  expect(r.calls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  expect(JSON.parse(new URLSearchParams(r.calls[0]!.body).get("payload")!)).toEqual(payload);
  expect(
    verifySlackSignature({
      signingSecret: "sekret",
      rawBody: r.calls[0]!.body,
      timestamp: r.calls[0]!.headers["x-slack-request-timestamp"]!,
      signature: r.calls[0]!.headers["x-slack-signature"]!,
    }),
  ).toEqual({ ok: true });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test e2e/fake-slack/core/inbound.test.ts --coverage=false`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement**

`e2e/fake-slack/core/inbound.ts`:

```ts
import { randomBytes } from "node:crypto";
import { signSlackRequest } from "../../../src/gateway/slack/verify";
import type { FakeApp, FakeMessage, Workspace } from "./workspace";

export function signedHeaders(secret: string, raw: string, contentType: string, nowMs: number = Date.now()): Record<string, string> {
  const ts = String(Math.floor(nowMs / 1000));
  return {
    "content-type": contentType,
    "x-slack-request-timestamp": ts,
    "x-slack-signature": signSlackRequest(secret, ts, raw),
  };
}

/** The `event_callback` envelope Slack POSTs to /slack/events for a message. */
export function messageEnvelope(ws: Workspace, app: FakeApp, msg: FakeMessage, opts: { eventId?: string } = {}): Record<string, unknown> {
  const channel = ws.channels.get(msg.channel);
  return {
    token: "fake-verification-token",
    team_id: ws.teamId,
    api_app_id: app.apiAppId,
    type: "event_callback",
    event_id: opts.eventId ?? `Ev${randomBytes(6).toString("hex").toUpperCase()}`,
    event_time: Math.floor(Number(msg.ts)),
    event: {
      type: "message",
      channel: msg.channel,
      channel_type: channel?.isIm ? "im" : "channel",
      user: msg.user,
      text: msg.text,
      ts: msg.ts,
      event_ts: msg.ts,
      team: ws.teamId,
      ...(msg.threadTs ? { thread_ts: msg.threadTs } : {}),
    },
    authorizations: [{ enterprise_id: null, team_id: ws.teamId, user_id: app.botUserId, is_bot: true, is_enterprise_install: false }],
    is_ext_shared_channel: false,
  };
}

/** The `block_actions` interaction payload Slack sends when a button is pressed. */
export function blockActionsPayload(i: {
  ws: Workspace;
  app: FakeApp;
  user: string;
  channel: string;
  messageTs: string;
  actionId: string;
  value?: string;
  blockId?: string;
  responseUrl: string;
}): Record<string, unknown> {
  const name = i.ws.users.get(i.user)?.name ?? i.user;
  return {
    type: "block_actions",
    token: "fake-verification-token",
    api_app_id: i.app.apiAppId,
    team: { id: i.ws.teamId, domain: "fake" },
    user: { id: i.user, username: name, name, team_id: i.ws.teamId },
    channel: { id: i.channel, name: i.ws.channels.get(i.channel)?.name ?? i.channel },
    container: { type: "message", message_ts: i.messageTs, channel_id: i.channel, is_ephemeral: false },
    trigger_id: `${Date.now()}.${randomBytes(4).toString("hex")}`,
    message: { type: "message", user: i.app.botUserId, ts: i.messageTs, text: "" },
    response_url: i.responseUrl,
    actions: [
      {
        type: "button",
        block_id: i.blockId ?? "b0",
        action_id: i.actionId,
        text: { type: "plain_text", text: "Button" },
        value: i.value ?? "",
        action_ts: String(Date.now() / 1000),
      },
    ],
  };
}

export interface DeliverOptions {
  fetchFn?: typeof fetch;
  /** Slack waits about 3 seconds for an acknowledgement. */
  ackTimeoutMs?: number;
  /** Delay before each retry; its length is the number of retries (Slack: 3). */
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  /** Mark the FIRST delivery as a retry (X-Slack-Retry-Num), for dedup tests. */
  retryNum?: number;
}

export interface DeliveryAttempt {
  retryNum: number;
  status: number | "timeout" | "error";
}
export interface DeliveryResult {
  attempts: DeliveryAttempt[];
  finalStatus: number | "timeout" | "error";
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function attempt(
  url: string,
  secret: string,
  raw: string,
  contentType: string,
  o: DeliverOptions,
  retryNum: number,
  reason?: string,
): Promise<DeliveryAttempt> {
  const fetchFn = o.fetchFn ?? fetch;
  const headers = signedHeaders(secret, raw, contentType, (o.nowMs ?? Date.now)());
  if (retryNum > 0) {
    headers["x-slack-retry-num"] = String(retryNum);
    headers["x-slack-retry-reason"] = reason ?? "http_error";
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.ackTimeoutMs ?? 3000);
  try {
    const res = await fetchFn(url, { method: "POST", headers, body: raw, signal: ctl.signal });
    return { retryNum, status: res.status };
  } catch (e) {
    return { retryNum, status: ctl.signal.aborted ? "timeout" : "error" };
  } finally {
    clearTimeout(timer);
  }
}

const ok2xx = (s: DeliveryAttempt["status"]) => typeof s === "number" && s >= 200 && s < 300;

/** Deliver an Events API envelope, retrying like Slack does on failure. */
export async function deliverEvent(url: string, secret: string, envelope: object, o: DeliverOptions = {}): Promise<DeliveryResult> {
  const raw = JSON.stringify(envelope); // signed and sent as the SAME string
  const sleep = o.sleep ?? realSleep;
  const attempts: DeliveryAttempt[] = [];
  let last = await attempt(url, secret, raw, "application/json", o, o.retryNum ?? 0);
  attempts.push(last);
  const delays = o.retryDelaysMs ?? [0, 60_000, 300_000];
  for (let i = 0; i < delays.length && !ok2xx(last.status); i++) {
    await sleep(delays[i]!);
    last = await attempt(url, secret, raw, "application/json", o, i + 1, last.status === "timeout" ? "http_timeout" : "http_error");
    attempts.push(last);
  }
  return { attempts, finalStatus: last.status };
}

/** Deliver an interaction (button press). Slack does not retry these. */
export async function deliverInteraction(url: string, secret: string, payload: object, o: DeliverOptions = {}): Promise<DeliveryResult> {
  const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const a = await attempt(url, secret, raw, "application/x-www-form-urlencoded", o, 0);
  return { attempts: [a], finalStatus: a.status };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test e2e/fake-slack/core --coverage=false && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add e2e/fake-slack/core/inbound.ts e2e/fake-slack/core/inbound.test.ts
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "feat(e2e): fake Slack inbound sender with signed events, interactions and retries"
```

---

### Task 5: HTTP server, control API and client

**Files:**
- Create: `e2e/fake-slack/server.ts`
- Create: `e2e/fake-slack/control-client.ts`
- Create: `e2e/fake-slack/main.ts`
- Create: `e2e/fake-slack/util.ts`
- Test: `e2e/fake-slack/server.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces (`server.ts`): `interface FakeSlack { url: string; port: number; ws: Workspace; log: CallLog; faults: FaultStore; stop(): Promise<void> }`; `startFakeSlack(opts?: { port?: number; host?: string; teamId?: string; publicUrl?: string; retryDelaysMs?: number[]; ackTimeoutMs?: number }): Promise<FakeSlack>`. HTTP surface: `GET /healthz`; `POST /api/<method>` (Web API); `POST /response/<id>` (response_url sink, recorded as `kind: "response_url"`, answers `ok`); control API under `/__fake/` (below).
- Produces (`control-client.ts`): `createControlClient(baseUrl: string)` returning an object with `addUser`, `addApp`, `addChannel`, `send`, `click`, `thread`, `messages`, `calls`, `clearCalls`, `addFault`, `clearFaults`, `reset` (typed wrappers over the control API below).
- Produces (`util.ts`): `until<T>(fn: () => T | Promise<T>, opts?: { timeoutMs?: number; intervalMs?: number; what?: string }): Promise<NonNullable<T>>` — polls until `fn` returns a truthy value, else throws an error naming `what`.
- Produces (`main.ts`): process entry. Env: `PORT` (default 8080), `FAKE_SLACK_PUBLIC_URL` (default `http://127.0.0.1:<port>`), `FAKE_SLACK_TEAM_ID` (default `T0FAKE`), `FAKE_SLACK_RETRY_DELAYS` (comma-separated ms; default `0,60000,300000`). Prints `fake-slack listening on <port>`; stops on SIGTERM and SIGINT.

Control API (JSON in, JSON out, all under `/__fake/`):

| Route | Body / query | Result |
|---|---|---|
| `POST users` | `{id, name}` | the user |
| `POST apps` | `{apiAppId, name, botUserId?}` | the app incl. `botToken` and `signingSecret` |
| `GET apps` | | all apps |
| `POST channels` | `{id, name, isIm?, members?}` | the channel |
| `POST send` | `{app, channel, user, text, target, threadTs?, mention?, eventId?, duplicate?, retryNum?}` | `{message: {ts, channel, threadTs}, deliveries: DeliveryResult[]}` — posts a human message into the workspace, then delivers its event to `<target>/slack/events` (twice if `duplicate`, same `event_id`); `mention` prefixes `<@bot> `; `app` is an `apiAppId` |
| `POST click` | `{app, target, user, channel, messageTs, actionId, value?}` | `{delivery: DeliveryResult}` — delivers a `block_actions` interaction to `<target>/slack/interactions` with a `response_url` of `<publicUrl>/response/<random>` |
| `GET thread?channel=&threadTs=` | | `{messages: [{ts, user, text, blocks, threadTs}]}` |
| `GET messages?channel=` | | the same list for the whole channel |
| `GET calls?method=&since=` | | `{calls: CallRecord[]}` filtered by method and `seq > since` |
| `DELETE calls` | | `{ok: true}` |
| `POST faults` | `{method, status, retryAfterSec?, times}` | `{ok: true}` |
| `DELETE faults` | | `{ok: true}` |
| `POST reset` | | clears calls, faults and ALL messages (users, apps and channels are kept) |

- [ ] **Step 1: Write the failing tests**

`e2e/fake-slack/server.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { WebClient } from "@slack/web-api";
import { verifySlackSignature } from "../../src/gateway/slack/verify";
import { createControlClient } from "./control-client";
import { startFakeSlack, type FakeSlack } from "./server";
import { until } from "./util";

let fake: FakeSlack;
let ctl: ReturnType<typeof createControlClient>;
let app: { apiAppId: string; botToken: string; signingSecret: string; botUserId: string };
let client: WebClient;

type Hit = { path: string; headers: Headers; body: string };
let receiver: ReturnType<typeof Bun.serve>;
let hits: Hit[] = [];
let receiverStatuses: number[] = [];

beforeAll(async () => {
  fake = await startFakeSlack({ port: 0, retryDelaysMs: [0, 0, 0], ackTimeoutMs: 200 });
  ctl = createControlClient(fake.url);
  await ctl.addUser({ id: "U0MGR", name: "manager" });
  app = await ctl.addApp({ apiAppId: "A0FAKE", name: "agent", botUserId: "U0BOT" });
  await ctl.addChannel({ id: "C0TEAM", name: "team", members: ["U0MGR", "U0BOT"] });
  await ctl.addChannel({ id: "D0MGR", name: "dm", isIm: true, members: ["U0MGR", "U0BOT"] });
  client = new WebClient(app.botToken, { slackApiUrl: `${fake.url}/api/`, retryConfig: { retries: 0 } });
  receiver = Bun.serve({
    port: 0,
    async fetch(req) {
      hits.push({ path: new URL(req.url).pathname, headers: req.headers, body: await req.text() });
      return new Response("", { status: receiverStatuses.shift() ?? 200 });
    },
  });
});

afterAll(async () => {
  receiver.stop(true);
  await fake.stop();
});

beforeEach(async () => {
  hits = [];
  receiverStatuses = [];
  await ctl.reset();
});

const target = () => `http://127.0.0.1:${receiver.port}`;

test("healthz", async () => {
  expect(await (await fetch(`${fake.url}/healthz`)).text()).toBe("ok");
});

test("the real @slack/web-api client works against the fake", async () => {
  const auth = await client.auth.test();
  expect(auth).toMatchObject({ ok: true, user_id: "U0BOT", team_id: "T0FAKE" });
  const posted = await client.chat.postMessage({ channel: "C0TEAM", text: "hello", blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }] });
  expect(posted.ok).toBe(true);
  const upd = await client.chat.update({ channel: "C0TEAM", ts: posted.ts!, text: "edited" });
  expect(upd.ok).toBe(true);
  await client.reactions.add({ channel: "C0TEAM", timestamp: posted.ts!, name: "eyes" });
  const replies = await client.conversations.replies({ channel: "C0TEAM", ts: posted.ts! });
  expect(replies.messages!.map((m) => m.text)).toEqual(["edited"]);
  const thread = await ctl.thread("C0TEAM", posted.ts!);
  expect(thread.messages[0]).toMatchObject({ text: "edited", user: "U0BOT" });
});

test("a Slack platform error surfaces as the SDK's platform error", async () => {
  await expect(client.chat.postMessage({ channel: "C0NOPE", text: "x" })).rejects.toMatchObject({ data: { error: "channel_not_found" } });
});

test("an unknown method is unknown_method on the wire and flagged in the call log", async () => {
  await expect(client.apiCall("nonsense.method", {})).rejects.toMatchObject({ data: { error: "unknown_method" } });
  const { calls } = await ctl.calls({ method: "nonsense.method" });
  expect(calls[0]).toMatchObject({ unknown: true, ok: false });
});

test("the call log is ordered, filterable by method and by since, and clearable", async () => {
  await client.auth.test();
  await client.chat.postMessage({ channel: "C0TEAM", text: "a" });
  const all = (await ctl.calls()).calls;
  expect(all.map((c) => c.method)).toEqual(["auth.test", "chat.postMessage"]);
  expect((await ctl.calls({ method: "chat.postMessage" })).calls).toHaveLength(1);
  expect((await ctl.calls({ since: all[0]!.seq })).calls.map((c) => c.method)).toEqual(["chat.postMessage"]);
  await ctl.clearCalls();
  expect((await ctl.calls()).calls).toEqual([]);
});

test("faults: a 429 with Retry-After on the wire, then recovery", async () => {
  await ctl.addFault({ method: "chat.postMessage", status: 429, retryAfterSec: 7, times: 1 });
  const r = await fetch(`${fake.url}/api/chat.postMessage`, {
    method: "POST",
    headers: { authorization: `Bearer ${app.botToken}`, "content-type": "application/json" },
    body: JSON.stringify({ channel: "C0TEAM", text: "x" }),
  });
  expect(r.status).toBe(429);
  expect(r.headers.get("retry-after")).toBe("7");
  expect((await client.chat.postMessage({ channel: "C0TEAM", text: "x" })).ok).toBe(true);
  await ctl.addFault({ method: "*", status: 503, times: 5 });
  await ctl.clearFaults();
  expect((await client.auth.test()).ok).toBe(true);
});

test("send posts the human message and delivers a signed event to the target", async () => {
  const res = await ctl.send({ app: "A0FAKE", channel: "C0TEAM", user: "U0MGR", text: "deploy", target: target(), mention: true });
  expect(res.deliveries).toHaveLength(1);
  expect(res.deliveries[0]!.finalStatus).toBe(200);
  expect(hits).toHaveLength(1);
  expect(hits[0]!.path).toBe("/slack/events");
  const body = JSON.parse(hits[0]!.body);
  expect(body).toMatchObject({ type: "event_callback", api_app_id: "A0FAKE", event: { text: "<@U0BOT> deploy", user: "U0MGR", channel: "C0TEAM", ts: res.message.ts } });
  expect(
    verifySlackSignature({
      signingSecret: app.signingSecret,
      rawBody: hits[0]!.body,
      timestamp: hits[0]!.headers.get("x-slack-request-timestamp"),
      signature: hits[0]!.headers.get("x-slack-signature"),
    }),
  ).toEqual({ ok: true });
  expect((await ctl.messages("C0TEAM")).messages.map((m) => m.text)).toEqual(["<@U0BOT> deploy"]);
});

test("send with duplicate delivers the same event_id twice", async () => {
  await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "once", target: target(), duplicate: true });
  expect(hits).toHaveLength(2);
  expect(JSON.parse(hits[0]!.body).event_id).toBe(JSON.parse(hits[1]!.body).event_id);
});

test("send retries on a failing target like Slack does, and reports every attempt", async () => {
  receiverStatuses = [500, 500, 200];
  const res = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "flaky", target: target() });
  expect(res.deliveries[0]!.attempts.map((a) => a.status)).toEqual([500, 500, 200]);
  expect(hits.map((h) => h.headers.get("x-slack-retry-num"))).toEqual([null, "1", "2"]);
});

test("send honours threadTs and an unknown app or channel is a clear 4xx", async () => {
  const root = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "root", target: target() });
  const child = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "child", target: target(), threadTs: root.message.ts });
  expect(JSON.parse(hits[1]!.body).event.thread_ts).toBe(root.message.ts);
  expect(child.message.threadTs).toBe(root.message.ts);
  await expect(ctl.send({ app: "A0NOPE", channel: "D0MGR", user: "U0MGR", text: "x", target: target() })).rejects.toThrow(/unknown app/);
  await expect(ctl.send({ app: "A0FAKE", channel: "C0NOPE", user: "U0MGR", text: "x", target: target() })).rejects.toThrow(/channel_not_found/);
});

test("click delivers a signed interaction with a response_url the fake serves", async () => {
  const card = await client.chat.postMessage({ channel: "C0TEAM", text: "card", blocks: [] });
  const res = await ctl.click({ app: "A0FAKE", target: target(), user: "U0MGR", channel: "C0TEAM", messageTs: card.ts!, actionId: "slaude_appr:approve:abc" });
  expect(res.delivery.finalStatus).toBe(200);
  expect(hits[0]!.path).toBe("/slack/interactions");
  const payload = JSON.parse(new URLSearchParams(hits[0]!.body).get("payload")!);
  expect(payload.actions[0].action_id).toBe("slaude_appr:approve:abc");
  expect(payload.response_url).toStartWith(`${fake.url}/response/`);
  // the gateway would answer by POSTing to response_url
  const answered = await fetch(payload.response_url, { method: "POST", body: JSON.stringify({ text: "done", replace_original: true }) });
  expect(await answered.text()).toBe("ok");
  const rows = (await ctl.calls({ method: "response_url" })).calls;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "response_url", ok: true });
  expect(rows[0]!.detail).toMatchObject({ body: { text: "done" } });
});

test("reset clears messages, calls and faults but keeps users, apps and channels", async () => {
  await client.chat.postMessage({ channel: "C0TEAM", text: "gone soon" });
  await ctl.addFault({ method: "*", status: 500, times: 9 });
  await ctl.reset();
  expect((await ctl.messages("C0TEAM")).messages).toEqual([]);
  expect((await ctl.calls()).calls).toEqual([]);
  expect((await client.auth.test()).ok).toBe(true);
});

test("hostile requests never crash the server", async () => {
  for (const [path, init] of [
    ["/api/chat.postMessage", { method: "POST", body: "{{{{", headers: { "content-type": "application/json", authorization: `Bearer ${app.botToken}` } }],
    ["/api/", { method: "POST", body: "" }],
    ["/__fake/send", { method: "POST", body: "not json" }],
    ["/__fake/nope", { method: "GET" }],
    ["/nope", { method: "GET" }],
  ] as const) {
    const res = await fetch(`${fake.url}${path}`, init as RequestInit);
    expect(res.status).toBeLessThan(600);
    await res.text();
  }
  expect(await (await fetch(`${fake.url}/healthz`)).text()).toBe("ok");
});

test("until polls to a truthy value and times out with the given description", async () => {
  let n = 0;
  expect(await until(() => (++n > 2 ? "ready" : null), { intervalMs: 5, timeoutMs: 500 })).toBe("ready");
  await expect(until(() => false, { intervalMs: 5, timeoutMs: 30, what: "the impossible" })).rejects.toThrow(/the impossible/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test e2e/fake-slack/server.test.ts --coverage=false`
Expected: FAIL (modules do not exist).

- [ ] **Step 3: Implement the server**

`e2e/fake-slack/util.ts`:

```ts
export async function until<T>(
  fn: () => T | Promise<T>,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  const every = opts.intervalMs ?? 250;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${opts.what ?? "condition"}`);
    await new Promise((r) => setTimeout(r, every));
  }
}
```

`e2e/fake-slack/server.ts` (implement to the table above; shape, not every line, is prescribed):

```ts
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CallLog } from "./core/call-log";
import { blockActionsPayload, deliverEvent, deliverInteraction, messageEnvelope, type DeliverOptions } from "./core/inbound";
import { FaultStore, createWebApi, parseParams } from "./core/web-api";
import { SlackError, Workspace } from "./core/workspace";

export interface FakeSlack {
  url: string;
  port: number;
  ws: Workspace;
  log: CallLog;
  faults: FaultStore;
  stop(): Promise<void>;
}

export interface FakeSlackOptions {
  port?: number;
  host?: string;
  teamId?: string;
  /** Where gateways reach the fake (used for response_url). Default http://127.0.0.1:<port>. */
  publicUrl?: string;
  retryDelaysMs?: number[];
  ackTimeoutMs?: number;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function startFakeSlack(opts: FakeSlackOptions = {}): Promise<FakeSlack> {
  const ws = new Workspace(opts.teamId ?? "T0FAKE");
  const log = new CallLog();
  const faults = new FaultStore();
  const api = createWebApi(ws, log, faults);
  let publicUrl = opts.publicUrl ?? "";
  const deliverOpts: DeliverOptions = { retryDelaysMs: opts.retryDelaysMs, ackTimeoutMs: opts.ackTimeoutMs };

  const appOf = (id: unknown) => {
    const app = typeof id === "string" ? ws.apps.get(id) : undefined;
    if (!app) throw new HttpError(404, `unknown app ${String(id)}`);
    return app;
  };
  const channelOf = (id: unknown) => {
    if (typeof id !== "string" || !ws.channels.has(id)) throw new HttpError(404, "channel_not_found");
    return id;
  };
  const view = (m: { ts: string; user: string; text: string; blocks?: unknown; threadTs?: string }) => ({
    ts: m.ts, user: m.user, text: m.text, blocks: m.blocks, threadTs: m.threadTs,
  });

  async function control(req: http.IncomingMessage, res: http.ServerResponse, route: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const raw = method === "GET" || method === "DELETE" ? "" : await readBody(req);
    let body: Record<string, any> = {};
    if (raw) {
      try { body = JSON.parse(raw); } catch { throw new HttpError(400, "body is not JSON"); }
    }
    switch (`${method} ${route}`) {
      case "POST users": return send(res, 200, ws.addUser(body.id, body.name));
      case "POST apps": return send(res, 200, ws.addApp(body as any));
      case "GET apps": return send(res, 200, { apps: [...ws.apps.values()] });
      case "POST channels": return send(res, 200, { ...ws.addChannel(body as any), members: ws.members(body.id) });
      case "POST send": {
        const app = appOf(body.app);
        const channel = channelOf(body.channel);
        const text = `${body.mention ? `<@${app.botUserId}> ` : ""}${body.text}`;
        const msg = ws.post({ channel, user: body.user, text, threadTs: body.threadTs });
        const envelope = messageEnvelope(ws, app, msg, { eventId: body.eventId });
        const o = { ...deliverOpts, retryNum: body.retryNum };
        const url2 = `${body.target}/slack/events`;
        const deliveries = [await deliverEvent(url2, app.signingSecret, envelope, o)];
        if (body.duplicate) deliveries.push(await deliverEvent(url2, app.signingSecret, envelope, o));
        log.add({ kind: "inbound", method: "events", app: app.apiAppId, ok: true, status: 200, detail: { ts: msg.ts, channel, deliveries: deliveries.length } });
        return send(res, 200, { message: { ts: msg.ts, channel, threadTs: msg.threadTs }, deliveries });
      }
      case "POST click": {
        const app = appOf(body.app);
        const payload = blockActionsPayload({
          ws, app, user: body.user, channel: channelOf(body.channel), messageTs: body.messageTs,
          actionId: body.actionId, value: body.value, responseUrl: `${publicUrl}/response/${randomBytes(6).toString("hex")}`,
        });
        const delivery = await deliverInteraction(`${body.target}/slack/interactions`, app.signingSecret, payload, deliverOpts);
        log.add({ kind: "inbound", method: "interactions", app: app.apiAppId, ok: true, status: 200, detail: { actionId: body.actionId } });
        return send(res, 200, { delivery });
      }
      case "GET thread": return send(res, 200, { messages: ws.replies(url.searchParams.get("channel") ?? "", url.searchParams.get("threadTs") ?? "").map(view) });
      case "GET messages": return send(res, 200, { messages: ws.messages(url.searchParams.get("channel") ?? "").map(view) });
      case "GET calls": {
        const m = url.searchParams.get("method");
        const since = Number(url.searchParams.get("since") ?? 0);
        return send(res, 200, { calls: log.where((r) => (!m || r.method === m) && r.seq > since) });
      }
      case "DELETE calls": log.clear(); return send(res, 200, { ok: true });
      case "POST faults": faults.add(body as any); return send(res, 200, { ok: true });
      case "DELETE faults": faults.clear(); return send(res, 200, { ok: true });
      case "POST reset": {
        log.clear(); faults.clear();
        for (const id of ws.channels.keys()) for (const m of ws.messages(id)) ws.remove(id, m.ts);
        return send(res, 200, { ok: true });
      }
      default: throw new HttpError(404, `no control route ${method} ${route}`);
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    if (path === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    if (path.startsWith("/api/") && req.method === "POST") {
      const method = path.slice("/api/".length);
      const raw = await readBody(req);
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
      const r = api(method, parseParams(req.headers["content-type"] ?? null, raw), bearer);
      return send(res, r.status, r.body, r.headers);
    }
    if (path.startsWith("/response/") && req.method === "POST") {
      const raw = await readBody(req);
      let parsed: unknown = raw;
      try { parsed = JSON.parse(raw); } catch {}
      log.add({ kind: "response_url", method: "response_url", ok: true, status: 200, detail: { id: path.slice("/response/".length), body: parsed } });
      return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    }
    if (path.startsWith("/__fake/")) return control(req, res, path.slice("/__fake/".length), url);
    throw new HttpError(404, `no route ${req.method} ${path}`);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (e instanceof HttpError) return send(res, e.status, { ok: false, error: e.message });
      if (e instanceof SlackError) return send(res, 400, { ok: false, error: e.code });
      send(res, 500, { ok: false, error: `fake-slack failure: ${String(e)}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;
  if (!publicUrl) publicUrl = `http://127.0.0.1:${port}`;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    ws,
    log,
    faults,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
```

`e2e/fake-slack/control-client.ts`: a typed wrapper where each method `fetch`es the matching route, JSON-encodes the body, throws `new Error(`${status} ${error}`)` on a non-2xx (the tests match `/unknown app/` and `/channel_not_found/`), and returns parsed JSON. Signatures: `addUser({id, name})`, `addApp({apiAppId, name, botUserId?}): Promise<{apiAppId, botToken, signingSecret, botUserId, name}>`, `addChannel({id, name, isIm?, members?})`, `send({...}): Promise<{message: {ts, channel, threadTs?}, deliveries: DeliveryResult[]}>`, `click({...}): Promise<{delivery: DeliveryResult}>`, `thread(channel, threadTs)`, `messages(channel)`, `calls(filter?: {method?, since?}): Promise<{calls: CallRecord[]}>`, `clearCalls()`, `addFault({...})`, `clearFaults()`, `reset()`. Import the shared types from `./core/*` with `import type`.

`e2e/fake-slack/main.ts`:

```ts
import { startFakeSlack } from "./server";

const port = Number(process.env.PORT ?? 8080);
const delays = (process.env.FAKE_SLACK_RETRY_DELAYS ?? "0,60000,300000").split(",").map(Number);
const running = await startFakeSlack({
  port,
  publicUrl: process.env.FAKE_SLACK_PUBLIC_URL,
  teamId: process.env.FAKE_SLACK_TEAM_ID,
  retryDelaysMs: delays,
});
console.log(`fake-slack listening on ${running.port}`);

const shutdown = () => void running.stop().finally(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

- [ ] **Step 4: Run tests, typecheck, and the whole fake-slack suite with coverage**

Run: `bun test e2e/fake-slack && bun run typecheck`
Expected: all PASS. `main.ts` is not loaded in-process; `server.ts`, `control-client.ts`, `util.ts` and `core/*` should each show high coverage. If the real `WebClient` rejects a response shape, fix the fake to match the SDK (the SDK is the ground truth). Add tests for any uncovered branch rather than lowering thresholds.

- [ ] **Step 5: Commit**

```bash
git add e2e/fake-slack/server.ts e2e/fake-slack/control-client.ts e2e/fake-slack/main.ts e2e/fake-slack/util.ts e2e/fake-slack/server.test.ts
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "feat(e2e): fake Slack HTTP server, control API and client"
```

---

### Task 6: The real gateway against the fake, in-process

This is the fidelity test: the real `createGateway` on the real HTTP transport, a stub agent, and the fake Slack on the other side. It discovers which Slack methods slaude really calls, and proves signing, dispatch, dedup, retries and the approval click without any cluster.

**Files:**
- Create: `e2e/fake-slack/gateway.test.ts`
- Modify: `e2e/fake-slack/core/web-api.ts` (add any method the test proves the gateway uses; keep `KNOWN_METHODS` in sync with its test)

**Interfaces:**
- Consumes: Tasks 1 to 5; `createGateway`, `GatewayHandle` (`src/gateway/core/gateway.ts`), `createHttpSlackTransport` (`src/gateway/slack/http-transport.ts`), `StubAgent` (`src/gateway/sim/stub-agent.ts`), `WORLD` and `writeSoulFixture` (`src/gateway/sim/soul-fixture.ts`), `encrypt` and `__resetMasterKeyCache` (`src/db/crypto.ts`).
- Produces: a green end-to-end proof, plus the final list of implemented methods.

- [ ] **Step 1: Write the test**

`e2e/fake-slack/gateway.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { __resetMasterKeyCache, encrypt } from "../../src/db/crypto";
import { createGateway, type GatewayHandle } from "../../src/gateway/core/gateway";
import { StubAgent } from "../../src/gateway/sim/stub-agent";
import { WORLD, writeSoulFixture } from "../../src/gateway/sim/soul-fixture";
import { createHttpSlackTransport, type HttpSlackTransport } from "../../src/gateway/slack/http-transport";
import type { SlackAppRow } from "../../src/db/slack-apps";
import { createControlClient } from "./control-client";
import { startFakeSlack, type FakeSlack } from "./server";
import { until } from "./util";

let fake: FakeSlack;
let ctl: ReturnType<typeof createControlClient>;
let transport: HttpSlackTransport;
let handle: GatewayHandle;
let agent: StubAgent;
let app: Awaited<ReturnType<typeof ctl.addApp>>;
let base: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ["SLAUDE_MASTER_KEY", "SLAUDE_SLACK_API_URL", "SLACK_BOT_TOKEN"]) saved[k] = process.env[k];
  process.env.SLAUDE_MASTER_KEY = randomBytes(32).toString("base64");
  __resetMasterKeyCache();

  fake = await startFakeSlack({ port: 0, retryDelaysMs: [0, 0, 0], ackTimeoutMs: 1000 });
  process.env.SLAUDE_SLACK_API_URL = `${fake.url}/api`;
  ctl = createControlClient(fake.url);
  app = await ctl.addApp({ apiAppId: "A0FAKE", name: "agent", botUserId: "U0BOT" });
  process.env.SLACK_BOT_TOKEN = app.botToken;
  for (const [id, name] of [["U0MGR", "manager"], ["U0APP", "approver"], ["U0ALICE", "alice"]] as const) await ctl.addUser({ id, name });
  await ctl.addChannel({ id: "D0MGR", name: "dm-mgr", isIm: true, members: ["U0MGR", "U0BOT"] });
  await ctl.addChannel({ id: "C0TEAM", name: "team", members: ["U0MGR", "U0APP", "U0ALICE", "U0BOT"] });

  writeSoulFixture(WORLD); // manager U0MGR, approver U0APP, trusted C0TEAM

  const row: SlackAppRow = {
    api_app_id: app.apiAppId,
    team_id: "T0FAKE",
    tenant_id: "default",
    persona_id: "default",
    bot_token: encrypt(app.botToken),
    signing_secret: encrypt(app.signingSecret),
    bot_user_id: app.botUserId,
    created_at: 1,
    updated_at: 1,
  };
  transport = createHttpSlackTransport({ port: 0, loadApps: async () => [row], log: () => {} });
  agent = new StubAgent();
  handle = createGateway(agent, transport);
  agent.attachGateway(handle);
  await handle.start();
  base = `http://127.0.0.1:${transport.port}`;
}, 60_000);

afterAll(async () => {
  await handle?.stop();
  await fake?.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetMasterKeyCache();
});

beforeEach(async () => {
  agent.setBehavior("reply");
  await ctl.reset();
});

const botMessages = async (channel: string) =>
  (await ctl.messages(channel)).messages.filter((m) => m.user === "U0BOT");

describe("real gateway + HTTP transport + fake Slack", () => {
  test("a DM from the manager gets a reply through the Web API", async () => {
    const sent = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "hello", target: base });
    expect(sent.deliveries[0]!.finalStatus).toBe(200);
    const reply = await until(async () => (await botMessages("D0MGR")).find((m) => m.text.includes("ack: done")), { what: "the bot's reply" });
    expect(reply.text).toContain("ack: done");
  });

  test("a channel @mention from an allowed user gets a reply", async () => {
    await ctl.send({ app: "A0FAKE", channel: "C0TEAM", user: "U0ALICE", text: "status?", target: base, mention: true });
    await until(async () => (await botMessages("C0TEAM")).find((m) => m.text.includes("ack: done")), { what: "the channel reply" });
  });

  test("a duplicate delivery of the same event, and a Slack retry of it, produce one reply", async () => {
    const sent = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "dedup me", target: base, duplicate: true, eventId: "Ev0DEDUP" });
    expect(sent.deliveries).toHaveLength(2);
    await until(async () => (await botMessages("D0MGR")).length >= 1, { what: "first reply" });
    await new Promise((r) => setTimeout(r, 500)); // room for a wrongly processed second copy
    const replies = (await botMessages("D0MGR")).filter((m) => m.text.includes("ack: done"));
    expect(replies).toHaveLength(1);
  });

  test("the same message ts under a NEW event id is still one reply (dedup is by channel and ts)", async () => {
    const first = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "same ts", target: base, eventId: "Ev0ONE" });
    await until(async () => (await botMessages("D0MGR")).length >= 1, { what: "first reply" });
    // Re-deliver the identical message as a distinct event: reuse the stored message by posting nothing new.
    await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "same ts", target: base, eventId: "Ev0TWO", redeliverTs: first.message.ts } as any);
    await new Promise((r) => setTimeout(r, 500));
    expect((await botMessages("D0MGR")).filter((m) => m.text.includes("ack: done"))).toHaveLength(1);
  });

  test("an approval card is posted with buttons, a click resolves it exactly once, and the agent continues", async () => {
    agent.setBehavior("request_approval");
    await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "deploy prod", target: base });
    const card = await until(
      async () => (await botMessages("D0MGR")).find((m) => JSON.stringify(m.blocks ?? []).includes("slaude_appr:approve:")),
      { what: "the approval card" },
    );
    const actionId = /slaude_appr:approve:[A-Za-z0-9_-]+/.exec(JSON.stringify(card.blocks))![0];
    const click = await ctl.click({ app: "A0FAKE", target: base, user: "U0APP", channel: "D0MGR", messageTs: card.ts, actionId });
    expect(click.delivery.finalStatus).toBe(200);
    await until(async () => (await botMessages("D0MGR")).find((m) => m.text.includes("approved by <@U0APP>")), { what: "the post-approval reply" });
    // a second click on the same card is answered as stale through response_url, not applied again
    await ctl.click({ app: "A0FAKE", target: base, user: "U0APP", channel: "D0MGR", messageTs: card.ts, actionId });
    await until(async () => (await ctl.calls({ method: "response_url" })).calls.length >= 1, { what: "the stale-click response" });
    expect((await botMessages("D0MGR")).filter((m) => m.text.includes("approved by"))).toHaveLength(1);
  });

  test("a Slack 429 on chat.postMessage does not lose the reply", async () => {
    await ctl.addFault({ method: "chat.postMessage", status: 429, retryAfterSec: 1, times: 1 });
    await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "rate limited", target: base });
    await until(async () => (await botMessages("D0MGR")).find((m) => m.text.includes("ack: done")), { timeoutMs: 20_000, what: "the reply after a 429" });
  });

  test("the gateway only ever calls Web API methods the fake implements", async () => {
    await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "one more", target: base });
    await until(async () => (await botMessages("D0MGR")).length >= 1, { what: "reply" });
    const unknown = (await ctl.calls()).calls.filter((c) => c.unknown);
    expect(unknown.map((c) => c.method)).toEqual([]);
  });
});
```

Notes for the implementer (not placeholders; these are known unknowns to resolve against the real code):
- `redeliverTs` in the "same ts, new event id" test is a control-API addition this test needs: `POST /__fake/send` with `redeliverTs` must NOT post a new message but build the envelope from the existing message with that `ts` and the given `eventId`. Add it to the server (small), its client type, and a `server.test.ts` case, then remove the `as any` cast.
- If `handle.start()` or the first turn calls Slack methods outside `KNOWN_METHODS`, the final test fails with their names. For each, add a handler to `web-api.ts` that returns what the real gateway needs (look at how the call's result is used), add a unit test in `web-api.test.ts`, and keep the `KNOWN_METHODS` test green. Do not add a method the gateway does not call.
- If the stub agent's reply is posted differently than assumed (for example the DM reply goes to a synthetic thread), loosen the assertions to the behaviour (a bot message containing `ack: done` exists in the channel) but keep the "exactly one" assertions strict.
- If a test needs gateway state reset between cases (the in-memory seen-events set persists across tests in one process), use fresh message text and ts per case, which `send` already does.
- Do not weaken the dedup or exactly-once assertions to get green; if a duplicate reply is real, that is a finding to report.

- [ ] **Step 2: Run, discover, fix the fake, repeat**

Run: `bun test e2e/fake-slack/gateway.test.ts --coverage=false`
Expected: initially some failures that name unknown methods or wrong response shapes; iterate on the fake (not the gateway) until all pass.

- [ ] **Step 3: Run the whole fake-slack suite with coverage and typecheck**

Run: `bun test e2e/fake-slack && bun run typecheck`
Expected: PASS; every file under `e2e/fake-slack/` (except `main.ts`) well covered. Add tests for any uncovered branch.

- [ ] **Step 4: Run the repo's own Slack and gateway tests to prove the seam changed nothing**

Run: `bun test tests/gateway tests/config.test.ts --coverage=false`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e/fake-slack
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "test(e2e): drive the real gateway through the fake Slack, including dedup and approvals"
```

---

### Task 7: Spec guard against the archived Slack OpenAPI (gated)

**Gate:** start with Step 1. If the licence is not permissive, or the spec cannot be fetched, stop, report BLOCKED with the evidence, and the controller will rule (the guard is valuable but optional; Tasks 8 to 11 do not depend on it).

**Files:**
- Create: `scripts/vendor-slack-schemas.ts`
- Create: `e2e/fake-slack/schemas/methods.json` (generated, small, with the source commit SHA recorded)
- Create: `e2e/fake-slack/core/schema-guard.ts`
- Modify: `e2e/fake-slack/core/web-api.ts` (optional `guard` argument), `e2e/fake-slack/server.ts` (`strictSchemas` option), `e2e/fake-slack/gateway.test.ts` (turn it on)
- Test: `e2e/fake-slack/core/schema-guard.test.ts`

**Interfaces:**
- Produces: `createSchemaGuard(schemas: MethodSchemas): { checkRequest(method: string, params: Record<string, unknown>): string[]; checkResponse(method: string, body: Record<string, unknown>): string[] }` where each returned string is a violation message (empty array = clean). `MethodSchemas` is `Record<string, { params: string[]; required: string[]; response: string[] }>`.

- [ ] **Step 1: Check the licence and fetch the spec**

Run: `gh api repos/slackapi/slack-api-specs --jq '{license: .license.spdx_id, archived: .archived, default: .default_branch}'` and `gh api repos/slackapi/slack-api-specs/commits/HEAD --jq .sha`
Expected: a permissive SPDX id (MIT, Apache-2.0, BSD-*). Anything else, or `null`: stop and report BLOCKED. Record the commit SHA. Locate the Web API OpenAPI 2.0 file in the repository's `web-api/` directory (`gh api repos/slackapi/slack-api-specs/contents/web-api`).

- [ ] **Step 2: Write the failing guard tests**

`e2e/fake-slack/core/schema-guard.test.ts` — with a tiny inline `MethodSchemas` fixture (`chat.postMessage`: params `["channel","text","thread_ts","blocks"]`, required `["channel"]`, response `["ok","channel","ts","message","error"]`):

```ts
import { expect, test } from "bun:test";
import { createSchemaGuard } from "./schema-guard";

const guard = createSchemaGuard({
  "chat.postMessage": { params: ["channel", "text", "thread_ts", "blocks"], required: ["channel"], response: ["ok", "channel", "ts", "message", "error"] },
});

test("a valid request is clean", () => {
  expect(guard.checkRequest("chat.postMessage", { channel: "C1", text: "x" })).toEqual([]);
});
test("an unknown parameter name is a violation", () => {
  expect(guard.checkRequest("chat.postMessage", { channel: "C1", txt: "x" })).toEqual(['chat.postMessage: unknown parameter "txt"']);
});
test("a missing required parameter is a violation", () => {
  expect(guard.checkRequest("chat.postMessage", { text: "x" })).toEqual(['chat.postMessage: missing required parameter "channel"']);
});
test("the token parameter is always allowed", () => {
  expect(guard.checkRequest("chat.postMessage", { channel: "C1", token: "t" })).toEqual([]);
});
test("an unknown response property is a violation", () => {
  expect(guard.checkResponse("chat.postMessage", { ok: true, ts: "1", bogus: 1 })).toEqual(['chat.postMessage: unknown response property "bogus"']);
});
test("methods without a schema are not judged", () => {
  expect(guard.checkRequest("assistant.threads.setStatus", { anything: 1 })).toEqual([]);
  expect(guard.checkResponse("assistant.threads.setStatus", { ok: true, anything: 1 })).toEqual([]);
});
```

Run: `bun test e2e/fake-slack/core/schema-guard.test.ts --coverage=false` — Expected: FAIL.

- [ ] **Step 3: Implement the guard and wire it in**

`schema-guard.ts` implements exactly the behaviour above (violation strings as in the tests; `token` always allowed; methods absent from the schema map are skipped; response `ok` and `error` always allowed). In `createWebApi`, add an optional fourth argument `guard?: SchemaGuard`; when present, run `checkRequest` before dispatching and `checkResponse` on the body, and record violations in the call-log row as `schemaViolations: string[]` (add the optional field to `CallRecord`). In `startFakeSlack`, add `strictSchemas?: MethodSchemas`; when provided, create the guard and pass it. In `gateway.test.ts`, load `schemas/methods.json`, pass it as `strictSchemas`, and add an assertion to the final test that no call-log row has non-empty `schemaViolations`. Add `web-api.test.ts` cases proving violations are recorded and do not change the response.

- [ ] **Step 4: Generate the vendored subset**

`scripts/vendor-slack-schemas.ts` reads the OpenAPI 2.0 JSON (path or URL argument), and for each method in `KNOWN_METHODS` extracts: the parameter names (from the operation's `parameters`, excluding `token`), the required ones, and the top-level response property names (from the 200 response schema; for `oneOf`/`anyOf` unions, the union of all branches' properties). It writes `e2e/fake-slack/schemas/methods.json` with a header `{ "source": "slackapi/slack-api-specs", "commit": "<sha>", "license": "<spdx>", "methods": {...} }`. Run it against the fetched file, review the diff by eye, then run `bun test e2e/fake-slack` with the guard on in `gateway.test.ts`.
Expected: either PASS (the gateway sends only documented parameters) or violations naming real divergences. For each violation decide whether the spec is stale (an archived spec lags real Slack) or slaude is wrong; if the spec is stale, add the parameter to a small `allowExtra` map in the vendored file with a comment explaining why, and report it. Never silence by weakening the guard.

- [ ] **Step 5: Run everything and commit**

Run: `bun test e2e/fake-slack && bun run typecheck`
Expected: PASS.

```bash
git add scripts/vendor-slack-schemas.ts e2e/fake-slack
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "feat(e2e): validate fake Slack traffic against vendored Slack OpenAPI schemas"
```

The vendored `methods.json` is a derivative of the licensed spec: keep the header (source, commit, licence) in the file and mention the attribution in `e2e/fake-slack/README.md` (Task 11).

---

## Part B: the cluster harness

Part B cannot be fully proven by unit tests. Each task ends with a concrete command to run against a real local cluster (minikube). If minikube or Docker is unavailable in the environment, report BLOCKED with the exact missing prerequisite rather than faking the verification. The first cluster bring-up is also a discovery step: expect small fixes in manifests and scripts.

### Task 8: Images, deploy overlay, and bring-up wrapper

**Files:**
- Create: `e2e/fake-slack/Dockerfile`
- Create: `scripts/build-e2e-images.sh`
- Create: `e2e/k8s/kustomization.yaml`, `e2e/k8s/mock-llm.yaml`, `e2e/k8s/fake-slack.yaml`
- Create: `e2e/up.sh`
- Modify: `deploy/k8s-local/up.sh` (one new env var, `SLAUDE_LOCAL_OVERLAY`)
- Test: `e2e/k8s/render.test.ts` (renders the overlay and asserts its shape; no cluster needed)

**Interfaces:**
- Consumes: `scripts/build-mock-llm.sh` (Plan 1), `e2e/fake-slack/main.ts` (Task 5).
- Produces: images `slaude-mock-llm:dev` and `slaude-fake-slack:dev` inside minikube; Services `mock-llm:8080` and `fake-slack:8080` in namespace `slaude-scale`; the gateway/node pods configured with `SLAUDE_SLACK_API_URL=http://fake-slack:8080/api/` and (via `up.sh`'s provider env) `ANTHROPIC_BASE_URL=http://mock-llm:8080` plus a dummy key; `e2e/up.sh` as the single bring-up command.

- [ ] **Step 1: Dockerfile and image build script**

`e2e/fake-slack/Dockerfile` — same shape as `e2e/mock-llm/Dockerfile` (`node:22-alpine`, `COPY main.mjs`, `ENV PORT=8080`, `EXPOSE 8080`, `USER node`, `HEALTHCHECK` on `/healthz`, `CMD ["node","main.mjs"]`).

`scripts/build-e2e-images.sh` (executable, `set -euo pipefail`): for each of `mock-llm` and `fake-slack`, `bun build e2e/<name>/main.ts --target=node --outfile dist/<name>/main.mjs`, copy the Dockerfile next to it, then build into minikube with `minikube -p "${SLAUDE_LOCAL_PROFILE:-slaude-local}" image build -t slaude-<name>:dev dist/<name>`. Print the two image names. Note `fake-slack/main.ts` imports `src/gateway/slack/verify.ts`; the bundler inlines it, so the image needs no `src/`.

- [ ] **Step 2: The overlay**

`e2e/k8s/mock-llm.yaml`: a Deployment `mock-llm` with **replicas: 1** (fault attempt counting is per process), image `slaude-mock-llm:dev`, `imagePullPolicy: Never`, port 8080, readiness and liveness on `/healthz`, small resources; and a `Service` `mock-llm` on 8080. `e2e/k8s/fake-slack.yaml`: the same shape for `slaude-fake-slack:dev`, **replicas: 1** (in-memory state), env `FAKE_SLACK_PUBLIC_URL=http://fake-slack:8080`, `FAKE_SLACK_RETRY_DELAYS=0,2000,5000` (compressed retries), and a `Service` `fake-slack`.

`e2e/k8s/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: slaude-scale
resources:
  - ../../deploy/k8s-local
  - mock-llm.yaml
  - fake-slack.yaml
patches:
  - patch: |-
      apiVersion: v1
      kind: ConfigMap
      metadata:
        name: slaude-scale-config
        namespace: slaude-scale
      data:
        SLAUDE_SLACK_API_URL: "http://fake-slack:8080/api/"
```

Before finalising, read `deploy/k8s-scale/40-gateway.yaml` and `50-node.yaml` to confirm both tiers read `slaude-scale-config` (via `envFrom`); if a tier does not, patch its container env instead. Confirm that `ANTHROPIC_BASE_URL` from `provider.env` reaches the node pods (the secret is generated by `up.sh`).

- [ ] **Step 3: The `up.sh` hook**

In `deploy/k8s-local/up.sh`, where it runs `kubectl kustomize --load-restrictor LoadRestrictionsNone "$HERE" | kubectl apply -f -`, replace `"$HERE"` with `"${SLAUDE_LOCAL_OVERLAY:-$HERE}"` and document the variable in the script's header comment and in `deploy/k8s-local/README.md` (one line: "apply a different overlay that builds on this one; used by the e2e suite"). Nothing else in the script changes; with the variable unset behaviour is identical.

- [ ] **Step 4: The wrapper**

`e2e/up.sh` (executable, `set -euo pipefail`):

```bash
#!/usr/bin/env bash
# Bring up the scale topology with the mock LLM and the fake Slack on a local minikube.
# Needs no model or Slack credentials. Re-runnable.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${SLAUDE_LOCAL_PROFILE:-slaude-local}"

# The cluster must exist before images can be built into it; up.sh starts it. Start it first
# (idempotent), build the e2e images, then let up.sh build the app image and apply our overlay.
if ! minikube -p "$PROFILE" status --format '{{.Host}}' 2>/dev/null | grep -q Running; then
  minikube start -p "$PROFILE" --driver=docker --cpus="${SLAUDE_LOCAL_CPUS:-3}" --memory="${SLAUDE_LOCAL_MEMORY:-3500}"
fi
"$ROOT/scripts/build-e2e-images.sh"

ANTHROPIC_BASE_URL="http://mock-llm:8080" \
ANTHROPIC_API_KEY="sk-mock" \
SLAUDE_LOCAL_OVERLAY="$ROOT/e2e/k8s" \
  "$ROOT/deploy/k8s-local/up.sh"

kubectl -n slaude-scale rollout status deploy/mock-llm deploy/fake-slack --timeout=300s
echo "e2e stack ready: mock-llm and fake-slack are up in namespace slaude-scale"
```

If starting minikube here conflicts with how `up.sh` profiles/validates an existing cluster (it checks cpu/memory against its own defaults), instead make `up.sh` the only thing that starts the cluster and build the e2e images after it with `kubectl` applying the overlay in a second pass. Choose whichever works on a real run and explain it in the script header.

- [ ] **Step 5: Render test (no cluster)**

`e2e/k8s/render.test.ts` runs `kubectl kustomize --load-restrictor LoadRestrictionsNone e2e/k8s` (skip the test with a clear message if `kubectl` is not on PATH, but note that `deploy/k8s-local/secrets.env` and `provider.env` must exist for the base to render; create empty placeholder files in the test's temp copy if needed, or instead assert on `e2e/k8s/*.yaml` directly with a YAML parse). Assert: `mock-llm` and `fake-slack` Deployments exist with `replicas: 1`; Services named `mock-llm` and `fake-slack` expose 8080; the ConfigMap patch sets `SLAUDE_SLACK_API_URL` to a value ending in `/api/`; neither image uses `imagePullPolicy` other than `Never`. Use the repo's `yaml` dependency.

- [ ] **Step 6: Bring up the stack for real and record the result**

Run: `e2e/up.sh`, then `kubectl -n slaude-scale get pods`.
Expected: gateway x2, node x2, postgres, redis, `mock-llm` x1, `fake-slack` x1 all Ready. Then run `kubectl -n slaude-scale exec deploy/fake-slack -- wget -qO- http://127.0.0.1:8080/healthz` (prints `ok`) and `kubectl -n slaude-scale exec deploy/slaude-gateway -c gateway -- env | grep SLAUDE_SLACK_API_URL` (shows the fake's URL). Record the outputs in the report. Clean up with `deploy/k8s-local/down.sh` only if you started the cluster for this task.

- [ ] **Step 7: Typecheck, test, commit**

Run: `bun run typecheck && bun test e2e/k8s --coverage=false`

```bash
git add e2e/fake-slack/Dockerfile scripts/build-e2e-images.sh e2e/k8s e2e/up.sh deploy/k8s-local/up.sh deploy/k8s-local/README.md
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "feat(e2e): deploy the mock LLM and fake Slack on the local scale cluster"
```

---

### Task 9: Persona seeding inside the cluster

A gateway needs three things before a Slack message can become a turn: a `SOUL.md` on the shared volume that contains the `Persona-ID:` marker, the structured soul data (the gateway extracts it with an LLM call, which the mock LLM would answer with garbage, so the cache file is seeded instead), and the app registered in `slack_apps`.

**Files:**
- Create: `e2e/harness/in-pod/seed-persona.ts`
- Modify: `tsconfig.json` (add `e2e/harness/in-pod` to `exclude`, mirroring `deploy/k8s-local/probe`)
- Create: `e2e/harness/kube.ts` (kubectl helpers used here and in Task 10)
- Test: `e2e/harness/kube.test.ts`

**Interfaces:**
- Consumes: `writeSoulFixture`, `WORLD` (`src/gateway/sim/soul-fixture.ts`), `loadSoul`/`loadSoulData`/`soulData` (`src/soul/*`), `paths` (`src/config/home.ts`), and the `slack-app add` CLI (`src/cli/slack-app.ts`).
- Produces (`kube.ts`): `kubectl(args: string[], opts?: { input?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number }>` (namespace `slaude-scale`, context from `SLAUDE_LOCAL_PROFILE`, default `slaude-local`); `podNames(component: "gateway" | "node"): Promise<string[]>`; `podIps(component): Promise<Record<string, string>>`; `execIn(target: string, container: string, cmd: string[], opts?)`; `copyTo(pod: string, container: string, localPath: string, remotePath: string)`; `portForward(target: string, localPort: number, remotePort: number): Promise<{ stop(): void }>` (resolves when the forward accepts connections); `killContainer(pod: string, container: string): Promise<void>` (SIGKILL through the container runtime, copied from `deploy/k8s-local/verify-ha.sh`'s `crash`). Consumed by Task 10 and Plan 3.
- Produces (`seed-persona.ts`): when run in a pod as `bun /tmp/seed-persona.ts --persona-id alpha --api-app-id A0FAKE --team-id T0FAKE --bot-token ... --signing-secret ... --bot-user-id U0BOT`, it (1) writes `$SLAUDE_HOME/SOUL.md` from the sim `WORLD` fixture plus a trailing `Persona-ID: <id>` line, (2) writes the matching `cache/soul.<sha>.json`, (3) runs the `slack-app add` logic, (4) self-verifies and exits non-zero on any failure.

- [ ] **Step 1: `kube.ts` and its unit test**

Implement the helpers with `Bun.spawn`. `kube.test.ts` tests only the pure parts without a cluster: command construction (a `buildKubectlArgs(args)` helper that prepends `--context <profile> -n slaude-scale`) and parsing of `kubectl get pod -o json` output into names and IPs (`parsePods(json, component)`), using inline sample JSON. Export those two pure helpers for the test.

- [ ] **Step 2: Write `seed-persona.ts`**

Header comment: it runs INSIDE a pod, imports the image's own `/app/src/...` paths (like `deploy/k8s-local/probe/turns.ts`), and is verified by running it. Steps in order:

1. Parse the flags above.
2. `writeSoulFixture(WORLD)` (writes `SOUL.md` and sets the in-memory soul data), then append `\nPersona-ID: <id>\n` to `paths.soul`.
3. Compute `sha = createHash("sha256").update(loadSoul()).digest("hex").slice(0, 16)` and write `soulData()` as JSON to `join(paths.home, "cache", `soul.${sha}.json`)` (create the directory). This mirrors `src/soul/extract.ts`, whose `sha256` and `cachePath` are private; add a comment naming that file so a drift is findable.
4. Register the app by importing and calling `main(["add", "--api-app-id", ..., "--team-id", ..., "--bot-token", ..., "--signing-secret", ..., "--bot-user-id", ..., "--persona", id], {})` from `/app/src/cli/slack-app.ts` (it returns an exit code; check it).
5. Self-verify: `__resetSoulDataMemo()`, set `ANTHROPIC_BASE_URL=http://127.0.0.1:1` so any extraction attempt fails, `await loadSoulData()`, and require `manager.userId === "U0MGR"` (the regex fallback never fills the manager, so this proves the cache hit). Exit 1 with a message otherwise.

- [ ] **Step 3: Verify on the running stack**

With the Task 8 stack up: register a fake app through the control API (port-forward the `fake-slack` Service to a local port with `portForward`), then `copyTo` the script into a gateway pod and run it with those credentials via `execIn`. Expected: exit 0 and the printed `registered A0FAKE/T0FAKE` line. Then confirm the soul is visible to a node pod too: `kubectl -n slaude-scale exec <node-pod> -c node -- sh -c 'tail -n 2 $SLAUDE_HOME/SOUL.md; ls $SLAUDE_HOME/cache'` (shows the `Persona-ID:` line and the cache file). Record outputs in the report.

- [ ] **Step 4: Typecheck, test, commit**

Run: `bun run typecheck && bun test e2e/harness --coverage=false`

```bash
git add e2e/harness tsconfig.json
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "feat(e2e): kubectl helpers and in-pod persona seeding for the cluster harness"
```

---

### Task 10: Baseline round trip on the cluster

**Files:**
- Create: `e2e/ha/driver.ts` (setup shared by all cluster cases)
- Create: `e2e/ha/echo.e2e.ts`
- Test: itself (it is the cluster test)

**Interfaces:**
- Consumes: `createControlClient` and `until` (Task 5); `kubectl`, `podIps`, `portForward`, `copyTo`, `execIn` (Task 9).
- Produces (`driver.ts`): `setupSuite(): Promise<Suite>` where `Suite = { fake: ControlClient; gatewayUrl: string; gatewayPodUrls: string[]; app: {...}; newChannel(): Promise<string>; teardown(): Promise<void> }` — port-forwards the fake's control API, registers one fake app and the manager user, seeds the persona (Task 9), and returns handles. `newChannel()` creates a uniquely named DM channel per case (the Review Focus "state leaking" guard). Plan 3 reuses this.

- [ ] **Step 1: Write the driver and the baseline case**

`echo.e2e.ts` (run by name, never discovered by root `bun test`):

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { until } from "../fake-slack/util";
import { setupSuite, type Suite } from "./driver";

let suite: Suite;
beforeAll(async () => { suite = await setupSuite(); }, 300_000);
afterAll(async () => { await suite?.teardown(); });

test("a DM tagged echo gets the persona-labelled reply through gateway, node, mock LLM and back", async () => {
  const channel = await suite.newChannel();
  const text = `[[mock:echo]] round trip ${Date.now()}`;
  await suite.fake.send({ app: suite.app.apiAppId, channel, user: "U0MGR", text, target: suite.gatewayUrl });
  const reply = await until(
    async () => (await suite.fake.messages(channel)).messages.find((m) => m.user === suite.app.botUserId && m.text.includes("[alpha]")),
    { timeoutMs: 120_000, what: "the echo reply" },
  );
  expect(reply.text).toContain("[alpha]");
  expect(reply.text).toContain("round trip");
  expect(reply.text).not.toContain("[[mock:");           // tags never come back
  const replies = (await suite.fake.messages(channel)).messages.filter((m) => m.user === suite.app.botUserId && m.text.includes("[alpha]"));
  expect(replies).toHaveLength(1);                        // exactly one final reply
  const unknown = (await suite.fake.calls()).calls.filter((c) => c.unknown);
  expect(unknown).toEqual([]);                            // no Slack method the fake lacks
});
```

`setupSuite` details: choose a free local port, `portForward("svc/fake-slack", port, 8080)`, build `createControlClient("http://127.0.0.1:<port>")`; add the manager user and a persona app (random credentials come back from `addApp`); seed with `seed-persona.ts` (Task 9); `gatewayUrl = "http://slaude-gateway:8080"` (the fake runs in-cluster, so it reaches the Service by DNS; `gatewayPodUrls` come from `podIps("gateway")` for Plan 3's replica-targeted cases). `teardown` stops the port-forward. If the Service name or port differs, read `deploy/k8s-scale/40-gateway.yaml`.

- [ ] **Step 2: Run it against the real stack and diagnose**

Run: `bun test e2e/ha/echo.e2e.ts --timeout 300000`
Expected: PASS. This is the first time every piece runs together, so expect to debug. Likely issues, in order: the soul not loaded on the node (check the shared volume and the cache file); the gateway rejecting the event (check its log for a signature or `unknown app` line; `kubectl logs deploy/slaude-gateway`); the CLI turn failing against the mock (check `kubectl logs deploy/slaude-node` and the mock's `GET /__mock/journal` through a port-forward); the reply format (the echo text includes the user message envelope, which is why the assertions use `toContain`). Fix at the right layer; if the fix is in Plan 1's code (for example the mock mishandling a request the real CLI sends), fix it there with a test first and report it prominently as a separate commit. Do not weaken assertions: "exactly one reply" and "no unknown Slack method" stay strict.

- [ ] **Step 3: Run it twice in a row to prove isolation**

Run the command again immediately without restarting anything.
Expected: PASS again (the unique channel and message text per case mean the second run is independent of the first).

- [ ] **Step 4: Commit**

```bash
git add e2e/ha
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "test(e2e): baseline DM round trip on the scale cluster with mock LLM and fake Slack"
```

---

### Task 11: One command, a workflow, and docs

**Files:**
- Create: `scripts/e2e-ha.sh`
- Create: `.github/workflows/e2e-ha.yml`
- Create: `e2e/fake-slack/README.md`
- Create: `docs/site/_content/field-notes/2026-10-01-fake-slack-for-the-ha-suite.md`
- Modify: `CLAUDE.md` (one index line at the top of the Findings Log list)

**Interfaces:**
- Produces: `scripts/e2e-ha.sh [test-file...]` — brings the stack up (idempotent), runs the named `*.e2e.ts` files (default: every `e2e/ha/*.e2e.ts`), collects diagnostics on failure into `${E2E_ARTIFACTS:-dist/e2e-artifacts}` (pod logs for gateway, node, mock-llm, fake-slack; the mock-LLM journal; the fake's call log and all channel messages), and exits with the tests' status. It does not tear the cluster down unless `E2E_TEARDOWN=1`.

- [ ] **Step 1: The script**

Write `scripts/e2e-ha.sh` (executable, `set -uo pipefail`): `e2e/up.sh`; run `bun test <files> --timeout 300000`; remember the exit code; on non-zero, dump `kubectl logs --all-containers --prefix` for each deployment, port-forward the mock and fake briefly and `curl` their journal and call-log endpoints into the artifacts directory; honour `E2E_TEARDOWN`; exit with the saved code. Run `deploy/k8s-local/verify-ha.sh` and `verify-turns.sh` first when `E2E_SANITY=1` (the spec's cluster-sanity step; off by default locally, on in the workflow).

- [ ] **Step 2: The workflow**

`.github/workflows/e2e-ha.yml`: trigger `workflow_dispatch` only for now (inputs: `files`, space-separated test files; `sanity`, boolean, default true); `concurrency: { group: e2e-ha, cancel-in-progress: false }`; `permissions: contents: read`; one job on `ubuntu-latest`, `timeout-minutes: 60`. Steps: checkout; set up Bun the same way `.github/workflows/ci.yml` does (copy its action and version pins exactly); `bun install --frozen-lockfile`; install `kubectl` and `minikube` from their official release URLs with a pinned version and checksum verification (no third-party setup actions); `E2E_SANITY=1 E2E_ARTIFACTS=$PWD/dist/e2e-artifacts scripts/e2e-ha.sh ${{ inputs.files }}`; upload `dist/e2e-artifacts` with `actions/upload-artifact` (use the same pinned major the repo's other workflows use) `if: always()`; write a job summary with the pass/fail line. No secrets are used. Validate the YAML (`actionlint` if installed, else `bun -e` with the `yaml` package parse) and note that `workflow_dispatch` only appears in the Actions UI once the file is on the default branch; to exercise it from the PR branch, push it and run `gh workflow run e2e-ha.yml --ref <branch>` after merge, or temporarily add a `push` trigger filtered to the branch and remove it before merge (report which you did).

- [ ] **Step 3: Docs**

`e2e/fake-slack/README.md`: what it is and is not; how to run it standalone (`bun e2e/fake-slack/main.ts`, env vars from Task 5); the control API table; the implemented Web API method list and the rule that an unknown method fails loudly; how to point slaude at it (`SLAUDE_SLACK_API_URL=http://host:port/api/`); the spec-guard attribution if Task 7 landed; the caveat that this proves gateway/node/queue behaviour, not Slack's own validation or rendering (the real-Slack canary, Plan 3, samples that).

`docs/site/_content/field-notes/2026-10-01-fake-slack-for-the-ha-suite.md` (front matter `title`, `date`): the mechanism and the decision only, no internal specifics. Cover: why a fake instead of a real workspace (no API for a user to press a Block Kit button; rate limits and a public tunnel for a test that is about gateways, not Slack); why not an existing tool (in-process interception, no signing, App-Home-only); that the real gateway run in-process against the fake is the fidelity test and what it surfaced (fill in the methods and any gateway behaviour Task 6 actually found); the persona-seeding detail (the mock LLM cannot answer soul extraction, so the cache file is seeded and the seed script verifies a cache hit). Add the index line at the top of the Findings Log in `CLAUDE.md`, newest first, same style as its neighbours.

- [ ] **Step 4: Run it all**

Run: `scripts/e2e-ha.sh e2e/ha/echo.e2e.ts` end to end from a cold start if possible (`deploy/k8s-local/down.sh` first), then `bun run typecheck && bun test` (the whole repo suite must still pass with coverage thresholds).
Expected: the cluster test passes; the full suite is green (a known unrelated flake in `cli/migrate-sqlite` may need one re-run; record it, do not chase it).

- [ ] **Step 5: Commit (separate commits for script, workflow, docs)**

```bash
git add scripts/e2e-ha.sh
git commit -m "feat(e2e): one command to bring up the stack, run cluster cases, and collect diagnostics"
git add .github/workflows/e2e-ha.yml
git commit -m "ci(e2e): manually dispatched HA workflow on a local minikube"
git add e2e/fake-slack/README.md docs/site/_content/field-notes/2026-10-01-fake-slack-for-the-ha-suite.md CLAUDE.md
git diff --cached -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names' || echo "clean"
git commit -m "docs(e2e): fake Slack README and field note"
```

---

## Self-review notes (already applied)

- **Spec coverage.** Spec section 2: the cluster reuse (Task 8), the fake's Web API, inbound sender with Slack retry/duplicate behaviour, control API and spec guard (Tasks 2 to 7), the gateway seam (Task 1), persona registration and soul seeding (Task 9). Section 4's matrix workflow: manually dispatched baseline (Task 11); the schedule, PR smoke subset and tracking-issue reporter are rollout step 6, and the canary workflow is step 7, both Plan 3. Section 3's scenarios beyond `echo` (node loss, gateway loss, cross-replica approval, model and Slack faults, multi-persona) are Plan 3; this plan delivers everything they need: replica-targeted delivery (`gatewayPodUrls`, `target` on `send`/`click`), `killContainer`, Slack fault injection, and `newChannel` isolation.
- **Placeholder scan.** Tasks 1 to 6 carry complete tests and code. Tasks 7 to 11 are partly discovery against a real cluster or a real spec; each gives the exact files, interfaces, commands, expected results and, where unknowns exist, an explicit instruction for what to do when reality differs. The control-client body, `kube.ts`, `driver.ts` and the shell scripts are specified by exact signatures and behaviour rather than pasted in full, because their correctness depends on the real cluster.
- **Type consistency.** `FakeApp`/`FakeMessage` (Task 2) are consumed unchanged by Tasks 3 to 6; `ApiResult`, `FaultStore`, `KNOWN_METHODS` (Task 3) by Tasks 5 to 7; `DeliveryResult` (Task 4) by Task 5's control client and Task 6; `createControlClient`'s method names match the control API table and the tests that call them; `until` (Task 5) is used by Tasks 6 and 10.
- **Known risk carried forward.** The in-process gateway test (Task 6) is the part most likely to reveal surprises (extra Slack methods, a different DM threading, boot-time calls). It is designed to fail loudly and to be resolved by extending the fake, never by weakening exactly-once assertions.
