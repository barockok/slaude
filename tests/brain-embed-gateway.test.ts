import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeBrain, defaultDimensionsForModel, embeddingActive, getBrain, resolveEmbeddingApiKey } from "../src/knowledge/brain";

let home: string | null = null;

afterEach(async () => {
  await closeBrain();
  delete process.env.SLAUDE_BRAIN_HOME;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_DIMENSIONS;
  delete process.env.ZEROENTROPY_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.GEMINI_API_KEY;
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
    expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("gemini-alias-key");
  });

  test("resolves generic EMBEDDING_API_KEY alias for any provider", () => {
    delete process.env.ZEROENTROPY_API_KEY;
    process.env.EMBEDDING_API_KEY = "generic-embed-key";
    const res = resolveEmbeddingApiKey("zeroentropyai");
    expect(res.key).toBe("generic-embed-key");
    expect(res.canonical).toBe("ZEROENTROPY_API_KEY");
    expect(process.env.ZEROENTROPY_API_KEY).toBe("generic-embed-key");
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
