import { describe, it, expect, afterEach } from "bun:test";
import { parseVoiceModel, voiceConfigFromEnv, voiceBundleFromEnv, voiceConfigFromBundle } from "../../src/voice/config";

const KEYS = ["SLAUDE_VOICE_ENABLED", "SLAUDE_VOICE_MODEL", "SLAUDE_VOICE_NAME", "SLAUDE_VOICE_API_KEY",
  "SLAUDE_VOICE_WORKBENCH_URL", "SLAUDE_VOICE_MAX_MINUTES", "SLAUDE_VOICE_STALE_SEQ"];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe("parseVoiceModel", () => {
  it("splits provider and model", () => {
    expect(parseVoiceModel("openai/gpt-realtime")).toEqual({ provider: "openai", model: "gpt-realtime" });
    expect(parseVoiceModel("gemini/gemini-live-2.5-flash")).toEqual({ provider: "gemini", model: "gemini-live-2.5-flash" });
  });
  it("rejects unknown provider and unqualified names", () => {
    expect(() => parseVoiceModel("nope/x")).toThrow(/unknown voice provider/);
    expect(() => parseVoiceModel("gpt-realtime")).toThrow(/provider-qualified/);
  });
});

describe("voiceConfigFromEnv", () => {
  it("is null when disabled", () => {
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
    expect(voiceConfigFromEnv()).toBeNull();
  });
  it("is null when enabled without key or workbench url", () => {
    process.env.SLAUDE_VOICE_ENABLED = "true";
    expect(voiceConfigFromEnv()).toBeNull();
  });
  it("builds the config with defaults", () => {
    process.env.SLAUDE_VOICE_ENABLED = "true";
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
    expect(voiceConfigFromEnv()).toEqual({
      provider: "openai", model: "gpt-realtime", voice: undefined, apiKey: "k",
      workbenchUrl: "https://wb.example.com", maxMinutes: 120, staleSeq: 6,
    });
  });
  it("round-trips through the bundle shape, node uses the bundle's limits not local env", () => {
    process.env.SLAUDE_VOICE_ENABLED = "1";
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
    process.env.SLAUDE_VOICE_NAME = "marin";
    process.env.SLAUDE_VOICE_MAX_MINUTES = "30";
    process.env.SLAUDE_VOICE_STALE_SEQ = "9";
    const b = voiceBundleFromEnv();
    expect(b).toEqual({
      model: "openai/gpt-realtime", voice: "marin", apiKey: "k",
      workbenchUrl: "https://wb.example.com", maxMinutes: 30, staleSeq: 9,
    });
    // a node with different local env still gets the bundle's values
    process.env.SLAUDE_VOICE_MAX_MINUTES = "999";
    process.env.SLAUDE_VOICE_STALE_SEQ = "99";
    const cfg = voiceConfigFromBundle(b)!;
    expect(cfg.maxMinutes).toBe(30);
    expect(cfg.staleSeq).toBe(9);
    expect(voiceConfigFromBundle(null)).toBeNull();
  });
});
