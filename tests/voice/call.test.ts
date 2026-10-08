import { afterAll, describe, it, expect, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceCall, VoiceCalls, TRANSCRIPT_FLUSH_PREFIX, type LoopChild, type TurnRunner } from "../../src/voice/call";
import type { ChildMsg, ParentMsg, VoiceInit } from "../../src/voice/ipc";
import { until } from "./fakes";

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

function fakeChild() {
  const sent: ParentMsg[] = [];
  const q: ChildMsg[] = [];
  let wake: (() => void) | null = null;
  let exit!: (n: number) => void;
  const child: LoopChild & { push(m: ChildMsg): void; sent: ParentMsg[]; killed: boolean } = {
    sent, killed: false,
    send: (m) => sent.push(m),
    push: (m) => { q.push(m); wake?.(); },
    exited: new Promise<number>((r) => (exit = r)),
    kill() { this.killed = true; exit(137); wake?.(); },
    messages: { async *[Symbol.asyncIterator]() { while (true) { if (q.length) { const m = q.shift()!; yield m; if (m.type === "ended") return; continue; } if (child.killed) return; await new Promise<void>((r) => (wake = r)); } } },
  };
  return child;
}
function recRunner(fail = false) {
  const runs: Array<{ text: string; suppress: boolean; voice: boolean }> = [];
  const runner: TurnRunner = { run: async (_s, text, o) => { runs.push({ text, ...o }); if (fail && o.voice && !o.suppress) throw new Error("turn failed"); } };
  return { runner, runs };
}
const init = (callId: string): VoiceInit => ({ callId, audio: { streamUrl: "/s", clearUrl: "/c", headers: {}, sampleRate: 24000 },
  workbenchUrl: "https://wb.example.com", instructions: "x", provider: "openai", model: "m", maxMinutes: 120, staleSeq: 6 });

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
    expect((t.child.sent[1] as any).asOf).toBe(1);
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

  it("session_rebooted flushes and writes the transcript but skips the summary turn", async () => {
    const t = make();
    await started(t);
    t.child.push({ type: "transcript", seq: 1, role: "user", text: "hi" });
    t.child.push({ type: "ended", reason: "session_rebooted" });
    expect(await t.call.done).toBe("session_rebooted");
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]).toMatchObject({ suppress: true, voice: true });
    const files = readdirSync(t.dir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(t.dir, files[0]!), "utf8")).toContain("participant: hi");
    expect(t.closed()).toBe(1);
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
