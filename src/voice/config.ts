/**
 * Voice provider configuration (voice mode spec §9, plan deviation 2). v1 reads
 * SLAUDE_VOICE_* env: mono from its own env; in the gateway topology the
 * gateway reads env and ships a VoiceBundle in the runtime bundle, so a node
 * never holds a voice key (or voice limits) in its own environment.
 */
import { env } from "../config/env";

export type VoiceProviderId = "openai" | "openai-live" | "gemini";
const PROVIDERS: readonly VoiceProviderId[] = ["openai", "openai-live", "gemini"];

export interface VoiceConfig {
  provider: VoiceProviderId;
  model: string;
  voice?: string;
  apiKey: string;
  workbenchUrl: string;
  maxMinutes: number;
  staleSeq: number;
}

/** What the gateway ships to a node. `model` stays provider-qualified. */
export interface VoiceBundle {
  model: string;
  voice?: string;
  apiKey: string;
  workbenchUrl: string;
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

export function voiceBundleFromEnv(): VoiceBundle | null {
  if (!env.voice.enabled()) return null;
  const apiKey = env.voice.apiKey();
  const workbenchUrl = env.voice.workbenchUrl();
  if (!apiKey || !workbenchUrl) return null;
  const model = env.voice.model();
  parseVoiceModel(model); // fail loudly on a bad model at the source
  return {
    model, voice: env.voice.voiceName(), apiKey, workbenchUrl,
    maxMinutes: env.voice.maxMinutes(), staleSeq: env.voice.staleSeq(),
  };
}

export function voiceConfigFromBundle(b: VoiceBundle | null | undefined): VoiceConfig | null {
  if (!b) return null;
  const { provider, model } = parseVoiceModel(b.model);
  return {
    provider, model, voice: b.voice, apiKey: b.apiKey, workbenchUrl: b.workbenchUrl,
    maxMinutes: b.maxMinutes, staleSeq: b.staleSeq,
  };
}

export function voiceConfigFromEnv(): VoiceConfig | null {
  return voiceConfigFromBundle(voiceBundleFromEnv());
}
