// tests/voice/conductor.test.ts
import { describe, it, expect } from "bun:test";
import { Conductor, AUTO_RESPONSE_WAIT_MS, STILL_WORKING_MS, CAP_WARNING_MS, RECONNECT_LEAD_MS } from "../../src/voice/conductor";
import { FakeProvider, FakeAudio, pcm } from "./fakes";
import type { ChildMsg, EndReason } from "../../src/voice/ipc";

function setup(over: Partial<{ cancelEmitsDone: boolean; truncate: boolean; maxSessionSec: number; maxMs: number; staleSeq: number }> = {}) {
  const provider = new FakeProvider();
  provider.caps = { inputRate: 24000, outputRate: 24000, truncate: over.truncate ?? true, maxSessionSec: over.maxSessionSec, cancelEmitsDone: over.cancelEmitsDone };
  const audio = new FakeAudio();
  const emitted: ChildMsg[] = [];
  const ended: EndReason[] = [];
  let reconnects = 0;
  const c = new Conductor(
    { provider, audio, emit: (m) => emitted.push(m), end: (r) => ended.push(r), reconnect: () => reconnects++ },
    { outputRate: 24000, staleSeq: over.staleSeq ?? 6, maxMs: over.maxMs ?? 3_600_000, startedAt: 0 },
  );
  return { c, provider, audio, emitted, ended, reconnects: () => reconnects };
}

describe("Conductor", () => {
  it("forwards model audio to the uplink and marks a response active", async () => {
    const { c, audio, provider } = setup();
    c.onAudio(pcm(2400), "i1");
    expect(audio.written.length).toBe(1);
    await c.say({ type: "say", text: "later", when: "next_gap", asOf: 0 });
    expect(provider.named("respond")).toEqual([]); // held: a response is active
  });

  it("flush truncates to played audio and resets the uplink clock", async () => {
    const { c, provider, audio } = setup();
    c.onAudio(pcm(24000), "i1"); // 1000 ms on the uplink clock
    c.onAudio(pcm(24000), "i2"); // i2 starts at 1000 ms
    audio.clearResult = { playedMs: 1400, clearedMs: 600 };
    await c.onSpeechStarted();
    expect(audio.clears).toBe(1);
    expect(provider.named("truncate")).toEqual([["truncate", "i2", 400]]);
    expect(provider.named("cancel")).toEqual([]); // provider cancels itself
    c.onAudio(pcm(24000), "i3"); // starts at the reset clock: 1400
    audio.clearResult = { playedMs: 1500, clearedMs: 900 };
    await c.onSpeechStarted();
    expect(provider.named("truncate").at(-1)).toEqual(["truncate", "i3", 100]);
  });

  it("a failed clear (null) skips truncate and keeps the uplink clock", async () => {
    const { c, provider, audio } = setup();
    c.onAudio(pcm(24000), "i1"); // 1000 ms
    (audio as any).clearResult = null;
    await c.onSpeechStarted();
    expect(provider.named("truncate")).toEqual([]);
    c.onAudio(pcm(24000), "i2"); // starts at 1000 ms: the clock was not reset to 0
    audio.clearResult = { playedMs: 1500, clearedMs: 500 };
    await c.onSpeechStarted();
    expect(provider.named("truncate")).toEqual([["truncate", "i2", 500]]);
  });

  it("a rejecting clear does not throw out of a now-say; the steer is still spoken", async () => {
    const { c, provider, audio } = setup();
    audio.clear = async () => { throw new Error("audio provider down"); };
    c.onAudio(pcm(2400), "i1");
    await c.say({ type: "say", text: "stop, the deploy failed", when: "now", asOf: 0 });
    expect(provider.named("respond").length).toBe(1);
    expect(provider.named("truncate")).toEqual([]);
  });

  it("flush skips truncate when the provider cannot", async () => {
    const { c, provider, audio } = setup({ truncate: false });
    c.onAudio(pcm(2400), "g1");
    await c.onSpeechStarted();
    expect(audio.clears).toBe(1);
    expect(provider.named("truncate")).toEqual([]);
  });

  it("numbers transcripts and emits them", () => {
    const { c, emitted } = setup();
    c.onTranscript({ role: "user", text: "hello", itemId: "u1" });
    c.onTranscript({ role: "assistant", text: "hi", itemId: "i1" });
    expect(emitted).toEqual([
      { type: "transcript", seq: 1, role: "user", text: "hello" },
      { type: "transcript", seq: 2, role: "assistant", text: "hi" },
    ]);
    expect(c.seq).toBe(2);
    expect(c.recentTranscript(1)).toBe("voice: hi");
  });

  it("delegate returns working at once and emits a delegate with asOf", () => {
    const { c, provider, emitted } = setup();
    c.onTranscript({ role: "user", text: "check the deploy", itemId: "u1" });
    c.onToolCall({ callId: "c1", name: "delegate", args: { task: "check the deploy" } }, 0);
    expect(provider.named("toolResult")).toEqual([["toolResult", "c1", { id: "1", status: "working" }]]);
    expect(emitted.at(-1)).toEqual({ type: "delegate", id: "1", task: "check the deploy", asOf: 1 });
  });

  it("end_call ends the call; unknown tools get an error result", () => {
    const { c, provider, ended } = setup();
    c.onToolCall({ callId: "c2", name: "nope", args: {} }, 0);
    c.onToolCall({ callId: "c1", name: "end_call", args: { reason: "asked to leave" } }, 0);
    expect(ended).toEqual(["ended_by_voice"]);
    expect(provider.named("toolResult")[0]![2]).toEqual({ error: "unknown tool nope" });
  });

  it("next_gap waits until nobody speaks and no response is active", async () => {
    const { c, provider } = setup();
    c.onAudio(pcm(10), "i1"); // response active
    await c.say({ type: "say", text: "the deploy is green", when: "next_gap", asOf: 0 });
    expect(provider.named("respond")).toEqual([]);
    c.onResponseDone();
    expect(provider.named("addContext").at(-1)![1]).toContain("the deploy is green");
    expect(provider.named("respond").length).toBe(1);
  });

  it("now preempts: cancel, flush, speak", async () => {
    const { c, provider, audio } = setup();
    c.onAudio(pcm(10), "i1");
    await c.say({ type: "say", text: "correction: it failed", when: "now", asOf: 0 });
    expect(provider.calls.map((x) => x[0])).toEqual(["cancel", "truncate", "addContext", "respond"]);
    expect(audio.clears).toBe(1);
  });

  it("stale now steer downgrades to next_gap", async () => {
    const { c, provider, audio } = setup({ staleSeq: 2 });
    for (let i = 0; i < 5; i++) c.onTranscript({ role: "user", text: `t${i}`, itemId: `u${i}` });
    c.onAudio(pcm(10), "i1"); // response active → no gap
    await c.say({ type: "say", text: "old news", when: "now", asOf: 1 }); // 5-1 > 2
    expect(provider.named("cancel")).toEqual([]);
    expect(audio.clears).toBe(0);
    c.onResponseDone();
    expect(provider.named("respond").length).toBe(1);
  });

  it("nudges once when a delegate is still working after 60s, at a gap", () => {
    const { c, provider } = setup();
    c.onToolCall({ callId: "c1", name: "delegate", args: { task: "x" } }, 0);
    c.tick(STILL_WORKING_MS - 1);
    expect(provider.named("addContext")).toEqual([]);
    c.tick(STILL_WORKING_MS);
    expect(provider.named("addContext").length).toBe(1);
    c.onResponseDone();
    c.tick(STILL_WORKING_MS * 2);
    expect(provider.named("addContext").length).toBe(1);
  });

  it("a reply_to say closes the delegate so no nudge follows", async () => {
    const { c, provider } = setup();
    c.onToolCall({ callId: "c1", name: "delegate", args: { task: "x" } }, 0);
    await c.say({ type: "say", text: "answer", when: "next_gap", replyTo: "1", asOf: 0 });
    c.onResponseDone();
    c.tick(STILL_WORKING_MS);
    expect(provider.named("addContext").length).toBe(1); // the answer only
  });

  it("warns before the cap and ends at the cap", () => {
    const { c, provider, ended } = setup({ maxMs: 600_000 });
    c.tick(600_000 - CAP_WARNING_MS);
    expect(provider.named("addContext").length).toBe(1);
    c.onResponseDone();
    c.tick(600_000 - CAP_WARNING_MS + 1);
    expect(provider.named("addContext").length).toBe(1);
    c.tick(600_000);
    expect(ended).toEqual(["max_duration"]);
  });

  it("asks for a planned reconnect before the provider session limit, only at a gap", () => {
    const s = setup({ maxSessionSec: 600 });
    s.c.onAudio(pcm(10), "i1");
    s.c.tick(600_000 - RECONNECT_LEAD_MS);
    expect(s.reconnects()).toBe(0);
    s.c.onResponseDone();
    s.c.tick(600_000 - RECONNECT_LEAD_MS + 1);
    expect(s.reconnects()).toBe(1);
    s.c.tick(600_000 - RECONNECT_LEAD_MS + 2);
    expect(s.reconnects()).toBe(1);
    s.c.onReconnected(700_000);
    s.c.tick(700_000 + 600_000 - RECONNECT_LEAD_MS);
    expect(s.reconnects()).toBe(2);
  });

  it("a reconnect clears a stuck user-speaking flag", async () => {
    const { c, provider } = setup();
    await c.onSpeechStarted();
    await c.say({ type: "say", text: "after", when: "next_gap", asOf: 0 });
    expect(provider.named("respond")).toEqual([]);
    c.onReconnected(1000);
    c.tick(1001);
    expect(provider.named("respond").length).toBe(1);
  });

  it("ignores the done of a cancelled response", async () => {
    const { c, provider } = setup({ cancelEmitsDone: true });
    c.onAudio(pcm(10), "i1");
    await c.say({ type: "say", text: "now thing", when: "now", asOf: 0 });
    await c.say({ type: "say", text: "queued", when: "next_gap", asOf: 0 });
    c.onResponseDone(); // the cancelled one
    expect(provider.named("respond").length).toBe(1);
    c.onResponseDone(); // the live one
    expect(provider.named("respond").length).toBe(2);
  });

  it("drops late audio of a flushed item", async () => {
    const { c, audio } = setup();
    c.onAudio(pcm(10), "A");
    await c.say({ type: "say", text: "now", when: "now", asOf: 0 });
    c.onAudio(pcm(10), "A");
    expect(audio.written.length).toBe(1);
    c.onAudio(pcm(10), "B");
    expect(audio.written.length).toBe(2);
  });

  it("audio of the next item arriving while the flush's clear is pending is kept", async () => {
    const { c, audio } = setup({ truncate: false });
    let release!: () => void;
    audio.clear = async () => {
      audio.clears++;
      await new Promise<void>((r) => (release = r));
      return audio.clearResult;
    };
    c.onAudio(pcm(1), "A");
    const flushing = c.onSpeechStarted();
    c.onAudio(pcm(2), "B"); // the provider's next item, during the clear round trip
    release();
    await flushing;
    c.onAudio(pcm(3), "B");
    c.onAudio(pcm(4), "A"); // the flushed item's late audio is still dropped
    expect(audio.written.map((p) => p.length)).toEqual([1, 2, 3]);
  });

  it("does not drain at speechStopped; waits for the provider's own reply", async () => {
    const { c, provider } = setup();
    await c.onSpeechStarted();
    await c.say({ type: "say", text: "steer", when: "next_gap", asOf: 0 });
    c.onSpeechStopped();
    expect(provider.named("respond")).toEqual([]);
    c.onAudio(pcm(10), "i1");
    expect(provider.named("respond")).toEqual([]);
    c.onResponseDone();
    expect(provider.named("respond").length).toBe(1);
  });

  it("speaks at the tick when no auto-response arrives", async () => {
    const { c, provider } = setup();
    c.tick(1000);
    await c.onSpeechStarted();
    await c.say({ type: "say", text: "steer", when: "next_gap", asOf: 0 });
    c.onSpeechStopped();
    c.tick(1000 + AUTO_RESPONSE_WAIT_MS - 1);
    expect(provider.named("respond")).toEqual([]);
    c.tick(1000 + AUTO_RESPONSE_WAIT_MS);
    expect(provider.named("respond").length).toBe(1);
  });

  it("an idle now skips cancel and truncate", async () => {
    const { c, provider } = setup();
    await c.say({ type: "say", text: "hi", when: "now", asOf: 0 });
    expect(provider.calls.map((x) => x[0])).toEqual(["addContext", "respond"]);
  });

  it("does nothing after the call ended", async () => {
    const { c, provider } = setup();
    c.onToolCall({ callId: "c1", name: "end_call", args: {} }, 0);
    c.onToolCall({ callId: "c2", name: "delegate", args: { task: "x" } }, 0);
    await c.say({ type: "say", text: "late", when: "now", asOf: 0 });
    expect(provider.calls.map((x) => x[0])).toEqual(["toolResult"]);
  });

  it("setProvider routes later calls to the new provider", () => {
    const { c, provider } = setup();
    const next = new FakeProvider();
    c.setProvider(next);
    c.onToolCall({ callId: "c1", name: "delegate", args: { task: "x" } }, 0);
    c.tick(STILL_WORKING_MS);
    expect(provider.calls).toEqual([]);
    expect(next.named("addContext").length).toBe(1);
  });

  it("context passes text straight to the provider", () => {
    const { c, provider } = setup();
    c.context("fyi");
    expect(provider.named("addContext")).toEqual([["addContext", "fyi"]]);
  });

  it("now after responseDone still flushes queued audio, without cancel", async () => {
    const { c, provider, audio } = setup();
    c.onAudio(pcm(24000), "A");
    c.onResponseDone();
    audio.clearResult = { playedMs: 300, clearedMs: 700 };
    await c.say({ type: "say", text: "now", when: "now", asOf: 0 });
    expect(audio.clears).toBe(1);
    expect(provider.named("cancel")).toEqual([]);
    expect(provider.named("truncate")).toEqual([["truncate", "A", 300]]);
  });
});
