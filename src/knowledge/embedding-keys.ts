/**
 * The brain's embedding providers and the environment variable holding each
 * one's key (null = keyless or optional-key provider). The brain runs in the
 * gateway process (or a brain server); no agent child needs these keys, so
 * every one is on the child-scrub list (src/agent/child-env.ts). Kept free of
 * imports so child-env can read it without loading the brain.
 */
export const EMBEDDING_PROVIDER_KEY_ENV: Readonly<Record<string, string | null>> = {
  zeroentropyai: "ZEROENTROPY_API_KEY",
  openai: "OPENAI_API_KEY",
  voyage: "VOYAGE_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  minimax: "MINIMAX_API_KEY",
  together: "TOGETHER_API_KEY",
  litellm: null,
  ollama: null,
  "llama-server": null,
};
