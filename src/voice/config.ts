/**
 * Voice provider configuration (voice mode spec §9, plan deviation 2). v1 reads
 * SLAUDE_VOICE_* env: mono from its own env; in the gateway topology the
 * gateway reads env and ships a VoiceBundle in the runtime bundle, so a node
 * never holds a voice key (or voice limits, or the audio allowlist) in its own
 * environment.
 */
import { env } from "../config/env";
import { AudioAclError, buildAudioPolicy, type AudioPolicy } from "./audio-acl";

export type VoiceProviderId = "openai" | "openai-live" | "gemini";
const PROVIDERS: readonly VoiceProviderId[] = ["openai", "openai-live", "gemini"];

export interface VoiceConfig {
  provider: VoiceProviderId;
  model: string;
  voice?: string;
  apiKey: string;
  /** Where the call's audio may go, and which route headers it may carry. */
  audio: AudioPolicy;
  maxMinutes: number;
  staleSeq: number;
}

/** What the gateway ships to a node. `model` stays provider-qualified; the
 *  audio lists are normalised, and the node validates them again. */
export interface VoiceBundle {
  model: string;
  voice?: string;
  apiKey: string;
  audioAllowedOrigins: string[];
  audioAllowedHeaders: string[];
  audioRequiredHeaders: string[];
  maxMinutes: number;
  staleSeq: number;
}

export function parseVoiceModel(qualified: string): { provider: VoiceProviderId; model: string } {
  const i = qualified.indexOf("/");
  if (i <= 0 || i === qualified.length - 1) {
    throw new Error(`voice model must be provider-qualified, e.g. openai/gpt-realtime (got '${qualified}')`);
  }
  const provider = qualified.slice(0, i) as VoiceProviderId;
  if (!PROVIDERS.includes(provider)) throw new Error(`unknown voice provider '${provider}'`);
  return { provider, model: qualified.slice(i + 1) };
}

// The bundle is built per request: each reason is logged once per process.
const logged = new Set<string>();
function logOnce(level: "warn" | "error", line: string): void {
  if (logged.has(line)) return;
  logged.add(line);
  console[level](line);
}
/** Test helper: let the voice config log lines fire again. */
export function __resetVoiceConfigLogs(): void { logged.clear(); }

/**
 * The audio policy from env, or null (voice off). Deny by default: an unset or
 * empty SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS turns voice off with one log line;
 * an invalid entry or header list does the same with a loud error. The
 * deprecated SLAUDE_VOICE_WORKBENCH_URL seeds the list with its origin only
 * when the list itself is unset (not when it is set to empty).
 */
export function audioPolicyFromEnv(): AudioPolicy | null {
  let origins = env.voice.audioAllowedOrigins();
  const legacy = env.voice.deprecatedWorkbenchUrl();
  // Only an UNSET allowlist falls back to the alias: set but empty is a
  // deliberate deny.
  if (legacy && origins !== undefined) {
    logOnce("warn", "[voice] SLAUDE_VOICE_WORKBENCH_URL is deprecated and ignored: SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS is set");
  } else if (legacy) {
    try {
      origins = new URL(legacy).origin;
    } catch {
      logOnce("error", "[voice] disabled: SLAUDE_VOICE_WORKBENCH_URL (deprecated) is not a valid URL");
      return null;
    }
    logOnce("warn", "[voice] SLAUDE_VOICE_WORKBENCH_URL is deprecated: its origin seeds the audio allowlist; set SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS instead");
  }
  if (origins === undefined) {
    logOnce("warn", "[voice] disabled: SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS is unset (deny by default); list the audio provider origins voice may send call audio to");
    return null;
  }
  if (!origins.split(",").some((s) => s.trim())) {
    logOnce("warn", "[voice] disabled: SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS is set but empty (deliberate deny)");
    return null;
  }
  try {
    return buildAudioPolicy({
      origins,
      allowedHeaders: env.voice.audioAllowedHeaders(),
      requiredHeaders: env.voice.audioRequiredHeaders(),
    });
  } catch (e) {
    if (!(e instanceof AudioAclError)) throw e;
    logOnce("error", `[voice] disabled: invalid audio config: ${e.message}`);
    return null;
  }
}

export function voiceBundleFromEnv(): VoiceBundle | null {
  if (!env.voice.enabled()) return null;
  const apiKey = env.voice.apiKey();
  if (!apiKey) return null;
  const audio = audioPolicyFromEnv();
  if (!audio) return null;
  const model = env.voice.model();
  parseVoiceModel(model); // fail loudly on a bad model at the source
  return {
    model, voice: env.voice.voiceName(), apiKey,
    audioAllowedOrigins: audio.origins.map((r) => r.entry),
    audioAllowedHeaders: audio.allowedHeaders,
    audioRequiredHeaders: audio.requiredHeaders,
    maxMinutes: env.voice.maxMinutes(), staleSeq: env.voice.staleSeq(),
  };
}

/** Throws on a bundle whose model or audio policy is invalid. */
export function voiceConfigFromBundle(b: VoiceBundle | null | undefined): VoiceConfig | null {
  if (!b) return null;
  const { provider, model } = parseVoiceModel(b.model);
  // A gateway before rc.4 ships workbenchUrl and no allowlist: say so.
  if (!Array.isArray(b.audioAllowedOrigins)) {
    throw new Error("the gateway's voice bundle carries no audio allowlist (gateway older than rc.4?)");
  }
  const audio = buildAudioPolicy({
    origins: b.audioAllowedOrigins,
    allowedHeaders: b.audioAllowedHeaders ?? [],
    requiredHeaders: b.audioRequiredHeaders ?? [],
  });
  return {
    provider, model, voice: b.voice, apiKey: b.apiKey, audio,
    maxMinutes: b.maxMinutes, staleSeq: b.staleSeq,
  };
}

export function voiceConfigFromEnv(): VoiceConfig | null {
  return voiceConfigFromBundle(voiceBundleFromEnv());
}
