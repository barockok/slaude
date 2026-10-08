import type { VoiceProviderId } from "../config";
import { GeminiLive } from "./gemini-live";
import { OpenAILive } from "./openai-live";
import { OpenAIRealtime } from "./openai-realtime";
import type { VoiceProvider } from "./types";

export function createProvider(o: { provider: VoiceProviderId; model: string; apiKey: string }): VoiceProvider {
  switch (o.provider) {
    case "openai":
      return new OpenAIRealtime({ apiKey: o.apiKey, model: o.model });
    case "openai-live":
      return new OpenAILive({ apiKey: o.apiKey, model: o.model });
    case "gemini":
      return new GeminiLive({ apiKey: o.apiKey, model: o.model });
  }
}
