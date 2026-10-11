// Runs only with VOICE_E2E=1 and real credentials; skipped otherwise.
// Needs: SLAUDE_VOICE_API_KEY (OpenAI), VOICE_E2E_AUDIO_ORIGIN, VOICE_E2E_STREAM_URL,
// VOICE_E2E_CLEAR_URL, VOICE_E2E_ROUTE — from a browser tab on a local test page where
// the browser audio pipe was already started. The stream and clear URLs are absolute
// capability URLs (the audio session's secret is in the path; no bearer) and must be on
// an origin VOICE_E2E_AUDIO_ORIGIN allowlists (the link refuses others).
import { describe, it, expect } from "bun:test";
import { runVoiceLoop } from "../../src/voice/loop";
import { AudioLink, type AudioLinkLike } from "../../src/voice/audio-link";
import { parseAudioOrigins } from "../../src/voice/audio-acl";
import { OpenAIRealtime } from "../../src/voice/provider/openai-realtime";
import { OpenAILive } from "../../src/voice/provider/openai-live";
import type { ChildMsg, ParentMsg } from "../../src/voice/ipc";

const live = process.env.VOICE_E2E === "1";
describe.skipIf(!live)("voice live", () => {
  it("hears speech played into the tab and answers with audio", async () => {
    const e = process.env;
    const out: ChildMsg[] = [];
    const link = new AudioLink({
      allowedOrigins: parseAudioOrigins(e.VOICE_E2E_AUDIO_ORIGIN!),
      endpoints: {
        streamUrl: e.VOICE_E2E_STREAM_URL!,
        clearUrl: e.VOICE_E2E_CLEAR_URL!,
        headers: { "X-Browser-Session": e.VOICE_E2E_ROUTE! },
        sampleRate: 24000,
      },
    });
    let written = 0;
    const audio: AudioLinkLike = {
      start: (h) => link.start(h),
      clear: () => link.clear(),
      close: () => link.close(),
      write: (p) => { written += p.length; link.write(p); },
    };
    const inbox = (async function* (): AsyncGenerator<ParentMsg> {
      await Bun.sleep(60_000);
      yield { type: "stop", reason: "stopped" };
    })();
    await runVoiceLoop({
      init: {
        callId: "live",
        audio: { streamUrl: e.VOICE_E2E_STREAM_URL!, clearUrl: e.VOICE_E2E_CLEAR_URL!, headers: {}, sampleRate: 24000 },
        audioAllowedOrigins: [e.VOICE_E2E_AUDIO_ORIGIN!],
        instructions: "You are a test assistant. Answer any question in one short sentence.",
        provider: "openai",
        model: "gpt-realtime",
        maxMinutes: 2,
        staleSeq: 6,
      },
      makeProvider: () => new OpenAIRealtime({ apiKey: e.SLAUDE_VOICE_API_KEY!, model: "gpt-realtime" }),
      audio,
      inbox,
      emit: (m) => out.push(m),
    });
    expect(out.some((m) => m.type === "transcript" && m.role === "user")).toBe(true);
    expect(written).toBeGreaterThan(0);
  }, 90_000);
});

// GPT-Live provider check: needs only VOICE_E2E=1 and SLAUDE_VOICE_API_KEY (OpenAI), no
// audio pipe. Prints the numbers the field note asks for; no audio is written anywhere.
describe.skipIf(!live)("voice live: openai-live", () => {
  it("starts a session, speaks a commentary, ends it with a synthetic responseDone, and closes", async () => {
    const p = new OpenAILive({ apiKey: process.env.SLAUDE_VOICE_API_KEY!, model: "gpt-live-1" });
    let samples = 0;
    let firstAt = 0;
    let lastAt = 0;
    let dones = 0;
    p.on("audio", (pcm) => {
      const t = Date.now();
      if (!firstAt) firstAt = t;
      lastAt = t;
      samples += pcm.length;
    });
    p.on("responseDone", () => dones++);
    await p.connect({ instructions: "You are a test assistant. Keep every answer to one short sentence.", tools: [] });
    expect(p.caps.maxSessionSec).toBeGreaterThan(0);
    const silence = new Int16Array(2400); // 100 ms at 24 kHz
    for (let i = 0; i < 30; i++) {
      p.sendAudio(silence);
      await Bun.sleep(100);
    }
    p.addContext("Say hello to the participants.");
    p.respond();
    const deadline = Date.now() + 20_000;
    while (dones === 0 && Date.now() < deadline) await Bun.sleep(100);
    expect(samples).toBeGreaterThan(0);
    expect(dones).toBe(1);
    const audioSec = samples / 24000;
    const wallSec = Math.max(0.001, (lastAt - firstAt) / 1000);
    console.log(`[gpt-live] expires in ${p.caps.maxSessionSec}s; ${audioSec.toFixed(2)}s of audio over ${wallSec.toFixed(2)}s wall (x${(audioSec / wallSec).toFixed(2)} real time)`);
    await p.close();
  }, 60_000);
});
