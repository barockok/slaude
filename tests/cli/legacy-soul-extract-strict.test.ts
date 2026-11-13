import { describe, expect, test } from "bun:test";
import { extractSoulData, SoulExtractionError } from "../../src/cli/legacy-soul-extract";

const SOUL = "# Ana\nManager: <@UTESTUSER1>\n";
const failing = async () => { throw new Error("provider down"); };

describe("extractSoulData", () => {
  test("a failing extractor throws instead of degrading", async () => {
    await expect(extractSoulData(SOUL, { call: failing })).rejects.toThrow(SoulExtractionError);
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
