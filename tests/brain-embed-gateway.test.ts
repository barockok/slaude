import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeBrain, defaultDimensionsForModel, embeddingActive, getBrain, resolveEmbeddingApiKey, canonicalizeEmbeddingModel, applyEmbeddingEnv, EMBEDDING_PROVIDERS, normalizeEmbeddingProvider } from "../src/knowledge/brain";
import { readFileSync } from "node:fs";

let home: string | null = null;

afterEach(async () => {
  await closeBrain();
  delete process.env.SLAUDE_BRAIN_HOME;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_DIMENSIONS;
  delete process.env.EMBEDDING_URL;
  delete process.env.ZEROENTROPY_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.EMBEDDING_API_KEY;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

function freshHome(): void {
  home = mkdtempSync(join(tmpdir(), "slaude-embedgw-"));
  process.env.SLAUDE_BRAIN_HOME = home;
}

describe("resolveEmbeddingApiKey", () => {
  test("resolves canonical env directly", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "goog-key-1";
    const res = resolveEmbeddingApiKey("google");
    expect(res.key).toBe("goog-key-1");
    expect(res.canonical).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(res.isRequired).toBe(true);
  });

  test("resolves GEMINI_API_KEY alias and populates canonical env for google", () => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    process.env.GEMINI_API_KEY = "gemini-alias-key";
    const res = resolveEmbeddingApiKey("google");
    expect(res.key).toBe("gemini-alias-key");
    expect(res.canonical).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY as string | undefined).toBe("gemini-alias-key");
  });

  test("resolves generic EMBEDDING_API_KEY alias for any provider", () => {
    delete process.env.ZEROENTROPY_API_KEY;
    process.env.EMBEDDING_API_KEY = "generic-embed-key";
    const res = resolveEmbeddingApiKey("zeroentropyai");
    expect(res.key).toBe("generic-embed-key");
    expect(res.canonical).toBe("ZEROENTROPY_API_KEY");
    expect(process.env.ZEROENTROPY_API_KEY as string | undefined).toBe("generic-embed-key");
  });

  test("handles keyless providers", () => {
    const res = resolveEmbeddingApiKey("litellm");
    expect(res.isRequired).toBe(false);
  });
});

describe("defaultDimensionsForModel", () => {
  test("resolves known provider dimensions", () => {
    expect(defaultDimensionsForModel("google:text-embedding-004")).toBe(768);
    expect(defaultDimensionsForModel("zeroentropyai:zembed-1")).toBe(1280);
    expect(defaultDimensionsForModel("voyage:voyage-3")).toBe(1024);
    expect(defaultDimensionsForModel("openai:text-embedding-3-small")).toBe(1536);
  });

  test("falls back cleanly for unknown qualified and generic models", () => {
    expect(defaultDimensionsForModel("unknown-provider:some-model")).toBe(2560);
    expect(defaultDimensionsForModel("text-embedding-3-small")).toBe(1536);
  });
});

describe("embedding gateway activation", () => {
  test("inactive when no embedding configured", async () => {
    freshHome();
    await getBrain();
    expect(embeddingActive()).toBe(false);
  }, 60_000);

  test("inactive when provider key env is missing — sync must not attempt embeds", async () => {
    freshHome();
    process.env.EMBEDDING_MODEL = "zeroentropyai:zembed-1";
    await getBrain();
    expect(embeddingActive()).toBe(false);
  }, 60_000);

  test("active once model + provider key present (keyless provider counts)", async () => {
    freshHome();
    process.env.EMBEDDING_MODEL = "litellm:test-embed"; // litellm key is optional
    process.env.EMBEDDING_DIMENSIONS = "8";
    await getBrain();
    expect(embeddingActive()).toBe(true);
  }, 60_000);
});

describe("canonicalizeEmbeddingModel with provider enum", () => {
  test("resolves default model when EMBEDDING_PROVIDER is specified without model", () => {
    expect(canonicalizeEmbeddingModel(undefined, undefined, "google")).toBe("google:text-embedding-004");
    expect(canonicalizeEmbeddingModel(undefined, undefined, "openai")).toBe("openai:text-embedding-3-small");
    expect(canonicalizeEmbeddingModel(undefined, undefined, "voyage")).toBe("voyage:voyage-3");
    expect(canonicalizeEmbeddingModel(undefined, undefined, "zeroentropyai")).toBe("zeroentropyai:zembed-1");
    expect(canonicalizeEmbeddingModel(undefined, undefined, "litellm")).toBe("litellm:text-embedding-3-small");
  });

  test("normalizes provider aliases (gemini -> google, zeroentropy -> zeroentropyai, azure -> azure-openai)", () => {
    expect(canonicalizeEmbeddingModel(undefined, undefined, "gemini")).toBe("google:text-embedding-004");
    expect(canonicalizeEmbeddingModel(undefined, undefined, "zeroentropy")).toBe("zeroentropyai:zembed-1");
    expect(canonicalizeEmbeddingModel(undefined, undefined, "azure")).toBe("azure-openai:text-embedding-3-small");
  });

  test("pairs explicit EMBEDDING_PROVIDER with user-chosen bare model", () => {
    expect(canonicalizeEmbeddingModel("text-embedding-3-large", undefined, "openai")).toBe("openai:text-embedding-3-large");
    expect(canonicalizeEmbeddingModel("custom-gemini-embed", undefined, "google")).toBe("google:custom-gemini-embed");
  });

  test("honors explicit fully-qualified provider prefix in model", () => {
    expect(canonicalizeEmbeddingModel("voyage:voyage-code-3", undefined, "openai")).toBe("voyage:voyage-code-3");
    expect(canonicalizeEmbeddingModel("gemini:text-embedding-004")).toBe("google:text-embedding-004");
  });

  test("infers provider from present environment API key when model is bare", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
    expect(canonicalizeEmbeddingModel("any-custom-model")).toBe("google:any-custom-model");
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    process.env.OPENAI_API_KEY = "test-key";
    expect(canonicalizeEmbeddingModel("any-custom-model")).toBe("openai:any-custom-model");
    delete process.env.OPENAI_API_KEY;
  });

  test("returns undefined when no provider, model, or url configured", () => {
    expect(canonicalizeEmbeddingModel()).toBeUndefined();
  });

  test("falls back to litellm when URL is provided", () => {
    expect(canonicalizeEmbeddingModel(undefined, "http://localhost:8000/v1")).toBe("litellm:text-embedding-3-small");
    expect(canonicalizeEmbeddingModel("custom-model", "http://localhost:8000/v1")).toBe("litellm:custom-model");
  });
});

describe("applyEmbeddingEnv", () => {
  test("writes deterministic provider and model configuration to config.json", () => {
    freshHome();
    process.env.EMBEDDING_PROVIDER = "google";
    applyEmbeddingEnv();

    const cfg = JSON.parse(readFileSync(join(home!, "config.json"), "utf8"));
    expect(cfg.embedding_provider).toBe("google");
    expect(cfg.embedding_model).toBe("google:text-embedding-004");
    expect(cfg.embedding_dimensions).toBe(768);
  });

  test("resets dimensions to model default when switching provider without explicit dims", () => {
    freshHome();
    // Initially google (768)
    process.env.EMBEDDING_PROVIDER = "google";
    applyEmbeddingEnv();

    let cfg = JSON.parse(readFileSync(join(home!, "config.json"), "utf8"));
    expect(cfg.embedding_dimensions).toBe(768);

    // Switch to openai (1536)
    process.env.EMBEDDING_PROVIDER = "openai";
    applyEmbeddingEnv();

    cfg = JSON.parse(readFileSync(join(home!, "config.json"), "utf8"));
    expect(cfg.embedding_provider).toBe("openai");
    expect(cfg.embedding_model).toBe("openai:text-embedding-3-small");
    expect(cfg.embedding_dimensions).toBe(1536);
  });
});
