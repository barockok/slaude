import { afterAll, describe, it, expect, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceCall, VoiceCalls, TRANSCRIPT_FLUSH_PREFIX, type LoopChild, type TurnRunner } from "../../src/voice/call";
import type { ChildMsg, ParentMsg, VoiceInit } from "../../src/voice/ipc";
import { fakeChild, until } from "./fakes";
import { VoiceAuthLost, VoiceTurnCancelled } from "../../src/voice/runners";
import { liveCalls } from "../../src/voice/turn-flags";

// The unpatched timer functions, for tests that spy on setTimeout/clearTimeout.
(globalThis as any).__realSetTimeout = setTimeout;
(globalThis as any).__realClearTimeout = clearTimeout;

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "voice-call-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A child whose message stream is driven by the test; `exit()` simulates the
 *  process dying without (necessarily) its stream ending. */
function scriptedChild(stream: () => AsyncGenerator<ChildMsg>) {
  let exit!: (n: number) => void;
  const sent: ParentMsg[] = [];
  const child = {
    sent, kills: 0,
    send: (m: ParentMsg) => void sent.push(m),
    exited: new Promise<number>((r) => (exit = r)),
    exit: (n: number) => exit(n),
    kill() { this.kills++; },
    messages: { [Symbol.asyncIterator]: stream },
  };
  return child;
}
const never = () => new Promise<never>(() => {});

function recRunner(fail = false) {
  const runs: Array<{ text: string; suppress: boolean; voice: boolean }> = [];
  const runner: TurnRunner = { run: async (_s, text, o) => { runs.push({ text, ...o }); if (fail && o.voice && !o.suppress) throw new Error("turn failed"); } };
  return { runner, runs };
}
const init = (callId: string): VoiceInit => ({ callId, audio: { streamUrl: "https://wb.example.com/s", clearUrl: "https://wb.example.com/c", headers: {}, sampleRate: 24000 },
  audioAllowedOrigins: ["https://wb.example.com"], instructions: "x", provider: "openai", model: "m", maxMinutes: 120, staleSeq: 6 });

function make(over: { fail?: boolean; idleFlushMs?: number; holdResults?: boolean[] } = {}) {
  const child = fakeChild();
  const { runner, runs } = recRunner(over.fail);
  const holds: boolean[] = [];
  const holdResults = [...(over.holdResults ?? [])];
  let closed = 0;
  const dir = tmp();
  const call = new VoiceCall({
    sessionId: "s1", runner, child, transcriptDir: dir,
    holdIdle: (h) => { holds.push(h); return holdResults.length ? holdResults.shift()! : true; },
    onClosed: () => closed++, idleFlushMs: over.idleFlushMs ?? 60_000,
  });
  return { call, child, runs, holds, closed: () => closed, dir };
}
async function started(t: ReturnType<typeof make>) {
  const p = t.call.start(init(t.call.callId));
  t.child.push({ type: "started", callId: t.call.callId, sampleRate: 24000 });
  await p;
}

describe("VoiceCall", () => {
  it("a child log line never reaches the application log with a capability URL", async () => {
    const t = make();
    const cap = "cap-3c1d9e";
    const i = { ...init(t.call.callId), audio: { streamUrl: `/api/browser/audio/${cap}/stream`, clearUrl: `/api/browser/audio/${cap}/clear`, headers: {}, sampleRate: 24000 } };
    const p = t.call.start(i);
    t.child.push({ type: "started", callId: t.call.callId, sampleRate: 24000 });
    await p;
    const lines: string[] = [];
    const err = spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    t.child.push({ type: "log", level: "error", message: `fetch https://wb.example.com/api/browser/audio/${cap}/stream failed; clear /api/browser/audio/${cap}/clear` });
    await until(() => lines.length > 0);
    err.mockRestore();
    expect(lines.join("\n")).not.toContain(cap);
    expect(lines.join("\n")).toContain("https://wb.example.com/…");
    t.child.kill();
  });

  it("start sends init, holds idle, resolves on started", async () => {
    const t = make();
    const p = t.call.start(init(t.call.callId));
    expect(t.child.sent[0]).toMatchObject({ type: "init" });
    t.child.push({ type: "started", callId: t.call.callId, sampleRate: 24000 });
    await p;
    expect(t.holds).toEqual([true]);
  });

  it("re-holds idle after a turn when the session was not live at start", async () => {
    const t = make({ holdResults: [false] });
    await started(t);
    t.child.push({ type: "delegate", id: "1", task: "x", asOf: 0 });
    await until(() => t.holds.length === 2);
    expect(t.holds).toEqual([true, true]);
    t.child.push({ type: "delegate", id: "2", task: "y", asOf: 0 });
    await until(() => t.runs.length === 2);
    await Bun.sleep(10);
    expect(t.holds).toEqual([true, true]); // held now; no further re-hold
  });

  it("delegate runs a voice turn carrying the buffered transcript", async () => {
    const t = make();
    await started(t);
    t.child.push({ type: "transcript", seq: 1, role: "user", text: "is the deploy green?" });
    t.child.push({ type: "delegate", id: "1", task: "check deploy status", asOf: 1 });
    await until(() => t.runs.length === 1);
    expect(t.runs[0]).toMatchObject({ suppress: false, voice: true });
    expect(t.runs[0]!.text).toContain("participant: is the deploy green?");
    expect(t.runs[0]!.text).toContain('voice_say(reply_to="1")');
  });

  it("a reply is stamped with its delegate's asOf, not the latest seq (stale downgrade can fire)", async () => {
    const t = make();
    await started(t);
    t.child.push({ type: "transcript", seq: 1, role: "user", text: "check the deploy" });
    t.child.push({ type: "delegate", id: "1", task: "check deploy", asOf: 1 });
    for (let i = 2; i <= 11; i++) t.child.push({ type: "transcript", seq: i, role: "user", text: `line ${i}` });
    await until(() => t.runs.length === 1);
    await Bun.sleep(10); // the ten later lines reach the parent
    t.call.say("it is green", "now", "1");
    expect(t.child.sent.find((m) => m.type === "say")).toMatchObject({ when: "now", replyTo: "1", asOf: 1 });
  });

  it("a say without reply_to is stamped with the newest seq handed to the session", async () => {
    const t = make();
    await started(t);
    for (let i = 1; i <= 3; i++) t.child.push({ type: "transcript", seq: i, role: "user", text: `line ${i}` });
    t.child.push({ type: "delegate", id: "1", task: "x", asOf: 3 });
    for (let i = 4; i <= 10; i++) t.child.push({ type: "transcript", seq: i, role: "user", text: `line ${i}` });
    await until(() => t.runs.length === 1);
    await Bun.sleep(10);
    t.call.say("heads up", "now");
    expect(t.child.sent.find((m) => m.type === "say")).toMatchObject({ when: "now", asOf: 3 });
  });

  it("flushes the transcript as a suppressed turn after idle", async () => {
    const t = make({ idleFlushMs: 20 });
    await started(t);
    t.child.push({ type: "transcript", seq: 1, role: "assistant", text: "hello everyone" });
    await until(() => t.runs.length === 1);
    expect(t.runs[0]).toMatchObject({ suppress: true, voice: true });
    expect(t.runs[0]!.text).toBe(`${TRANSCRIPT_FLUSH_PREFIX}\nvoice: hello everyone`);
  });

  it("a failed delegate turn answers the request through the voice", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const t = make({ fail: true });
    await started(t);
    t.child.push({ type: "transcript", seq: 3, role: "user", text: "q" });
    t.child.push({ type: "delegate", id: "7", task: "x", asOf: 3 });
    await until(() => t.child.sent.some((m) => m.type === "say"));
    const say = t.child.sent.find((m) => m.type === "say")!;
    expect(say).toMatchObject({ type: "say", when: "next_gap", replyTo: "7", asOf: 3 });
    expect((say as { text: string }).text).toContain("Request #7 failed");
    expect(t.child.sent.some((m) => m.type === "context")).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("say/context/stop relay to the child; end writes transcript, runs summary, releases idle", async () => {
    const t = make();
    await started(t);
    t.child.push({ type: "transcript", seq: 1, role: "user", text: "bye" });
    await Bun.sleep(10); // let the parent process the transcript line
    t.call.say("noted", "next_gap", "1");
    t.call.context("fact");
    const stopping = t.call.stop("stopped");
    expect(t.child.sent.map((m) => m.type)).toEqual(["init", "say", "context", "stop"]);
    // No delegate "1" and nothing handed to the session yet: asOf is 0.
    expect((t.child.sent[1] as any).asOf).toBe(0);
    t.child.push({ type: "ended", reason: "stopped" });
    await stopping;
    expect(await t.call.done).toBe("stopped");
    // the unflushed tail goes in suppressed first, then the summary
    expect(t.runs.at(-2)).toMatchObject({ suppress: true, voice: true });
    const summary = t.runs.at(-1)!;
    expect(summary).toMatchObject({ suppress: false, voice: false });
    expect(summary.text).toContain("browser_audio_stop");
    const path = summary.text.match(/(\/\S+voice-call-\S+\.txt)/)![1]!;
    expect(readFileSync(path, "utf8")).toContain("participant: bye");
    expect(t.holds).toEqual([true, false]);
    expect(t.closed()).toBe(1);
  });

  it("session_rebooted writes the transcript only: no flush, no summary", async () => {
    const t = make();
    await started(t);
    t.child.push({ type: "transcript", seq: 1, role: "user", text: "hi" });
    t.child.push({ type: "ended", reason: "session_rebooted" });
    expect(await t.call.done).toBe("session_rebooted");
    expect(t.runs).toHaveLength(0);
    const files = readdirSync(t.dir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(t.dir, files[0]!), "utf8")).toContain("participant: hi");
    expect(t.closed()).toBe(1);
  });

  it("a cancelled close disarms the idle-flush timer", async () => {
    const t = make({ idleFlushMs: 4_321 });
    await started(t);
    const armed: unknown[] = [];
    const cleared: unknown[] = [];
    const st = spyOn(globalThis, "setTimeout");
    const ct = spyOn(globalThis, "clearTimeout");
    try {
      st.mockImplementation(((fn: any, ms?: number, ...a: any[]) => {
        const timer = (globalThis as any).__realSetTimeout(fn, ms, ...a);
        if (ms === 4_321) armed.push(timer);
        return timer;
      }) as any);
      ct.mockImplementation(((h: any) => { cleared.push(h); (globalThis as any).__realClearTimeout(h); }) as any);
      t.child.push({ type: "transcript", seq: 1, role: "user", text: "hi" });
      await until(() => armed.length === 1);
      t.child.push({ type: "ended", reason: "session_rebooted" });
      expect(await t.call.done).toBe("session_rebooted");
      expect(cleared).toContain(armed[0]);
    } finally {
      st.mockRestore();
      ct.mockRestore();
    }
  });

  it("session_rebooted drops delegate turns still queued", async () => {
    const child = fakeChild();
    const ran: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner: TurnRunner = { run: async (_s, text) => { ran.push(text); if (ran.length === 1) await gate; } };
    const call = new VoiceCall({ sessionId: "s1", runner, child, transcriptDir: tmp(), holdIdle: () => true, onClosed: () => {} });
    const p = call.start(init(call.callId));
    child.push({ type: "started", callId: call.callId, sampleRate: 24000 });
    await p;
    child.push({ type: "delegate", id: "1", task: "first", asOf: 0 });
    child.push({ type: "delegate", id: "2", task: "second", asOf: 0 });
    await until(() => ran.length === 1);
    child.push({ type: "ended", reason: "session_rebooted" });
    await until(() => true);
    release();
    expect(await call.done).toBe("session_rebooted");
    expect(ran).toHaveLength(1);
    expect(ran[0]).toContain("first");
  });

  it("stop(session_rebooted) before ended: a queued delegate does not run", async () => {
    const child = fakeChild();
    const ran: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner: TurnRunner = { run: async (_s, text) => { ran.push(text); if (ran.length === 1) await gate; } };
    const call = new VoiceCall({ sessionId: "s1", runner, child, transcriptDir: tmp(), holdIdle: () => true, onClosed: () => {} });
    const p = call.start(init(call.callId));
    child.push({ type: "started", callId: call.callId, sampleRate: 24000 });
    await p;
    child.push({ type: "delegate", id: "1", task: "first", asOf: 0 });
    child.push({ type: "delegate", id: "2", task: "second", asOf: 0 });
    await until(() => ran.length === 1);
    const stopping = call.stop("session_rebooted");
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(ran).toHaveLength(1);
    child.push({ type: "ended", reason: "session_rebooted" });
    await stopping;
    expect(ran).toHaveLength(1);
  });

  it("a turn waiting in the runner when stop(session_rebooted) lands sees it cancelled", async () => {
    const child = fakeChild();
    const seen: boolean[] = [];
    let release!: () => void;
    const waiting = new Promise<void>((r) => (release = r));
    // Stands in for the runner's in-flight / lock wait: cancellation is
    // re-read after the wait, right before the send.
    const runner: TurnRunner = { run: async (_s, _t, o) => { await waiting; seen.push(o.cancelled()); } };
    const call = new VoiceCall({ sessionId: "s1", runner, child, transcriptDir: tmp(), holdIdle: () => true, onClosed: () => {} });
    const p = call.start(init(call.callId));
    child.push({ type: "started", callId: call.callId, sampleRate: 24000 });
    await p;
    child.push({ type: "delegate", id: "1", task: "x", asOf: 0 });
    await new Promise((r) => setTimeout(r, 20));
    const stopping = call.stop("session_rebooted");
    release();
    await until(() => seen.length === 1);
    expect(seen).toEqual([true]);
    child.push({ type: "ended", reason: "session_rebooted" });
    await stopping;
  });

  it("an identity change refused by the runner ends the call auth_lost; queued turns are dropped", async () => {
    const child = fakeChild();
    const runs: string[] = [];
    let allowed = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner: TurnRunner = {
      run: async (_s, text) => {
        if (!allowed) throw new VoiceAuthLost("the thread no longer runs as the agent");
        runs.push(text);
        await gate;
      },
    };
    const err = spyOn(console, "error").mockImplementation(() => {});
    const call = new VoiceCall({ sessionId: "s1", runner, child, transcriptDir: tmp(), holdIdle: () => true, onClosed: () => {} });
    const p = call.start(init(call.callId));
    child.push({ type: "started", callId: call.callId, sampleRate: 24000 });
    await p;
    child.push({ type: "delegate", id: "1", task: "x", asOf: 0 });
    await until(() => runs.length === 1);
    child.push({ type: "delegate", id: "2", task: "y", asOf: 0 });
    child.push({ type: "delegate", id: "3", task: "z", asOf: 0 });
    allowed = false;
    release();
    await until(() => child.sent.some((m) => m.type === "stop"));
    expect(child.sent.at(-1)).toEqual({ type: "stop", reason: "auth_lost" });
    child.push({ type: "ended", reason: "auth_lost" });
    expect(await call.done).toBe("auth_lost");
    // #2 and #3 merged into one turn, which was refused; no flush, no summary.
    expect(runs).toHaveLength(1);
    expect(child.sent.some((m) => m.type === "say")).toBe(false);
    err.mockRestore();
  });

  it("auth lost on the idle flush ends the call too", async () => {
    const child = fakeChild();
    const err = spyOn(console, "error").mockImplementation(() => {});
    const runner: TurnRunner = { run: async () => { throw new VoiceAuthLost("refused"); } };
    const call = new VoiceCall({ sessionId: "s1", runner, child, transcriptDir: tmp(), holdIdle: () => true, onClosed: () => {}, idleFlushMs: 10 });
    const p = call.start(init(call.callId));
    child.push({ type: "started", callId: call.callId, sampleRate: 24000 });
    await p;
    child.push({ type: "transcript", seq: 1, role: "user", text: "hi" });
    await until(() => child.sent.some((m) => m.type === "stop"));
    expect(child.sent.at(-1)).toEqual({ type: "stop", reason: "auth_lost" });
    child.kill();
    expect(await call.done).toBe("auth_lost");
    err.mockRestore();
  });

  it("child crash ends loop_crashed", async () => {
    const t = make();
    await started(t);
    t.child.kill();
    expect(await t.call.done).toBe("loop_crashed");
  });

  it("child exit without an ended line ends loop_crashed even if stdout stays open", async () => {
    let exit!: (n: number) => void;
    const child: LoopChild = {
      send: () => {},
      exited: new Promise<number>((r) => (exit = r)),
      kill: () => {},
      messages: { async *[Symbol.asyncIterator]() { yield { type: "started", callId: "x", sampleRate: 24000 } as ChildMsg; await new Promise(() => {}); } },
    };
    const { runner } = recRunner();
    const call = new VoiceCall({ sessionId: "s1", runner, child, transcriptDir: tmp(),
      holdIdle: () => true, onClosed: () => {}, exitGraceMs: 10 });
    await call.start(init(call.callId));
    exit(1);
    expect(await call.done).toBe("loop_crashed");
  });

  it("a stream failure closes the call and kills the child", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const child = scriptedChild(async function* () {
      yield { type: "started", callId: "x", sampleRate: 24000 } as ChildMsg;
      throw new Error("stdout broke");
    });
    const { runner } = recRunner();
    const call = new VoiceCall({ sessionId: "s1", runner, child, transcriptDir: tmp(), holdIdle: () => true, onClosed: () => {} });
    await call.start(init(call.callId));
    expect(await call.done).toBe("loop_crashed");
    expect(child.kills).toBe(1);
    err.mockRestore();
  });

  it("a requested stop closes with that reason when the child exits without ended", async () => {
    const child = scriptedChild(async function* () {
      yield { type: "started", callId: "x", sampleRate: 24000 } as ChildMsg;
      await never();
    });
    const { runner, runs } = recRunner();
    const call = new VoiceCall({ sessionId: "s1", runner, child, transcriptDir: tmp(), holdIdle: () => true, onClosed: () => {}, exitGraceMs: 10 });
    await call.start(init(call.callId));
    const stopping = call.stop("session_rebooted");
    child.exit(0);
    await stopping;
    expect(await call.done).toBe("session_rebooted");
    expect(runs).toHaveLength(0); // no summary on a rebooted session
  });

  it("start timeout rejects, kills the child, ignores a late start and runs no summary", async () => {
    let late!: () => void;
    const lateGate = new Promise<void>((r) => (late = r));
    const child = scriptedChild(async function* () {
      await lateGate;
      yield { type: "started", callId: "x", sampleRate: 24000 } as ChildMsg;
      yield { type: "ended", reason: "stopped" } as ChildMsg;
    });
    const { runner, runs } = recRunner();
    const holds: boolean[] = [];
    const call = new VoiceCall({ sessionId: "s1", runner, child, transcriptDir: tmp(),
      holdIdle: (h) => { holds.push(h); return true; }, onClosed: () => {}, startTimeoutMs: 10 });
    await expect(call.start(init(call.callId))).rejects.toThrow(/did not start in time/);
    expect(child.kills).toBeGreaterThanOrEqual(1);
    late();
    expect(await call.done).toBe("stopped");
    expect(holds).toEqual([]);
    expect(runs).toHaveLength(0);
  });

  it("auth lost on a delegate stops the call with auth_lost", async () => {
    const { VoiceAuthLost } = await import("../../src/voice/runners");
    const err = spyOn(console, "error").mockImplementation(() => {});
    const child = fakeChild();
    const call = new VoiceCall({ sessionId: "s1", child, transcriptDir: tmp(), holdIdle: () => {}, onClosed: () => {},
      runner: { run: async (_s, _t, o) => { if (o.voice && !o.suppress) throw new VoiceAuthLost("refused"); } } });
    const p = call.start(init(call.callId));
    child.push({ type: "started", callId: call.callId, sampleRate: 24000 });
    await p;
    child.push({ type: "delegate", id: "1", task: "x", asOf: 0 });
    await until(() => child.sent.some((m) => m.type === "stop"));
    expect(child.sent.at(-1)).toEqual({ type: "stop", reason: "auth_lost" });
    expect(child.sent.some((m) => m.type === "say")).toBe(false);
    child.kill();
    expect(await call.done).toBe("auth_lost");
    err.mockRestore();
  });

  it("a failed delegate's transcript chunk is carried by the next flush", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const t = make({ fail: true, idleFlushMs: 20 });
    await started(t);
    t.child.push({ type: "transcript", seq: 1, role: "user", text: "first" });
    t.child.push({ type: "delegate", id: "1", task: "x", asOf: 1 });
    await until(() => t.child.sent.some((m) => m.type === "say"));
    t.child.push({ type: "transcript", seq: 2, role: "assistant", text: "second" });
    await until(() => t.runs.some((r) => r.suppress));
    expect(t.runs.find((r) => r.suppress)!.text).toBe(`${TRANSCRIPT_FLUSH_PREFIX}\nparticipant: first\nvoice: second`);
    err.mockRestore();
  });

  it("start rejects when the child ends before starting", async () => {
    const t = make();
    const p = t.call.start(init(t.call.callId));
    t.child.push({ type: "ended", reason: "provider_failed" });
    await expect(p).rejects.toThrow(/provider_failed/);
    expect(await t.call.done).toBe("provider_failed");
    expect(t.runs).toHaveLength(0);
    expect(t.holds).toEqual([]);
    expect(existsSync(t.dir) && readdirSync(t.dir).length).toBe(0);
  });
});

describe("VoiceCalls", () => {
  it("endAll says goodbye now, then stops every call", async () => {
    const calls = new VoiceCalls();
    const t = make();
    await started(t);
    calls.add("s1", t.call);
    const ending = calls.endAll("node_drain", "bye", 0);
    expect(t.child.sent.slice(-2).map((m) => m.type)).toEqual(["say", "stop"]);
    expect(t.child.sent.at(-2)).toMatchObject({ text: "bye", when: "now" });
    t.child.push({ type: "ended", reason: "node_drain" });
    await ending;
    expect(await t.call.done).toBe("node_drain");
  });

  it("session exit ends the call", async () => {
    const calls = new VoiceCalls();
    const t = make();
    await started(t);
    calls.add("s1", t.call);
    expect(calls.get("s1")).toBe(t.call);
    const ending = calls.end("s1", "session_rebooted");
    expect(t.child.sent.at(-1)).toEqual({ type: "stop", reason: "session_rebooted" });
    t.child.push({ type: "ended", reason: "session_rebooted" });
    await ending;
    expect(await t.call.done).toBe("session_rebooted");
    calls.remove("s1");
    expect(calls.get("s1")).toBeUndefined();
  });
});

/** A call whose runner holds every turn until the test releases it. */
function gated(over: {
  idleFlushMs?: number; queueWaitMs?: number;
  /** true: throw a plain error; an Error: throw that. */
  fail?: (text: string) => boolean | Error;
  /** Runs inside the turn, after its gate opens (e.g. Claude's voice_say). */
  during?: (text: string, call: VoiceCall) => void;
} = {}) {
  const child = fakeChild();
  const runs: Array<{ text: string; suppress: boolean; voice: boolean; live: boolean }> = [];
  const gates: Array<() => void> = [];
  let call!: VoiceCall;
  const runner: TurnRunner = {
    run: async (_s, text, o) => {
      runs.push({ text, suppress: o.suppress, voice: o.voice, live: liveCalls.has("s1") });
      await new Promise<void>((r) => gates.push(r));
      over.during?.(text, call);
      const f = over.fail?.(text);
      if (f instanceof Error) throw f;
      if (f) throw new Error("turn failed");
    },
  };
  call = new VoiceCall({
    sessionId: "s1", runner, child, transcriptDir: tmp(), holdIdle: () => true, onClosed: () => {},
    idleFlushMs: over.idleFlushMs ?? 60_000, queueWaitMs: over.queueWaitMs,
  });
  const release = () => gates.shift()?.();
  const start = async () => {
    const p = call.start(init(call.callId));
    child.push({ type: "started", callId: call.callId, sampleRate: 24000 });
    await p;
  };
  return { call, child, runs, release, start };
}
const says = (child: { sent: ParentMsg[] }) => child.sent.filter((m) => m.type === "say") as Array<{ text: string; replyTo?: string; asOf: number }>;

describe("VoiceCall delegate queue", () => {
  it("delegates arriving during a running turn merge into ONE next turn, each with its own prompt line", async () => {
    const t = gated();
    await t.start();
    t.child.push({ type: "delegate", id: "1", task: "first", asOf: 0 });
    await until(() => t.runs.length === 1);
    t.child.push({ type: "delegate", id: "2", task: "second", asOf: 0 });
    t.child.push({ type: "delegate", id: "3", task: "third", asOf: 0 });
    t.child.push({ type: "delegate", id: "4", task: "fourth", asOf: 0 });
    await Bun.sleep(10);
    t.release();
    await until(() => t.runs.length === 2);
    t.release();
    await Bun.sleep(20);
    expect(t.runs).toHaveLength(2);
    // Never merged into the running turn.
    expect(t.runs[0]!.text).not.toContain("#2");
    const merged = t.runs[1]!;
    expect(merged).toMatchObject({ suppress: false, voice: true });
    expect(merged.text).toContain("#2, #3, #4");
    for (const [id, task] of [["2", "second"], ["3", "third"], ["4", "fourth"]]) {
      expect(merged.text).toContain(`#${id}: ${task}`);
      expect(merged.text).toContain(`reply_to="${id}"`);
    }
  });

  it("each merged request keeps its own asOf", async () => {
    const t = gated();
    await t.start();
    t.child.push({ type: "delegate", id: "1", task: "first", asOf: 0 });
    await until(() => t.runs.length === 1);
    t.child.push({ type: "transcript", seq: 4, role: "user", text: "a" });
    t.child.push({ type: "delegate", id: "2", task: "second", asOf: 4 });
    t.child.push({ type: "transcript", seq: 9, role: "user", text: "b" });
    t.child.push({ type: "delegate", id: "3", task: "third", asOf: 9 });
    await Bun.sleep(10);
    t.release();
    await until(() => t.runs.length === 2);
    t.call.say("answer two", "next_gap", "2");
    t.call.say("answer three", "next_gap", "3");
    expect(says(t.child).map((s) => s.asOf)).toEqual([4, 9]);
    t.release();
  });

  it("an idle flush due while a turn runs merges into the next delegate turn", async () => {
    const t = gated({ idleFlushMs: 15 });
    await t.start();
    t.child.push({ type: "delegate", id: "1", task: "first", asOf: 0 });
    await until(() => t.runs.length === 1);
    t.child.push({ type: "transcript", seq: 1, role: "user", text: "later remark" });
    await Bun.sleep(40); // the idle flush comes due
    t.child.push({ type: "delegate", id: "2", task: "second", asOf: 1 });
    await Bun.sleep(10);
    t.release();
    await until(() => t.runs.length === 2);
    t.release();
    await Bun.sleep(30);
    expect(t.runs).toHaveLength(2);
    expect(t.runs[1]).toMatchObject({ suppress: false, voice: true });
    expect(t.runs[1]!.text).toContain(`${TRANSCRIPT_FLUSH_PREFIX}\nparticipant: later remark`);
    expect(t.runs[1]!.text).toContain('reply_to="2"');
  });

  it("a queued delegate carries the transcript as of its turn's start, not its arrival", async () => {
    const t = gated();
    await t.start();
    t.child.push({ type: "transcript", seq: 1, role: "user", text: "one" });
    t.child.push({ type: "delegate", id: "1", task: "first", asOf: 1 });
    await until(() => t.runs.length === 1);
    t.child.push({ type: "transcript", seq: 2, role: "user", text: "two" });
    t.child.push({ type: "delegate", id: "2", task: "second", asOf: 2 });
    t.child.push({ type: "transcript", seq: 3, role: "user", text: "three" });
    await Bun.sleep(10);
    // Turn 1 is still running: only seq 1 has been handed to the session.
    t.call.say("heads up", "now");
    expect(says(t.child).at(-1)!.asOf).toBe(1);
    t.release();
    await until(() => t.runs.length === 2);
    expect(t.runs[1]!.text).toContain("participant: two\nparticipant: three");
    t.call.say("heads up again", "now");
    expect(says(t.child).at(-1)!.asOf).toBe(3);
    t.release();
  });

  it("a failed delegate's restored transcript is flushed on the re-armed timer, without new lines", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const t = gated({ idleFlushMs: 20, fail: (x) => x.includes("request #1") });
    await t.start();
    t.child.push({ type: "transcript", seq: 1, role: "user", text: "first" });
    t.child.push({ type: "delegate", id: "1", task: "x", asOf: 1 });
    await until(() => t.runs.length === 1);
    t.release();
    await until(() => says(t.child).length === 1);
    expect(says(t.child)[0]!.text).toContain("Request #1 failed");
    await until(() => t.runs.length === 2, 1000);
    expect(t.runs[1]).toMatchObject({ suppress: true });
    expect(t.runs[1]!.text).toBe(`${TRANSCRIPT_FLUSH_PREFIX}\nparticipant: first`);
    t.release();
    err.mockRestore();
  });

  it("a failed merged turn answers every request in it", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const t = gated({ fail: (x) => x.includes("#2, #3") });
    await t.start();
    t.child.push({ type: "delegate", id: "1", task: "first", asOf: 0 });
    await until(() => t.runs.length === 1);
    t.child.push({ type: "delegate", id: "2", task: "second", asOf: 0 });
    t.child.push({ type: "delegate", id: "3", task: "third", asOf: 0 });
    await Bun.sleep(10);
    t.release();
    await until(() => t.runs.length === 2);
    t.release();
    await until(() => says(t.child).length === 2);
    expect(says(t.child).map((s) => s.replyTo)).toEqual(["2", "3"]);
    expect(says(t.child).every((s) => s.text.includes("failed"))).toBe(true);
    err.mockRestore();
  });

  it("a delegate stuck in the queue past its deadline fails with a say and never runs", async () => {
    const t = gated({ queueWaitMs: 30 });
    await t.start();
    t.child.push({ type: "delegate", id: "1", task: "first", asOf: 0 });
    await until(() => t.runs.length === 1);
    t.child.push({ type: "delegate", id: "2", task: "second", asOf: 0 });
    await until(() => says(t.child).length === 1, 1000);
    expect(says(t.child)[0]).toMatchObject({ replyTo: "2" });
    expect(says(t.child)[0]!.text).toContain("Request #2 failed");
    t.release();
    await Bun.sleep(30);
    expect(t.runs).toHaveLength(1);
  });

  it("a failed merged turn fails only the requests it had not answered", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const t = gated({
      fail: (x) => x.includes("#2, #3"),
      during: (x, call) => { if (x.includes("#2, #3")) call.say("two is done", "next_gap", "2"); },
    });
    await t.start();
    t.child.push({ type: "delegate", id: "1", task: "first", asOf: 0 });
    await until(() => t.runs.length === 1);
    t.child.push({ type: "delegate", id: "2", task: "second", asOf: 0 });
    t.child.push({ type: "delegate", id: "3", task: "third", asOf: 0 });
    await Bun.sleep(10);
    t.release();
    await until(() => t.runs.length === 2);
    t.release();
    await until(() => says(t.child).length === 2);
    await Bun.sleep(10);
    expect(says(t.child).map((s) => [s.replyTo, s.text.includes("failed")])).toEqual([["2", false], ["3", true]]);
    err.mockRestore();
  });

  it("a cancelled turn fails no request", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const t = gated({ fail: () => new VoiceTurnCancelled() });
    await t.start();
    t.child.push({ type: "delegate", id: "1", task: "first", asOf: 0 });
    await until(() => t.runs.length === 1);
    t.release();
    await Bun.sleep(20);
    expect(says(t.child)).toHaveLength(0);
    err.mockRestore();
  });

  it("a turn that fails after the call was cancelled fails no request", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const t = gated({ fail: () => true });
    await t.start();
    t.child.push({ type: "delegate", id: "1", task: "first", asOf: 0 });
    await until(() => t.runs.length === 1);
    const stopping = t.call.stop("session_rebooted");
    t.release();
    await Bun.sleep(20);
    expect(says(t.child)).toHaveLength(0);
    t.child.push({ type: "ended", reason: "session_rebooted" });
    await stopping;
    err.mockRestore();
  });

  it("after the call closed, a late delegate or transcript line opens no batch", async () => {
    // The process exits while its stdout stays open: the call closes on the
    // exit, and the stream can still deliver lines afterwards.
    const q: ChildMsg[] = [{ type: "started", callId: "x", sampleRate: 24000 }];
    let wake: (() => void) | null = null;
    const feed = (m: ChildMsg) => { q.push(m); wake?.(); };
    let exit!: (n: number) => void;
    const sent: ParentMsg[] = [];
    const child: LoopChild = {
      send: (m) => void sent.push(m),
      exited: new Promise<number>((r) => (exit = r)),
      kill: () => {},
      messages: { async *[Symbol.asyncIterator]() { while (true) { if (q.length) { yield q.shift()!; continue; } await new Promise<void>((r) => (wake = r)); } } },
    };
    const runs: string[] = [];
    const runner: TurnRunner = { run: async (_s, text) => { runs.push(text); } };
    const call = new VoiceCall({ sessionId: "s1", runner, child, transcriptDir: tmp(), holdIdle: () => true, onClosed: () => {}, idleFlushMs: 10, exitGraceMs: 5 });
    await call.start(init(call.callId));
    call.stop("stopped").catch(() => {});
    exit(0);
    expect(await call.done).toBe("stopped");
    expect(runs).toHaveLength(1); // the summary
    feed({ type: "delegate", id: "9", task: "late", asOf: 0 });
    feed({ type: "transcript", seq: 5, role: "user", text: "late line" });
    await Bun.sleep(40);
    expect(runs).toHaveLength(1);
    expect(sent.some((m) => m.type === "say")).toBe(false);
  });

  it("a failed flush-only turn puts its transcript back and re-arms the flush", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    let first = true;
    const t = gated({ idleFlushMs: 15, fail: () => { const f = first; first = false; return f; } });
    await t.start();
    t.child.push({ type: "transcript", seq: 1, role: "user", text: "keep me" });
    await until(() => t.runs.length === 1);
    t.release();
    await until(() => t.runs.length === 2, 1000);
    expect(t.runs[1]).toMatchObject({ suppress: true });
    expect(t.runs[1]!.text).toBe(`${TRANSCRIPT_FLUSH_PREFIX}\nparticipant: keep me`);
    t.release();
    err.mockRestore();
  });

  it("a deadline due after the batch started fails nothing", async () => {
    const t = gated({ queueWaitMs: 30 });
    await t.start();
    t.child.push({ type: "delegate", id: "1", task: "first", asOf: 0 });
    await until(() => t.runs.length === 1);
    await Bun.sleep(60); // well past the deadline, while the turn runs
    t.release();
    await Bun.sleep(10);
    expect(says(t.child)).toHaveLength(0);
  });

  it("a cancel with a batch queued drops it: it never runs and its deadline says nothing", async () => {
    const t = gated({ queueWaitMs: 30 });
    await t.start();
    t.child.push({ type: "delegate", id: "1", task: "first", asOf: 0 });
    await until(() => t.runs.length === 1);
    t.child.push({ type: "delegate", id: "2", task: "second", asOf: 0 });
    const stopping = t.call.stop("session_rebooted");
    await Bun.sleep(60);
    t.release();
    t.child.push({ type: "ended", reason: "session_rebooted" });
    await stopping;
    expect(t.runs).toHaveLength(1);
    expect(says(t.child)).toHaveLength(0);
  });

  it("a queued batch runs before the summary", async () => {
    const calls = new VoiceCalls();
    const t = gated();
    await t.start();
    calls.add("s1", t.call);
    try {
      t.child.push({ type: "delegate", id: "1", task: "first", asOf: 0 });
      await until(() => t.runs.length === 1);
      t.child.push({ type: "delegate", id: "2", task: "second", asOf: 0 });
      await Bun.sleep(10);
      t.child.push({ type: "ended", reason: "stopped" });
      t.release();
      await until(() => t.runs.length === 2);
      t.release();
      await until(() => t.runs.length === 3);
      t.release();
      await t.call.done;
      expect(t.runs[1]!.text).toContain('reply_to="2"');
      expect(t.runs[2]!.text).toContain("The voice call has ended");
    } finally {
      calls.remove("s1");
    }
  });
});
