import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { parseVoiceModel, voiceConfigFromEnv, voiceBundleFromEnv, voiceConfigFromBundle, __resetVoiceConfigLogs } from "../../src/voice/config";

const KEYS = ["SLAUDE_VOICE_ENABLED", "SLAUDE_VOICE_MODEL", "SLAUDE_VOICE_NAME", "SLAUDE_VOICE_API_KEY",
  "SLAUDE_VOICE_WORKBENCH_URL", "SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS", "SLAUDE_VOICE_AUDIO_ALLOWED_HEADERS",
  "SLAUDE_VOICE_AUDIO_REQUIRED_HEADERS", "SLAUDE_VOICE_MAX_MINUTES", "SLAUDE_VOICE_STALE_SEQ"];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe("parseVoiceModel", () => {
  it("splits provider and model", () => {
    expect(parseVoiceModel("openai/gpt-realtime")).toEqual({ provider: "openai", model: "gpt-realtime" });
    expect(parseVoiceModel("gemini/gemini-live-2.5-flash")).toEqual({ provider: "gemini", model: "gemini-live-2.5-flash" });
    expect(parseVoiceModel("openai-live/gpt-live-1")).toEqual({ provider: "openai-live", model: "gpt-live-1" });
  });
  it("rejects unknown provider and unqualified names", () => {
    expect(() => parseVoiceModel("nope/x")).toThrow(/unknown voice provider/);
    expect(() => parseVoiceModel("gpt-realtime")).toThrow(/provider-qualified/);
  });
});

const ORIGIN = "https://audio.example.com";
const enable = () => {
  process.env.SLAUDE_VOICE_ENABLED = "true";
  process.env.SLAUDE_VOICE_API_KEY = "k";
};
const logs = (): { warn: string[]; error: string[]; restore: () => void } => {
  const warn: string[] = [];
  const error: string[] = [];
  const w = console.warn;
  const e = console.error;
  console.warn = (...a: unknown[]) => { warn.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { error.push(a.join(" ")); };
  return { warn, error, restore: () => { console.warn = w; console.error = e; } };
};
beforeEach(() => __resetVoiceConfigLogs());

describe("voiceConfigFromEnv", () => {
  it("is null when disabled", () => {
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS = ORIGIN;
    expect(voiceConfigFromEnv()).toBeNull();
  });
  it("is null when enabled without a key", () => {
    process.env.SLAUDE_VOICE_ENABLED = "true";
    process.env.SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS = ORIGIN;
    expect(voiceConfigFromEnv()).toBeNull();
  });
  it("builds the config with defaults", () => {
    enable();
    process.env.SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS = ORIGIN;
    const cfg = voiceConfigFromEnv()!;
    expect({ ...cfg, audio: undefined }).toEqual({
      provider: "openai", model: "gpt-realtime", voice: undefined, apiKey: "k",
      audio: undefined, maxMinutes: 120, staleSeq: 6,
    });
    expect(cfg.audio.origins.map((r) => r.entry)).toEqual([ORIGIN]);
    expect(cfg.audio.allowedHeaders).toEqual(["x-browser-session"]);
    expect(cfg.audio.requiredHeaders).toEqual(["x-browser-session"]);
  });
  it("round-trips through the bundle shape, node uses the bundle's limits not local env", () => {
    process.env.SLAUDE_VOICE_ENABLED = "1";
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS = "https://Audio.example.com, https://*.example.net:8443";
    process.env.SLAUDE_VOICE_AUDIO_ALLOWED_HEADERS = "X-Browser-Session, X-Route-Hint";
    process.env.SLAUDE_VOICE_AUDIO_REQUIRED_HEADERS = "X-Route-Hint";
    process.env.SLAUDE_VOICE_NAME = "marin";
    process.env.SLAUDE_VOICE_MAX_MINUTES = "30";
    process.env.SLAUDE_VOICE_STALE_SEQ = "9";
    const b = voiceBundleFromEnv();
    expect(b).toEqual({
      model: "openai/gpt-realtime", voice: "marin", apiKey: "k",
      audioAllowedOrigins: [ORIGIN, "https://*.example.net:8443"],
      audioAllowedHeaders: ["x-browser-session", "x-route-hint"],
      audioRequiredHeaders: ["x-route-hint"],
      maxMinutes: 30, staleSeq: 9,
    });
    // a node with different local env still gets the bundle's values
    process.env.SLAUDE_VOICE_MAX_MINUTES = "999";
    process.env.SLAUDE_VOICE_STALE_SEQ = "99";
    process.env.SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS = "https://elsewhere.example.org";
    const cfg = voiceConfigFromBundle(JSON.parse(JSON.stringify(b)))!;
    expect(cfg.maxMinutes).toBe(30);
    expect(cfg.staleSeq).toBe(9);
    expect(cfg.audio.origins.map((r) => r.entry)).toEqual([ORIGIN, "https://*.example.net:8443"]);
    expect(cfg.audio.allowedHeaders).toEqual(["x-browser-session", "x-route-hint"]);
    expect(cfg.audio.requiredHeaders).toEqual(["x-route-hint"]);
    expect(voiceConfigFromBundle(null)).toBeNull();
  });
  it("a bundle from a gateway older than rc.4 (workbenchUrl, no allowlist) names the cause", () => {
    const old = { model: "openai/gpt-realtime", apiKey: "k", workbenchUrl: "https://wb.example.com", maxMinutes: 1, staleSeq: 1 };
    expect(() => voiceConfigFromBundle(old as any)).toThrow("the gateway's voice bundle carries no audio allowlist (gateway older than rc.4?)");
  });
  it("refuses a bundle whose allowlist is empty or malformed", () => {
    const b = { model: "openai/gpt-realtime", apiKey: "k", audioAllowedHeaders: ["x-browser-session"], audioRequiredHeaders: ["x-browser-session"], maxMinutes: 1, staleSeq: 1 };
    expect(() => voiceConfigFromBundle({ ...b, audioAllowedOrigins: [] })).toThrow();
    expect(() => voiceConfigFromBundle({ ...b, audioAllowedOrigins: ["*"] })).toThrow();
  });
});

describe("audio allowlist from env: deny by default", () => {
  it("unset or empty: voice is off, with one log line naming the variable", () => {
    const l = logs();
    try {
      enable();
      expect(voiceBundleFromEnv()).toBeNull();
      process.env.SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS = " , ";
      expect(voiceBundleFromEnv()).toBeNull();
      expect(voiceConfigFromEnv()).toBeNull();
    } finally { l.restore(); }
    // One line per cause (unset, then set but empty), each once.
    const lines = [...l.warn, ...l.error];
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS is unset.*deny/i);
    expect(lines[1]).toMatch(/SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS is set but empty.*deny/i);
  });
  it("a malformed entry disables voice with a loud error", () => {
    const l = logs();
    try {
      enable();
      process.env.SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS = `${ORIGIN}, https://audio.example.com/path`;
      expect(voiceBundleFromEnv()).toBeNull();
      expect(voiceBundleFromEnv()).toBeNull();
    } finally { l.restore(); }
    expect(l.error.length).toBe(1);
    expect(l.error[0]).toMatch(/SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS.*invalid/);
  });
  for (const forbidden of ["Authorization", "Cookie", "Host"]) {
    it(`a forbidden allowed header (${forbidden}) disables voice`, () => {
      const l = logs();
      try {
        enable();
        process.env.SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS = ORIGIN;
        process.env.SLAUDE_VOICE_AUDIO_ALLOWED_HEADERS = `X-Browser-Session,${forbidden}`;
        expect(voiceBundleFromEnv()).toBeNull();
      } finally { l.restore(); }
      expect(l.error.join("\n")).toMatch(/SLAUDE_VOICE_AUDIO_ALLOWED_HEADERS/);
    });
  }
  it("required headers outside the allowed headers disable voice", () => {
    const l = logs();
    try {
      enable();
      process.env.SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS = ORIGIN;
      process.env.SLAUDE_VOICE_AUDIO_REQUIRED_HEADERS = "X-Route-Hint";
      expect(voiceBundleFromEnv()).toBeNull();
    } finally { l.restore(); }
    expect(l.error.join("\n")).toMatch(/SLAUDE_VOICE_AUDIO_REQUIRED_HEADERS.*subset/);
  });
});

describe("deprecated SLAUDE_VOICE_WORKBENCH_URL", () => {
  it("alone: seeds the allowlist with its origin and warns once", () => {
    const l = logs();
    let b;
    try {
      enable();
      process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com:8443/some/path";
      b = voiceBundleFromEnv();
      voiceBundleFromEnv();
    } finally { l.restore(); }
    expect(b!.audioAllowedOrigins).toEqual(["https://wb.example.com:8443"]);
    expect(l.warn.length).toBe(1);
    expect(l.warn[0]).toMatch(/SLAUDE_VOICE_WORKBENCH_URL.*deprecated/);
  });
  it("with SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS set: the allowlist wins, with a warning", () => {
    const l = logs();
    let b;
    try {
      enable();
      process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
      process.env.SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS = ORIGIN;
      b = voiceBundleFromEnv();
    } finally { l.restore(); }
    expect(b!.audioAllowedOrigins).toEqual([ORIGIN]);
    expect(l.warn.length).toBe(1);
    expect(l.warn[0]).toMatch(/SLAUDE_VOICE_WORKBENCH_URL.*ignored/);
  });
  it("an explicitly empty SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS is a deliberate deny: the alias is not used", () => {
    const l = logs();
    try {
      enable();
      process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
      process.env.SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS = "";
      expect(voiceBundleFromEnv()).toBeNull();
      process.env.SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS = "  ";
      expect(voiceBundleFromEnv()).toBeNull();
    } finally { l.restore(); }
    expect(l.warn.some((w) => /SLAUDE_VOICE_WORKBENCH_URL.*ignored/.test(w))).toBe(true);
    expect(l.warn.some((w) => /SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS.*empty.*deny/i.test(w))).toBe(true);
  });
  it("an unparseable legacy URL disables voice", () => {
    const l = logs();
    try {
      enable();
      process.env.SLAUDE_VOICE_WORKBENCH_URL = "not a url";
      expect(voiceBundleFromEnv()).toBeNull();
    } finally { l.restore(); }
    expect(l.error.length).toBe(1);
  });
});

describe("SLAUDE_VOICE_API_KEY is gateway-only", () => {
  it("the agent and brain-think children never inherit it; a node refuses to boot with it", async () => {
    const { scrubChildEnv } = await import("../../src/agent/child-env");
    const { nodeBootCheck } = await import("../../src/config/gateway-only-env");
    expect(scrubChildEnv({ SLAUDE_VOICE_API_KEY: "k", KEEP: "1" })).toEqual({ KEEP: "1" });
    expect(nodeBootCheck({ SLAUDE_VOICE_API_KEY: "k" }).names).toEqual(["SLAUDE_VOICE_API_KEY"]);
  });
});
