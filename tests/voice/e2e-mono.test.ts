/**
 * Whole chain in one process: voice tools -> VoiceCall -> child loop (runVoiceLoop
 * with provider/audio fakes over an in-memory pair) -> conductor -> delegated
 * turn on a stub agent that speaks through the voice tools -> quiet thread ->
 * summary. The thread's Slack writes go through the REAL quietForVoice wrapper
 * and the real monoRunner; only the model and the wire are faked.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createVoiceMcp, type VoiceHost } from "../../src/agent/voice-mcp";
import type { Surface } from "../../src/gateway/core/surface";
import { VoiceCalls, type LoopChild } from "../../src/voice/call";
import type { ChildMsg, ParentMsg } from "../../src/voice/ipc";
import { runVoiceLoop } from "../../src/voice/loop";
import { monoRunner } from "../../src/voice/runners";
import { injectedTurns, quietForVoice, voiceTurns } from "../../src/voice/turn-flags";
import { FakeAudio, FakeProvider, chan, until } from "./fakes";

const SID = "s-e2e";
const cfg = { provider: "openai" as const, model: "m", apiKey: "k", workbenchUrl: "https://wb.example.com", maxMinutes: 120, staleSeq: 6 };
const audioArg = { stream_url: "/s", clear_url: "/c", headers: {}, sample_rate: 24000 };

/** A LoopChild whose far end is runVoiceLoop in this process. */
function inProcessChild(provider: FakeProvider, audio: FakeAudio) {
  const toChild = chan<ParentMsg | null>();
  const toParent = chan<ChildMsg | null>();
  let exit!: (n: number) => void;
  const exited = new Promise<number>((r) => (exit = r));
  let started = false;
  const inbox = (async function* () {
    while (true) {
      const m = await toChild.recv();
      if (!m) return;
      if (m.type !== "init") yield m;
    }
  })();
  const child: LoopChild = {
    send(m) {
      if (m.type === "init" && !started) {
        started = true;
        void runVoiceLoop({ init: m.init, makeProvider: () => provider, audio, inbox, emit: (x) => toParent.send(x), tickMs: 5 })
          .then(() => { toParent.send(null); exit(0); });
        return;
      }
      toChild.send(m);
    },
    messages: (async function* () {
      while (true) {
        const m = await toParent.recv();
        if (!m) return;
        yield m;
      }
    })(),
    exited,
    kill: () => { toChild.send(null); exit(137); },
  };
  return child;
}

describe("voice e2e (in-process, mono)", () => {
  it("delegate -> turn with transcript -> voice_say -> provider speaks; thread quiet during the call; summary after", async () => {
    const provider = new FakeProvider();
    const audio = new FakeAudio();
    const posted: string[] = [];
    const surface = {
      id: "slack", capabilities: new Set(), getHistory: async () => [], requestApproval: async () => ({ approved: true, by: "U1" }),
      reply: async (i: { text: string }) => { posted.push(i.text); return { ref: "1.0" }; },
    } as unknown as Surface;
    const quiet = quietForVoice(surface, SID);

    const turns: string[] = [];
    const flagsDuringTurn: Array<{ voice: boolean; injected: boolean }> = [];
    const events = new EventEmitter();
    let inFlight = false;
    let tools: any;
    const agent = Object.assign(events, {
      suppressNextTurn() {},
      isLive: () => true,
      isTurnInFlight: () => inFlight,
      async sendMessage(sid: string, text: string) {
        turns.push(text);
        inFlight = true;
        flagsDuringTurn.push({ voice: voiceTurns.active(sid), injected: injectedTurns.active(sid) });
        if (text.includes("Voice call request #1")) {
          // What a real turn does: try to post, then answer by voice.
          await quiet.reply({ text: "I'll look into the deploy" } as any);
          await tools["voice_say"].handler({ text: "The deploy is green.", when: "next_gap", reply_to: "1" });
        }
        if (text.includes("The voice call has ended")) await quiet.reply({ text: "Summary: deploy is green" } as any);
        queueMicrotask(() => { inFlight = false; events.emit("event", { type: "done", sessionId: sid }); });
      },
    });

    const host: VoiceHost = {
      config: async () => cfg,
      refusal: async () => null,
      stillAllowed: async () => true,
      confirmStart: async () => null,
      runner: () => monoRunner(agent as any, { check: async () => {}, pollMs: 5 }),
      transcriptDir: async () => mkdtempSync(join(tmpdir(), "voice-e2e-")),
      spawn: () => inProcessChild(provider, audio),
      holdIdle: () => true,
      instructions: async (_s, brief) => brief,
    };
    const calls = new VoiceCalls();
    tools = (createVoiceMcp(SID, host, calls) as any).instance._registeredTools;

    const r = await tools["voice_start"].handler({ brief: "deploy sync", audio: audioArg });
    expect(r.isError).toBeFalsy();
    const call = calls.get(SID)!;
    expect(call).toBeDefined();

    provider.emitEvent("transcript", { role: "user", text: "is the deploy green?", itemId: "u1" });
    provider.emitEvent("toolCall", { callId: "c1", name: "delegate", args: { task: "check deploy status" } });
    await until(() => turns.length === 1, 3000);
    expect(turns[0]).toContain("participant: is the deploy green?");
    expect(flagsDuringTurn[0]).toEqual({ voice: true, injected: true });
    await until(() => provider.named("addContext").some((c) => String(c[1]).includes("The deploy is green.")), 3000);
    expect(provider.named("respond").length).toBeGreaterThanOrEqual(1);
    // The turn tried to reply through the real wrapper: dropped.
    await until(() => !voiceTurns.active(SID), 3000);
    expect(posted).toEqual([]);

    const stop = await tools["voice_stop"].handler({});
    expect(JSON.parse(stop.content[0].text).reason).toBe("stopped");
    expect(await call.done).toBe("stopped");
    await until(() => calls.get(SID) === undefined, 3000);

    // Summary turn ran as an injected, non-voice turn, so its post goes through.
    const last = flagsDuringTurn.at(-1)!;
    expect(last).toEqual({ voice: false, injected: true });
    expect(turns.at(-1)).toContain("The voice call has ended (reason: stopped)");
    expect(posted).toEqual(["Summary: deploy is green"]);
    expect(audio.closed).toBe(true);
    expect(voiceTurns.active(SID)).toBe(false);
    expect(injectedTurns.active(SID)).toBe(false);

    // The transcript file the summary turn was told to attach.
    const path = /upload tool: (\S+)/.exec(turns.at(-1)!)![1]!;
    expect(readFileSync(path, "utf8")).toContain("participant: is the deploy green?");
  });
});
