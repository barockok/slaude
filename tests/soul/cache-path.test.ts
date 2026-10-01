import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { extractSoulData, soulCachePath } from "../../src/soul/extract";

describe("soulCachePath", () => {
  test("a seed written at soulCachePath(text) IS what extraction reads", async () => {
    const text = `# Seeded\nNo approvers here ${Date.now()}-${Math.random()}\n`;
    const p = soulCachePath(text);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ approvers: [] }));
    try {
      const d = await extractSoulData(text, {
        strict: true,
        call: async () => { throw new Error("must not be called"); },
      });
      expect(d.approvers).toEqual([]);
    } finally {
      rmSync(p, { force: true });
    }
  });
});
