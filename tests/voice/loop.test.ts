import { describe, it, expect } from "bun:test";
import { runVoiceLoop } from "../../src/voice/loop";
import { FakeProvider, FakeAudio, pcm, until } from "./fakes";
import type { ChildMsg, ParentMsg, VoiceInit } from "../../src/voice/ipc";

const init: VoiceInit = {
  callId: "call-1", audio: { streamUrl: "/s", clearUrl: "/c", headers: {}, sampleRate: 24000 },
  workbenchUrl: "https://wb.example.com", instructions: "persona", provider: "openai", model: "m", maxMinutes: 120, staleSeq: 6,
};
function inbox() {
  const q: ParentMsg[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  return {
    push(m: ParentMsg) { q.push(m); wake?.(); },
    close() { done = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (q.length) { yield q.shift()!; continue; }
        if (done) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}

describe("runVoiceLoop", () => {
  it("starts, bridges audio both ways, relays say, and ends on stop", async () => {
    const provider = new FakeProvider();
    const audio = new FakeAudio();
    const ib = inbox();
    const out: ChildMsg[] = [];
    const done = runVoiceLoop({ init, makeProvider: () => provider, audio, inbox: ib, emit: (m) => out.push(m), tickMs: 5 });
    await until(() => out.some((m) => m.type === "started"));
    expect(provider.connects[0]!.instructions).toBe("persona");
    expect(provider.connects[0]!.tools.map((t) => t.name)).toEqual(["delegate", "end_call"]);
    audio.handlers!.onAudio(pcm(480));
    expect(provider.named("sendAudio")).toEqual([["sendAudio", 480]]);
    provider.emitEvent("audio", pcm(240), "i1");
    expect(audio.written.length).toBe(1);
    ib.push({ type: "say", text: "hello all", when: "next_gap", asOf: 0 });
    provider.emitEvent("responseDone");
    await until(() => provider.named("respond").length === 1);
    ib.push({ type: "stop", reason: "stopped" });
    expect(await done).toBe("stopped");
    expect(out.at(-1)).toEqual({ type: "ended", reason: "stopped" });
    expect(audio.closed).toBe(true);
    expect(provider.named("close").length).toBe(1);
  });

  it("resamples the downlink when the provider input rate differs", async () => {
    const provider = new FakeProvider();
    provider.caps = { inputRate: 16000, outputRate: 24000, truncate: false };
    const audio = new FakeAudio();
    const ib = inbox();
    const done = runVoiceLoop({ init, makeProvider: () => provider, audio, inbox: ib, emit: () => {}, tickMs: 5 });
    await until(() => audio.handlers !== null);
    audio.handlers!.onAudio(pcm(480));
    expect(provider.named("sendAudio")).toEqual([["sendAudio", 320]]);
    ib.close();
    expect(await done).toBe("parent_gone");
  });

  it("ends with the workbench reason", async () => {
    const audio = new FakeAudio();
    const out: ChildMsg[] = [];
    const done = runVoiceLoop({ init, makeProvider: () => new FakeProvider(), audio, inbox: inbox(), emit: (m) => out.push(m), tickMs: 5 });
    await until(() => audio.handlers !== null);
    audio.handlers!.onEnded("workbench:tab_closed");
    expect(await done).toBe("workbench:tab_closed");
  });

  it("reconnects on a non-fatal provider drop, then gives up after 3 failed attempts", async () => {
    const made: FakeProvider[] = [];
    const done = runVoiceLoop({
      init, audio: new FakeAudio(), inbox: inbox(), emit: () => {}, tickMs: 5, reconnectDelayMs: 1,
      makeProvider: () => { const p = new FakeProvider(); if (made.length >= 1) p.connectError = new Error("down"); made.push(p); return p; },
    });
    await until(() => made.length === 1 && made[0]!.connects.length === 1);
    made[0]!.emitEvent("error", { fatal: false, message: "x" });
    made[0]!.emitEvent("closed");
    expect(await done).toBe("provider_lost");
    expect(made.length).toBe(4); // initial + 3 failed attempts
  });

  it("holds say/context during a provider reconnect and replays them on the new provider", async () => {
    const made: FakeProvider[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ib = inbox();
    const out: ChildMsg[] = [];
    const done = runVoiceLoop({
      init, audio: new FakeAudio(), inbox: ib, emit: (m) => out.push(m), tickMs: 5, reconnectDelayMs: 1,
      makeProvider: () => {
        const p = new FakeProvider();
        if (made.length >= 1) { const c = p.connect.bind(p); p.connect = async (i) => { await gate; return c(i); }; }
        made.push(p);
        return p;
      },
    });
    await until(() => out.some((m) => m.type === "started"));
    made[0]!.emitEvent("closed");
    await until(() => made.length === 2);
    ib.push({ type: "context", text: "fact during reconnect" });
    ib.push({ type: "say", text: "answer during reconnect", when: "next_gap", asOf: 0 });
    await Bun.sleep(30);
    expect(made[0]!.named("addContext")).toEqual([]);
    expect(made[1]!.named("addContext")).toEqual([]);
    release();
    await until(() => made[1]!.named("respond").length === 1);
    expect(made[1]!.named("addContext")[0]).toEqual(["addContext", "fact during reconnect"]);
    expect(made[0]!.named("addContext")).toEqual([]);
    ib.push({ type: "stop", reason: "stopped" });
    expect(await done).toBe("stopped");
  });

  it("ends provider_failed on a fatal provider error", async () => {
    const p = new FakeProvider();
    const done = runVoiceLoop({ init, makeProvider: () => p, audio: new FakeAudio(), inbox: inbox(), emit: () => {}, tickMs: 5 });
    await until(() => p.connects.length === 1);
    p.emitEvent("error", { fatal: true, message: "bad key" });
    expect(await done).toBe("provider_failed");
  });

  it("resamples provider output to the workbench rate before it reaches the uplink", async () => {
    const provider = new FakeProvider();
    provider.caps = { inputRate: 24000, outputRate: 24000, truncate: true };
    const audio = new FakeAudio();
    const ib = inbox();
    const done = runVoiceLoop({
      init: { ...init, audio: { ...init.audio, sampleRate: 48000 } },
      makeProvider: () => provider, audio, inbox: ib, emit: () => {}, tickMs: 5,
    });
    await until(() => audio.handlers !== null);
    provider.emitEvent("audio", pcm(240), "i1");
    expect(audio.written.length).toBe(1);
    expect(audio.written[0]!.length).toBe(480);
    audio.handlers!.onAudio(pcm(480));
    expect(provider.named("sendAudio")).toEqual([["sendAudio", 240]]);
    ib.close();
    await done;
  });

  it("ends audio_lost when the audio link fails to start", async () => {
    const audio = new FakeAudio();
    audio.start = async () => { throw new Error("workbench endpoint origin mismatch"); };
    const out: ChildMsg[] = [];
    const reason = await runVoiceLoop({ init, makeProvider: () => new FakeProvider(), audio, inbox: inbox(), emit: (m) => out.push(m), tickMs: 5 });
    expect(reason).toBe("audio_lost");
    expect(out.at(-1)).toEqual({ type: "ended", reason: "audio_lost" });
  });

  it("keeps retrying when connect fires a fatal error before rejecting (real adapter behaviour)", async () => {
    const made: FakeProvider[] = [];
    const done = runVoiceLoop({
      init, audio: new FakeAudio(), inbox: inbox(), emit: () => {}, tickMs: 5, reconnectDelayMs: 1,
      makeProvider: () => {
        const p = new FakeProvider();
        if (made.length >= 1) {
          p.connect = async () => { p.emitEvent("error", { fatal: true, message: "handshake" }); throw new Error("down"); };
        }
        made.push(p);
        return p;
      },
    });
    await until(() => made.length === 1 && made[0]!.connects.length === 1);
    made[0]!.emitEvent("closed");
    expect(await done).toBe("provider_lost");
    expect(made.length).toBe(4);
  });

  it("ends provider_failed and closes the provider when the initial connect fails", async () => {
    const p = new FakeProvider();
    p.connectError = new Error("nope");
    const audio = new FakeAudio();
    const out: ChildMsg[] = [];
    const reason = await runVoiceLoop({ init, makeProvider: () => p, audio, inbox: inbox(), emit: (m) => out.push(m), tickMs: 5 });
    expect(reason).toBe("provider_failed");
    expect(p.named("close").length).toBe(1);
    expect(audio.closed).toBe(true);
    expect(out.filter((m) => m.type === "ended")).toEqual([{ type: "ended", reason: "provider_failed" }]);
  });

  it("a hung audio.clear() during a now-say does not block a following stop", async () => {
    const provider = new FakeProvider();
    const audio = new FakeAudio();
    audio.clear = () => new Promise<never>(() => {});
    const ib = inbox();
    const out: ChildMsg[] = [];
    const done = runVoiceLoop({ init, makeProvider: () => provider, audio, inbox: ib, emit: (m) => out.push(m), tickMs: 5 });
    await until(() => out.some((m) => m.type === "started"));
    provider.emitEvent("audio", pcm(240), "i1");
    ib.push({ type: "say", text: "now", when: "now", asOf: 0 });
    ib.push({ type: "stop", reason: "stopped" });
    const r = await Promise.race([done, Bun.sleep(500).then(() => "hung")]);
    expect(r).toBe("stopped");
  });

  it("a hung audio.close() still closes the provider and emits ended", async () => {
    const provider = new FakeProvider();
    const audio = new FakeAudio();
    audio.close = () => new Promise<never>(() => {});
    const ib = inbox();
    const out: ChildMsg[] = [];
    void runVoiceLoop({ init, makeProvider: () => provider, audio, inbox: ib, emit: (m) => out.push(m), tickMs: 5 });
    await until(() => out.some((m) => m.type === "started"));
    ib.push({ type: "stop", reason: "stopped" });
    await until(() => provider.named("close").length === 1);
    await until(() => out.some((m) => m.type === "ended"), 3000);
  });

  it("survives a rejecting audio.clear() on speechStarted and still ends exactly once", async () => {
    const provider = new FakeProvider();
    const audio = new FakeAudio();
    audio.clear = async () => { throw new Error("workbench down"); };
    const ib = inbox();
    const out: ChildMsg[] = [];
    const unhandled: unknown[] = [];
    const h = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", h);
    try {
      const done = runVoiceLoop({ init, makeProvider: () => provider, audio, inbox: ib, emit: (m) => out.push(m), tickMs: 5 });
      await until(() => out.some((m) => m.type === "started"));
      provider.emitEvent("audio", pcm(240), "i1");
      provider.emitEvent("speechStarted");
      await until(() => out.some((m) => m.type === "log" && m.message.startsWith("audio clear failed")));
      ib.push({ type: "stop", reason: "stopped" });
      expect(await done).toBe("stopped");
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
      expect(out.filter((m) => m.type === "ended")).toEqual([{ type: "ended", reason: "stopped" }]);
    } finally {
      process.off("unhandledRejection", h);
    }
  });
});
