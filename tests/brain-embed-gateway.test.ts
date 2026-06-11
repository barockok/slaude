import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeBrain, embeddingActive, getBrain } from "../src/knowledge/brain";

let home: string | null = null;

afterEach(async () => {
  await closeBrain();
  delete process.env.SLAUDE_BRAIN_HOME;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_DIMENSIONS;
  delete process.env.ZEROENTROPY_API_KEY;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

function freshHome(): void {
  home = mkdtempSync(join(tmpdir(), "slaude-embedgw-"));
  process.env.SLAUDE_BRAIN_HOME = home;
}

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
