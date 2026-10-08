// Runs only with VOICE_E2E=1 and real credentials; skipped otherwise.
// Needs: SLAUDE_VOICE_API_KEY (OpenAI), VOICE_E2E_WORKBENCH_URL, VOICE_E2E_STREAM_URL,
// VOICE_E2E_CLEAR_URL, VOICE_E2E_ROUTE, VOICE_E2E_STREAM_TOKEN — from a workbench tab on a
// local test page where browser_audio_start was already called. The stream and clear
// URLs must be on the same origin as VOICE_E2E_WORKBENCH_URL (the link refuses others).
import { describe, it, expect } from "bun:test";
import { runVoiceLoop } from "../../src/voice/loop";
import { AudioLink, type AudioLinkLike } from "../../src/voice/audio-link";
import { OpenAIRealtime } from "../../src/voice/provider/openai-realtime";
import type { ChildMsg, ParentMsg } from "../../src/voice/ipc";

const live = process.env.VOICE_E2E === "1";
describe.skipIf(!live)("voice live", () => {
  it("hears speech played into the tab and answers with audio", async () => {
    const e = process.env;
    const out: ChildMsg[] = [];
    const link = new AudioLink({
      baseUrl: e.VOICE_E2E_WORKBENCH_URL!,
      endpoints: {
        streamUrl: e.VOICE_E2E_STREAM_URL!,
        clearUrl: e.VOICE_E2E_CLEAR_URL!,
        headers: { "X-Browser-Session": e.VOICE_E2E_ROUTE! },
        sampleRate: 24000,
      },
      streamToken: e.VOICE_E2E_STREAM_TOKEN!,
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
        workbenchUrl: e.VOICE_E2E_WORKBENCH_URL!,
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
