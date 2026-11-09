import { describe, expect, test } from "bun:test";
import { hardenNodeProcess } from "../../src/node/harden";

const SET = 4;
const GET = 3;

describe("hardenNodeProcess", () => {
  test("sets non-dumpable and verifies it took", () => {
    const calls: Array<[number, number]> = [];
    const warnings: string[] = [];
    const ok = hardenNodeProcess({ platform: "linux", prctl: () => (o, a) => (calls.push([o, a]), 0), warn: (m) => warnings.push(m) });
    expect(ok).toBe(true);
    expect(calls).toEqual([[SET, 0], [GET, 0]]);
    expect(warnings).toEqual([]);
  });

  test("warns when prctl refuses, when it does not take, and when libc cannot load", () => {
    for (const prctl of [
      () => () => -1,
      () => (o: number) => (o === GET ? 1 : 0),
      () => { throw new Error("no libc"); },
    ]) {
      const warnings: string[] = [];
      expect(hardenNodeProcess({ platform: "linux", prctl, warn: (m) => warnings.push(m) })).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("non-dumpable");
    }
  });

  test("warns and does nothing off Linux", () => {
    const warnings: string[] = [];
    let called = false;
    expect(hardenNodeProcess({ platform: "darwin", prctl: () => { called = true; return () => 0; }, warn: (m) => warnings.push(m) })).toBe(false);
    expect(called).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});
