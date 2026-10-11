import { describe, it, expect } from "bun:test";
import { PanelVoiceRedactor } from "../../src/gateway/panel/voice-redact";

const CAP = "cap-7Hq2Lm";
const audio = {
  stream_url: `https://wb.example.com/api/browser/audio/${CAP}/stream`,
  clear_url: `https://wb.example.com/api/browser/audio/${CAP}/clear`,
  headers: { "X-Browser-Session": "rk-55" },
  sample_rate: 24000,
};
const startCall = { type: "toolCall", sessionId: "S", tool: "mcp__slaude_voice__voice_start", input: { brief: "standup", audio } };
const audioResult = { type: "toolResult", sessionId: "S", tool: "mcp__browser__browser_audio_start", result: JSON.stringify(audio) };

describe("PanelVoiceRedactor (panel event stream)", () => {
  it("masks voice_start's capability URLs and route header values in the timeline event", () => {
    const out = JSON.stringify(new PanelVoiceRedactor().scrub(startCall));
    expect(out).not.toContain(CAP);
    expect(out).not.toContain("rk-55");
    expect(out).toContain("https://wb.example.com/…");
    expect(out).toContain("standup");
    expect(out).toContain("X-Browser-Session");
  });

  it("masks the browser_audio_start result, whose text carries the URLs", () => {
    const out = JSON.stringify(new PanelVoiceRedactor().scrub(audioResult));
    expect(out).not.toContain(CAP);
  });

  it("remembers learned URLs: a later event echoing the secret is masked too", () => {
    const r = new PanelVoiceRedactor();
    r.learn(audioResult);
    const later = { type: "assistantText", sessionId: "S", text: `the stream is at /api/browser/audio/${CAP}/stream (key ${CAP})` };
    const out = JSON.stringify(r.scrub(later));
    expect(out).not.toContain(CAP);
  });

  it("leaves unrelated events untouched", () => {
    const ev = { type: "toolCall", sessionId: "S", tool: "Bash", input: { command: "ls" } };
    expect(new PanelVoiceRedactor().scrub(ev)).toEqual(ev);
  });
});
