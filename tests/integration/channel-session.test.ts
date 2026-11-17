/**
 * Channel session mode against the real CLI: the real AgentManager and the
 * real Claude CLI binary, a mock Anthropic API (aimock) in a Node child,
 * since aimock does not load under Bun.
 *
 * Armed like the other integration suites (SLAUDE_REDIS_TEST_URL) and also
 * needs node on the PATH. Nothing here uses Redis: the gateway runs in mono
 * mode, in this process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realEnabled, until } from "./harness";

const armed = realEnabled && !!Bun.which("node");
const REPO = resolve(import.meta.dir, "../..");
const MODEL = "claude-sonnet-4-6";
const BOT = "U0BOT";
const REPLY_TOOL = "mcp__slaude_surface__reply";
const POST_TOOL = "mcp__slaude_runtime__proactive_post";
const FINISH_TOOL = "mcp__slaude_runtime__finish_round";

/** About 0.003 USD a request at this model's prices. */
const CHEAP = { input_tokens: 100, output_tokens: 150 };
/** About 0.60 USD a request, inside the context window (a transcript over it is refused on resume). */
const COSTLY = { input_tokens: 1000, output_tokens: 40_000 };
const LOW_CAP = 0.25;
/** A deny rule, a wake hook or a permission refusal; any of them means the call did not run. */
const REFUSED = /denied|refused|not available|haven't granted/i;
const FINISH_ARGS = { journal: "nothing to do yet" };

/**
 * The mock. Each request is recorded here because aimock's own journal drops
 * bodies over 64 KB and the CLI's system prompt is about that size. `steps` are
 * the tool calls the model makes, one a request from the last plan's start,
 * then a plain answer, so the must-reply guard can be satisfied or not.
 */
const MOCK_SCRIPT = `
import { LLMock } from "@copilotkit/aimock";
import { createServer } from "node:http";
let plan = { steps: [], usage: { input_tokens: 100, output_tokens: 150 } };
let next = 0;
let calls = [];
const textOf = (c) => (typeof c === "string" ? c : JSON.stringify(c ?? ""));
// The CLI can append a reminder after a tool result, so the result need not be last.
const lastToolResult = (messages) => {
  for (let i = messages.length - 1; i >= 0 && messages[i].role !== "assistant"; i--) if (messages[i].role === "tool") return textOf(messages[i].content);
  return null;
};
const mock = new LLMock({ port: 0 });
mock.on({ predicate: () => true }, (req) => {
  const messages = req.messages ?? [];
  calls.push({
    model: req.model,
    tools: (req.tools ?? []).map((t) => t.function?.name ?? t.name),
    text: messages.filter((m) => m.role !== "system").map((m) => textOf(m.content)).join("\\n"),
    toolResult: lastToolResult(messages),
  });
  const usage = plan.usage;
  const step = plan.steps[next++];
  if (step) return { toolCalls: [{ name: step.tool, arguments: JSON.stringify(step.args ?? {}) }], usage };
  return { content: "done", usage };
});
const url = await mock.start();
const control = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.method === "POST") {
      plan = { ...plan, ...JSON.parse(body) };
      next = 0;
    }
    res.end(JSON.stringify(calls));
  });
});
control.listen(0, "127.0.0.1", () => console.log("READY " + url + " " + control.address().port));
setInterval(() => {}, 60000);
`;

interface Step { tool: string; args?: object }
interface Call { model: string; tools: string[]; text: string; toolResult: string | null }

describe.skipIf(!armed)("channel session against the real CLI", () => {
  let mock: ChildProcess;
  let controlUrl: string;
  let configDir: string;
  let g: any;
  let Sessions: typeof import("../../src/db/sessions");
  let Runs: typeof import("../../src/db/background-runs");
  let db: typeof import("../../src/db/schema").db;
  let manager: string;
  const saved: Record<string, string | undefined> = {};
  let tsCounter = 9000;

  const plan = (p: { steps: Step[]; usage: object }) => fetch(controlUrl, { method: "POST", body: JSON.stringify(p) });
  const reply = (text: string): Step => ({ tool: REPLY_TOOL, args: { text } });
  const calls = async (): Promise<Call[]> => (await (await fetch(controlUrl)).json()) as Call[];
  const nextTs = () => `${++tsCounter}.1`;
  const key = (channel: string, thread_ts = `channel:${channel}`) => ({ team_id: "T", channel_id: channel, thread_ts, persona_id: "default" });

  function transcripts(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (p.endsWith(".jsonl")) {
          out.push(p);
          continue;
        }
        // The CLI writes its config through short-lived temporary files.
        const stat = statSync(p, { throwIfNoEntry: false });
        if (stat?.isDirectory()) walk(p);
      }
    };
    walk(configDir);
    return out;
  }
  const transcriptHas = (marker: string) => transcripts().some((p) => readFileSync(p, "utf8").includes(marker));

  async function say(channel: string, text: string, o: { user?: string; ts?: string } = {}): Promise<string> {
    const ts = o.ts ?? nextTs();
    await g.emit("message", {
      event: { type: "message", channel, channel_type: "channel", user: o.user ?? manager, team: "T", ts, text },
      client: g.client,
      context: { teamId: "T" },
    });
    return ts;
  }
  const session = (channel: string) => Sessions.findByThread(key(channel));
  async function idle(sessionId: string) {
    await until(() => !g.agent.turnRunning(sessionId) && !g.agent.isTurnInFlight(sessionId), 45_000);
  }
  async function posted(marker: string) {
    await until(() => g.posts.some((p: any) => String(p.text).includes(marker)), 45_000);
  }
  async function mention(channel: string, text: string, answer: string, usage: object = CHEAP, before: Step[] = []) {
    await plan({ steps: [...before, reply(answer)], usage });
    await say(channel, `<@${BOT}> ${text}`);
    await posted(answer);
    const s = await session(channel);
    await idle(s!.id);
    return s!;
  }
  async function wake(channel: string, text: string, caps: object, usage: object = CHEAP, steps: Step[] = []) {
    await plan({ steps, usage });
    // An open ledger row, as the scheduler opens one: the manager finishes it.
    const runId = await Runs.start({ agentId: "U0AGENT", pass: "heartbeat-wake", scope: `channel:${channel}`, model: MODEL, day: "2026-11-10" });
    const target = { teamId: "T", managerId: manager, channelId: channel, threadTs: `channel:${channel}`, personaId: "default", agentId: "U0AGENT", appId: undefined };
    await g.h.__wake.dispatch(target, text, { runId, agentId: "U0AGENT" }, caps);
    let outcome: string | null | undefined;
    await until(async () => {
      outcome = (await Runs.get(runId))?.outcome;
      return !!outcome;
    }, 45_000);
    return outcome!;
  }

  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), "slaude-cli-it-"));
    mock = spawn("node", ["--input-type=module", "-e", MOCK_SCRIPT], { cwd: REPO, stdio: ["ignore", "pipe", "inherit"] });
    const base = await new Promise<string>((res, rej) => {
      mock.once("exit", (c) => rej(new Error(`mock exited ${c}`)));
      mock.stdout!.on("data", (d) => {
        const m = String(d).match(/READY (\S+) (\d+)/);
        if (m) {
          controlUrl = `http://127.0.0.1:${m[2]}`;
          res(m[1]!);
        }
      });
    });
    for (const [k, v] of Object.entries({
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_API_KEY: "mock",
      CLAUDE_CONFIG_DIR: configDir,
      SLAUDE_MODEL: MODEL,
      SLAUDE_BRAIN_DISABLED: "1",
      // A wake refuses every permission prompt, its own tools included, so a
      // wake can only act in a session that never asks: bypass.
      SLAUDE_DEFAULT_MODE: "bypass",
    })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }

    ({ db } = await import("../../src/db/schema"));
    Sessions = await import("../../src/db/sessions");
    Runs = await import("../../src/db/background-runs");
    const { AgentManager } = await import("../../src/agent/manager");
    const { createGateway } = await import("../../src/gateway/core/gateway");
    const { makeSlackSurfaceFactory } = await import("../../src/gateway/slack/surface");
    const { writeSoulFixture, WORLD } = await import("../../src/gateway/sim/soul-fixture");
    const { paths, ensureHome } = await import("../../src/config/home");
    ensureHome();
    manager = WORLD.manager;
    writeSoulFixture({ ...WORLD, trusted: ["C1", "C2", "C3", "C4"] });
    const modeBlock = (ch: string) => `\n## Channel <#${ch}>\n### Session\n- Mode: channel\n`;
    appendFileSync(paths.soul, ["C1", "C2", "C3"].map(modeBlock).join(""));

    const posts: any[] = [];
    const handlers = new Map<string, (a: any) => Promise<void>>();
    const client: any = {
      auth: { test: async () => ({ user_id: BOT, bot_id: `B${BOT}`, team: "T", url: "x" }) },
      chat: {
        postMessage: async (a: any) => {
          const ts = `${Date.now()}.${posts.length}`;
          posts.push({ ...a, ts });
          return { ok: true, ts };
        },
        update: async () => ({ ok: true }),
        postEphemeral: async () => ({ ok: true }),
      },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({ members: [] }), replies: async () => ({ messages: [] }) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
      assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    };
    const transport: any = {
      client,
      action: () => {},
      use: () => {},
      start: async () => {},
      stop: async () => {},
      event: (name: string, fn: any) => void handlers.set(name, fn),
    };
    const agent = new AgentManager();
    const h = createGateway(agent, transport, { surfaceFactory: makeSlackSurfaceFactory(client) });
    g = { agent, h, client, posts, emit: async (name: string, a: any) => handlers.get(name)?.(a) };
    await db.run("DELETE FROM seen_events");
  }, 60_000);

  afterAll(async () => {
    await g?.h?.stop?.().catch(() => {});
    mock?.kill("SIGTERM");
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(configDir, { recursive: true, force: true });
  }, 30_000);

  test("1: recorded messages reach the next mention, and recording makes no model call", async () => {
    const before = (await calls()).length;
    await say("C1", "RECORD-ALPHA the deploy looks stuck");
    await until(async () => !!(await session("C1")), 10_000);
    await until(() => transcriptHas("RECORD-ALPHA"), 45_000);
    await say("C1", "RECORD-BETA I restarted the worker");
    await until(() => transcriptHas("RECORD-BETA"), 45_000);
    expect((await calls()).length).toBe(before);

    const s = await mention("C1", "MENTION-GAMMA what happened?", "REPLY-GAMMA");
    const fresh = (await calls()).slice(before);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh[0]!.text).toContain("RECORD-ALPHA");
    expect(fresh[0]!.text).toContain("RECORD-BETA");
    expect(fresh[0]!.text).toContain("MENTION-GAMMA");
    expect(s.slack_thread_ts).toBe("channel:C1");
    // Root: the reply has no thread.
    expect(g.posts.find((p: any) => p.text.includes("REPLY-GAMMA")).thread_ts).toBeUndefined();
  }, 120_000);

  test("2: mention, wake, mention share one transcript; caps and tools follow the boot", async () => {
    const CAPS = { maxBudgetUsd: LOW_CAP, maxTurns: 20, maxMinutes: 5 };
    // A first process that spends far more than the wake's cap.
    const first = await mention("C2", "MENTION-ONE start", "REPLY-ONE", COSTLY);

    // The wake restarts on the transcript; its cap is not charged with what came before.
    let mark = (await calls()).length;
    expect(await wake("C2", "WAKE-MARKER look around", CAPS, CHEAP, [reply("NOT-FROM-A-WAKE"), { tool: FINISH_TOOL, args: FINISH_ARGS }])).toBe("ok");
    const wakeCalls = (await calls()).slice(mark);
    expect(wakeCalls[0]!.text).toContain("MENTION-ONE");
    expect(wakeCalls[0]!.text).toContain("WAKE-MARKER");
    // A wake's tool set: a person's reply tool is refused, its own finish_round runs.
    expect(wakeCalls[1]!.toolResult).toMatch(REFUSED);
    expect(wakeCalls[2]!.toolResult).not.toMatch(REFUSED);
    expect(g.posts.some((p: any) => String(p.text).includes("NOT-FROM-A-WAKE"))).toBe(false);

    // The cap is real: a wake that overspends is stopped by it.
    expect(await wake("C2", "WAKE-OVER spend", CAPS, COSTLY)).toBe("stopped-budget");

    // A person's turn restarts as a normal boot: no cap, a wake's tools refused, its own reply runs.
    mark = (await calls()).length;
    const second = await mention("C2", "MENTION-TWO again", "REPLY-TWO", COSTLY, [{ tool: POST_TOOL, args: { text: "NOT-FROM-A-MENTION" } }]);
    const secondCalls = (await calls()).slice(mark);
    expect(secondCalls[0]!.text).toContain("MENTION-ONE");
    expect(secondCalls[0]!.text).toContain("WAKE-MARKER");
    expect(secondCalls[0]!.text).toContain("MENTION-TWO");
    expect(secondCalls[1]!.toolResult).toMatch(REFUSED);
    expect(secondCalls[2]!.toolResult).not.toMatch(REFUSED);
    expect(g.posts.some((p: any) => String(p.text).includes("NOT-FROM-A-MENTION"))).toBe(false);
    expect(second.id).toBe(first.id);
    // One transcript carries the whole conversation.
    expect(transcripts().filter((p) => readFileSync(p, "utf8").includes("MENTION-ONE"))).toHaveLength(1);
  }, 180_000);

  test("3: /new starts clean", async () => {
    const old = await mention("C3", "OLD-MARKER keep this", "REPLY-OLD");
    await say("C3", `<@${BOT}> /new`);
    await until(async () => (await session("C3")) === null, 15_000);
    const before = (await calls()).length;
    const fresh = await mention("C3", "NEW-MARKER hello again", "REPLY-NEW");
    expect(fresh.id).not.toBe(old.id);
    const next = (await calls())[before]!;
    expect(next.text).toContain("NEW-MARKER");
    expect(next.text).not.toContain("OLD-MARKER");
  }, 120_000);

  test("4: a channel without the mode behaves as before", async () => {
    const before = (await calls()).length;
    await plan({ steps: [reply("REPLY-PLAIN")], usage: CHEAP });
    const ts = await say("C4", `<@${BOT}> PLAIN-MARKER hello`);
    await posted("REPLY-PLAIN");
    expect(await Sessions.findByThread(key("C4"))).toBeNull();
    const s = await Sessions.findByThread(key("C4", ts));
    expect(s).not.toBeNull();
    await idle(s!.id);
    expect(g.posts.find((p: any) => p.text.includes("REPLY-PLAIN")).thread_ts).toBe(ts);
    expect((await calls()).length).toBeGreaterThan(before);

    // An unmentioned root message starts nothing.
    const count = (await calls()).length;
    const unmentioned = await say("C4", "PLAIN-UNMENTIONED nothing for the bot");
    await Bun.sleep(1500);
    expect(await Sessions.findByThread(key("C4", unmentioned))).toBeNull();
    expect((await calls()).length).toBe(count);
  }, 120_000);

  describe("the CLI itself", () => {
    let query: typeof import("@anthropic-ai/claude-agent-sdk").query;
    const env = () => ({ ...process.env, DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_ERROR_REPORTING: "1" });
    let cwd: string;

    beforeAll(async () => {
      ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
      cwd = mkdtempSync(join(tmpdir(), "slaude-cli-cwd-"));
    });

    async function headless(prompt: string, options: object): Promise<any> {
      let result: any;
      try {
        for await (const m of query({ prompt, options: { cwd, env: env(), model: MODEL, settingSources: [], ...options } as any })) {
          if (m.type === "result") result = m;
        }
      } catch (e) {
        // The SDK throws after yielding an error result; the result is what counts.
        if (!result) throw e;
      }
      return result;
    }

    test("5: a resumed process starts its budget at zero", async () => {
      await plan({ steps: [], usage: COSTLY });
      const first = await headless("BUDGET-ONE spend", {});
      expect(first.subtype).toBe("success");
      expect(first.total_cost_usd).toBeGreaterThan(LOW_CAP);

      await plan({ steps: [], usage: CHEAP });
      const resumed = await headless("BUDGET-TWO cheap", { resume: first.session_id, maxBudgetUsd: LOW_CAP });
      expect(resumed.subtype).toBe("success");
      expect(resumed.total_cost_usd).toBeLessThan(LOW_CAP);

      // The same cap does stop a resumed run that overspends by itself, and
      // the cost it reports is this process's alone.
      await plan({ steps: [], usage: COSTLY });
      const over = await headless("BUDGET-THREE spend", { resume: first.session_id, maxBudgetUsd: LOW_CAP });
      expect(over.subtype).toBe("error_max_budget_usd");
      expect(over.total_cost_usd).toBeLessThan(first.total_cost_usd + LOW_CAP);
    }, 120_000);

    test("6: UserPromptSubmit does not fire for a raw /compact", async () => {
      await plan({ steps: [], usage: CHEAP });
      const prompts: string[] = [];
      const hook = async (input: any) => {
        if (input.hook_event_name === "UserPromptSubmit") prompts.push(input.prompt);
        return { continue: true };
      };
      let compacted = false;
      let results = 0;
      let release!: () => void;
      const firstDone = new Promise<void>((r) => (release = r));
      let compactDone!: () => void;
      const secondDone = new Promise<void>((r) => (compactDone = r));
      const user = (text: string) => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }) as any;
      async function* input() {
        yield user("COMPACT-ONE hello");
        await firstDone;
        yield user("/compact");
        await secondDone;
      }
      for await (const m of query({
        prompt: input(),
        options: { cwd, env: env(), model: MODEL, settingSources: [], hooks: { UserPromptSubmit: [{ hooks: [hook] }], PreCompact: [{ hooks: [async () => ((compacted = true), { continue: true })] }] } } as any,
      })) {
        if (m.type === "result") {
          results++;
          if (results === 1) release();
          else {
            compactDone();
            break;
          }
        }
      }
      expect(prompts.some((p) => p.includes("COMPACT-ONE"))).toBe(true);
      // The command did run: the assertion below is not vacuous.
      expect(compacted).toBe(true);
      expect(prompts.filter((p) => p.includes("/compact"))).toEqual([]);
    }, 120_000);
  });
});
