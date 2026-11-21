import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DecisionError, type DecisionAdapter, type DecisionRequest, type DecisionResult } from "../../../src/decision/types";
import { parseAgentYaml } from "../../../src/persona/agent-def";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../../src/persona/registry";
import type { Persona } from "../../../src/persona/types";
import { __setEngageStateForTests, circuitBreaker, memoryEngageState, type CircuitBreaker, type EngageState } from "../../../src/gateway/engage/budget";
import { gateClassifier } from "../../../src/gateway/engage/gate-classifier";
import { __setLastSpeakerStoreForTests, memoryLastSpeakerStore, type LastSpeakerStore } from "../../../src/gateway/engage/last-speaker";
import { observeEngage, type ObserveInput } from "../../../src/gateway/engage/observe";
import { noteAgentMessage } from "../../../src/gateway/engage/record";
import { shadowIdle, type ShadowDeps } from "../../../src/gateway/engage/shadow";
import type { BuiltInput } from "../../../src/gateway/engage/input";
import type { EngageClassifier } from "../../../src/gateway/engage/types";
import { makeGateRunner } from "../../../src/gateway/gate/runner";
import { metrics } from "../../../src/metrics";

const CH = "C0SHARED";
const yaml = `
name: ana
slackUserId: UANA1
soul: You are Ana.
access:
  channels:
    trusted: [${CH}]
channels:
  ${CH}: { engage: { level: contribute, mode: on } }
`;
function persona(name = "ana", user = "UANA1"): Persona {
  const { spec } = parseAgentYaml(name, yaml.replace("name: ana", `name: ${name}`).replace("UANA1", user).replace("You are Ana.", `You are ${name}.`));
  const { soulData, ...definition } = spec.definition;
  return { name, slackUserId: user, soulMd: spec.soul, config: { slackUserId: user, name }, outClient: null, model: null, runsOn: null, provider: null, kbSources: null, background: null, mcp: null, soulJson: soulData, definition } as Persona;
}
const registry = (...ps: Persona[]): PersonaRegistry => ({
  lookupByUserId: (id) => ps.find((p) => p.slackUserId === id) ?? null, lookupByName: (n) => ps.find((p) => p.name === n) ?? null, list: () => ps,
  isMultiPersonaMode: () => true, isManaged: () => true, tombstonedPersonaFor: () => null, defaultPersona: () => ({ model: null, mcp: null, definition: null }),
} as PersonaRegistry);

const nowTs = (o = 0) => `${Math.floor(Date.now() / 1000) + o}.000100`;
let seq = 0;
const uniq = () => nowTs(++seq);

/** What the scripted adapter does for a request. */
type Script = "yes" | "no" | "error" | "hang" | ((req: DecisionRequest) => DecisionResult);
let asked: DecisionRequest[] = [];
function adapter(script: Script): DecisionAdapter {
  return {
    name: "scripted-test",
    decide: async (req) => {
      asked.push(req);
      if (script === "error") throw new DecisionError("transport", "down");
      if (script === "hang") return new Promise<DecisionResult>(() => {});
      if (typeof script === "function") return script(req);
      const yes = script === "yes";
      return Object.fromEntries(Object.keys(req.questions).map((k) => [k, { choice: k === "alreadyAnswered" ? "no" : yes ? "yes" : "no", confidence: 0.95 }]));
    },
  };
}

let state: EngageState;
let breaker: CircuitBreaker;
let lines: string[];
let built: number;
let store: LastSpeakerStore;

const canned = (thread: string | null): BuiltInput => ({ input: { message: "<agent> thoughts?", recent: [], mentionsAgent: false, engaged: false, kbHitScore: null, channelTrust: "trusted" }, read: thread ? "replies" : "history" });
function deps(script: Script | null, o: Partial<ShadowDeps> & { timeoutMs?: number } = {}): ShadowDeps {
  const runner = script === null ? null : makeGateRunner({ mode: "off", adapter: adapter(script), tAct: 0.8, timeoutMs: o.timeoutMs ?? 200, contextMessages: 8, log: () => {} });
  return {
    classifier: runner ? gateClassifier(runner) : null,
    buildInput: async (req) => (built++, canned(req.thread)),
    state, breaker, log: (l) => lines.push(l), schedule: (fn) => void fn(),
    ...o,
  };
}

const total = (result: string, reason: string, level = "contribute"): number => {
  const line = metrics.render().split("\n").find((l) => l.startsWith("slaude_engage_classifier_total{") && l.includes(`result="${result}"`) && l.includes(`reason="${reason}"`) && l.includes(`level="${level}"`));
  return line ? Number(line.split(" ").at(-1)) : 0;
};

const event = (o: Record<string, unknown> = {}) => ({ type: "message", channel: CH, user: "U0PERSON", ts: uniq(), text: "I wonder what ana thinks about this", ...o });
const obs = (shadow: ShadowDeps | undefined, e: Record<string, unknown> = {}, app?: string): ObserveInput => ({
  event: event(e), personaId: "ana", botId: "UBOT", ...(app ? { appId: app } : {}),
  locks: { oneOnOne: false, mentionOnly: false, disengaged: false }, threadEngaged: false, site: "drop", shadow,
});
const run = async (i: ObserveInput) => {
  const r = await observeEngage(i);
  await shadowIdle();
  return r;
};

beforeEach(() => {
  asked = [];
  lines = [];
  built = 0;
  state = memoryEngageState({ dailyBudget: () => 50, minuteCeiling: () => 100 });
  __setEngageStateForTests(state);
  breaker = circuitBreaker({ baseMs: 60_000 });
  store = memoryLastSpeakerStore();
  __setLastSpeakerStoreForTests(store);
  setPersonaRegistry(registry(persona()));
});
afterEach(() => {
  __setEngageStateForTests(null);
  __setLastSpeakerStoreForTests(null);
  __resetPersonaRegistry();
});

describe("tier 3 in shadow: the answer is counted and logged, never acted on", () => {
  test("a confident yes is logged as run with actual=pass, and the ladder result is unchanged", async () => {
    const before = total("run", "answer");
    const r = await run(obs(deps("yes")));
    expect(r).toMatchObject({ tier: 3, action: "classify", reason: "classify" });
    expect(total("run", "answer")).toBe(before + 1);
    expect(lines.some((l) => /^\[gate\] engage implicit=contribute tier=3 action=run actual=pass reason=answer /.test(l))).toBe(true);
    expect(asked).toHaveLength(1);
  });
  test("a confident no is a pass; at contribute the four questions are asked", async () => {
    const before = total("pass", "answer");
    await run(obs(deps("no")));
    expect(total("pass", "answer")).toBe(before + 1);
    expect(Object.keys(asked[0]!.questions)).toHaveLength(4);
  });
  test("the candidate is always a shadow one, even in a channel whose mode is on", async () => {
    let seen: string | undefined;
    const classifier: EngageClassifier = { classify: async (c) => ((seen = c.mode), "pass"), classifyDetailed: async (c) => ((seen = c.mode), { answer: "run", reason: "answer" }) };
    await run(obs({ ...deps("yes"), classifier }));
    expect(seen).toBe("shadow");
  });
  test("the [engage] line says the classifier is queued, and a message the ladder settles says why not", async () => {
    const logged: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      await run(obs(deps("yes")));
      await run(obs(deps("yes"), { text: "<@U0COLLEAGUE> can you look?" }));
      await run(obs(undefined));
    } finally {
      console.log = orig;
    }
    expect(logged.some((l) => l.includes("[engage] phase0") && l.endsWith("classifier=queued"))).toBe(true);
    expect(logged.some((l) => l.includes("reason=names_other_person") && l.endsWith("classifier=skip:not_candidate"))).toBe(true);
    expect(logged.some((l) => l.endsWith("classifier=skip:disabled"))).toBe(true);
  });
});

describe("failures are passes", () => {
  test("an adapter error", async () => {
    const before = total("pass", "error");
    await run(obs(deps("error")));
    expect(total("pass", "error")).toBe(before + 1);
  });
  test("a slow adapter (the runner's deadline)", async () => {
    const before = total("pass", "timeout");
    await run(obs(deps("hang", { timeoutMs: 30 })));
    expect(total("pass", "timeout")).toBe(before + 1);
  });
  test("a classifier that never returns (the job's own deadline), and the handler is not held", async () => {
    const before = total("pass", "timeout");
    const classifier: EngageClassifier = { classify: () => new Promise(() => {}), classifyDetailed: () => new Promise(() => {}) };
    const t0 = Date.now();
    const r = await observeEngage(obs({ ...deps("yes", { deadlineMs: 40, schedule: undefined }), classifier }));
    expect(Date.now() - t0).toBeLessThan(40);
    expect(r?.action).toBe("classify");
    await new Promise((res) => setTimeout(res, 120));
    await shadowIdle();
    expect(total("pass", "timeout")).toBe(before + 1);
  });
  test("a classifier that throws is an error pass, never an unhandled rejection", async () => {
    const before = total("pass", "error");
    const classifier: EngageClassifier = { classify: async () => { throw new Error("boom"); }, classifyDetailed: async () => { throw new Error("boom"); } };
    await run(obs({ ...deps("yes"), classifier }));
    expect(total("pass", "error")).toBe(before + 1);
  });
  test("a failed input build is an input pass, with no adapter call", async () => {
    const before = total("pass", "input");
    await run(obs({ ...deps("yes"), buildInput: async () => { throw new Error("slack down"); } }));
    expect(total("pass", "input")).toBe(before + 1);
    expect(asked).toHaveLength(0);
  });
  test("three consecutive failures open the breaker; then no adapter call and no input build", async () => {
    const d = deps("error");
    for (let i = 0; i < 3; i++) await run(obs(d));
    expect(asked).toHaveLength(3);
    const builtBefore = built;
    const before = total("pass", "breaker");
    await run(obs(d));
    expect(total("pass", "breaker")).toBe(before + 1);
    expect(asked).toHaveLength(3);
    expect(built).toBe(builtBefore);
  });
});

describe("budget, claim and memory", () => {
  test("over the daily budget is a counted pass and the adapter is not called", async () => {
    state = memoryEngageState({ dailyBudget: () => 2, minuteCeiling: () => 100 });
    __setEngageStateForTests(state);
    const d = deps("yes");
    const before = total("pass", "budget");
    for (let i = 0; i < 3; i++) await run(obs(d));
    expect(asked).toHaveLength(2);
    expect(total("pass", "budget")).toBe(before + 1);
  });
  test("a Redis-style failure of the budget store fails closed", async () => {
    const down: EngageState = { ...memoryEngageState(), spend: async () => "error" };
    const before = total("pass", "budget");
    await run(obs({ ...deps("yes"), state: down }));
    expect(asked).toHaveLength(0);
    expect(total("pass", "budget")).toBe(before + 1);
  });
  test("two app copies of one message make one call and one count", async () => {
    const d = deps("yes");
    const e = { ts: uniq() };
    const before = total("run", "answer");
    await Promise.all([observeEngage(obs(d, e, "A0APPA")), observeEngage(obs(d, e, "A0APPB"))]);
    await shadowIdle();
    expect(asked).toHaveLength(1);
    expect(total("run", "answer")).toBe(before + 1);
  });
  test("no adapter: a counted noadapter pass, no input build, no Slack read, no adapter call", async () => {
    const before = total("pass", "noadapter");
    await run(obs(deps(null)));
    expect(total("pass", "noadapter")).toBe(before + 1);
    expect(built).toBe(0);
    expect(asked).toHaveLength(0);
  });

  describe("no memory of an earlier no", () => {
    const THREAD = nowTs(-30);
    const speak = () => store.put({ channel: CH, thread: THREAD, persona: "ana" }, { ts: nowTs(-5), persona: "ana", app: "", repliedToUser: "U0OTHER" });
    test("two candidates in a thread in a row, the first answered no, both reach the classifier", async () => {
      const d = deps("no");
      await speak();
      const first = await run({ ...obs(d, { thread_ts: THREAD, text: "can you also check staging?" }), shadow: d });
      expect(first).toMatchObject({ action: "classify", continuation: true });
      await run({ ...obs(d, { thread_ts: THREAD, text: "and what about prod?" }), shadow: d });
      expect(asked).toHaveLength(2);
      expect(built).toBe(2);
    });
    test("two root candidates in a row, the first answered no, both reach the classifier", async () => {
      const d = deps("no");
      const root = (text: string) => ({ ...obs(d, { text }), shadow: d });
      await run(root("how do we roll back the release safely today?"));
      await run(root("how do we roll back the release safely today? asking again"));
      expect(asked).toHaveLength(2);
    });
  });
});

describe("the tiers that never reach the classifier", () => {
  test("tier 0 and tier 1 never reach it", async () => {
    const d = deps("yes");
    await run(obs(d, { text: "<@U0COLLEAGUE> can you look?" }));
    await run(obs(d, { text: "<@UANA1> hello?" }));
    await run(obs(d, { text: "<@U0COLLEAGUE> hello?" }));
    expect(asked).toHaveLength(0);
    expect(built).toBe(0);
  });
  test("a thanks and a nickname are asked about, not dropped by a rule", async () => {
    const d = deps("no");
    await run(obs(d, { text: "thanks" }));
    await run(obs(d, { text: "Dude, can you check that?" }));
    expect(asked).toHaveLength(2);
  });
});

describe("two different personas on one message", () => {
  test("each persona's copy is classified once, continuation only for the one that spoke last", async () => {
    setPersonaRegistry(registry(persona("ana", "UANA1"), persona("robin", "UROBIN")));
    const THREAD = nowTs(-30);
    const e = { ts: uniq(), thread_ts: THREAD, text: "can you also check staging?" };
    await store.put({ channel: CH, thread: THREAD, persona: "ana" }, { ts: nowTs(-5), persona: "ana", app: "", repliedToUser: "U0PERSON" });
    const d = deps("yes");
    const a = await observeEngage({ ...obs(d, e), personaId: "ana" });
    const b = await observeEngage({ ...obs(d, e), personaId: "robin" });
    await shadowIdle();
    expect(a).toMatchObject({ tier: 3, action: "classify", continuation: true });
    expect(b).toMatchObject({ tier: 0, action: "pass", reason: "follows_other_agent" });
    expect(asked).toHaveLength(1);
  });
});

describe("what costs nothing", () => {
  test("a refused author is an input pass and spends no budget", async () => {
    let spends = 0;
    const counting: EngageState = { ...memoryEngageState(), spend: async () => (spends++, "ok") };
    const before = total("pass", "input");
    await run(obs({ ...deps("yes"), state: counting, admit: async () => false }));
    expect(total("pass", "input")).toBe(before + 1);
    expect(spends).toBe(0);
    expect(asked).toHaveLength(0);
    await run(obs({ ...deps("yes"), state: counting, admit: async () => { throw new Error("lock lookup failed"); } }));
    expect(spends).toBe(0);
    expect(asked).toHaveLength(0);
  });

  test("a refused call releases the half-open probe", async () => {
    const t = { now: 0 };
    const br = circuitBreaker({ now: () => t.now, baseMs: 10 });
    for (let i = 0; i < 3; i++) br.failure(br.allow()!);
    t.now = 20;
    await run(obs({ ...deps("yes"), breaker: br, admit: async () => false }));
    expect(br.state).toBe("half-open");
    expect(br.allow()).not.toBeNull();
  });
});

describe("concurrent timeouts", () => {
  test("five calls timing out together open the breaker once with the base backoff", async () => {
    let t = 0;
    const br = circuitBreaker({ now: () => t, baseMs: 1000 });
    const d = deps("hang", { timeoutMs: 20, breaker: br });
    await Promise.all([1, 2, 3, 4, 5].map(() => observeEngage({ ...obs(d), shadow: d })));
    await shadowIdle();
    expect(br.state).toBe("open");
    t = 1000;
    expect(br.state).toBe("half-open"); // not 2000: the stale failures did not double it
  });
});
