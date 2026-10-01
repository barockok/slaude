import { describe, expect, test } from "bun:test";
import { extractSoulData, SoulExtractionError } from "../../src/soul/extract";

const SOUL = "# Ana\nManager: <@UTESTUSER1>\n";
const failing = async () => { throw new Error("provider down"); };

describe("extractSoulData", () => {
  test("strict: a failing extractor throws instead of degrading", async () => {
    await expect(extractSoulData(SOUL, { strict: true, call: failing })).rejects.toThrow(SoulExtractionError);
  });

  test("non-strict: a failing extractor falls back, as loadSoulData always has", async () => {
    const d = await extractSoulData(SOUL, { strict: false, call: failing });
    expect(Array.isArray(d.approvers)).toBe(true);
  });

  test("the same text is extracted once and then served from the sha cache", async () => {
    let calls = 0;
    const call = async () => { calls++; return JSON.stringify({ approvers: [] }); };
    const text = `${SOUL}\n<!-- ${Date.now()} -->`;
    await extractSoulData(text, { strict: true, call });
    await extractSoulData(text, { strict: true, call });
    expect(calls).toBe(1);
  });
});
