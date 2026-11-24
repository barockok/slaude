/** Property tests for the place source naming. A seeded generator, so a failure replays. */
import { describe, expect, test } from "bun:test";
import { isPlaceSourceId, placeSourceId } from "../../src/memory/place";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_:.é\u0000 ";
const str = (r: () => number, max = 40): string => {
  const n = 1 + Math.floor(r() * max);
  let out = "";
  for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(r() * ALPHABET.length)];
  return out;
};

describe("placeSourceId properties", () => {
  const r = rng(24112026);
  const agents = Array.from({ length: 40 }, () => str(r));
  const boundaries = Array.from({ length: 400 }, () => str(r));

  test("the same pair always yields the same source", () => {
    for (const a of agents) for (const b of boundaries.slice(0, 20)) expect(placeSourceId(a, b)).toBe(placeSourceId(a, b));
  });

  test("two different boundary ids of one agent never share a source", () => {
    for (const a of agents) {
      const seen = new Map<string, string>();
      for (const b of new Set(boundaries)) {
        const s = placeSourceId(a, b);
        expect(seen.get(s)).toBeUndefined();
        seen.set(s, b);
      }
    }
  });

  test("two different agents on one boundary never share a source", () => {
    for (const b of boundaries.slice(0, 40)) {
      const seen = new Set<string>();
      for (const a of new Set(agents)) {
        const s = placeSourceId(a, b);
        expect(seen.has(s)).toBe(false);
        seen.add(s);
      }
    }
  });

  test("every source is within 32 characters and matches [a-z0-9-]", () => {
    for (const a of agents) {
      for (const b of boundaries.slice(0, 30)) {
        const s = placeSourceId(a, b);
        expect(s.length).toBeLessThanOrEqual(32);
        expect(s).toMatch(/^[a-z0-9-]{1,32}$/);
        expect(isPlaceSourceId(s)).toBe(true);
      }
    }
  });

  test("a boundary id that ends where the agent id could begin does not blur the pair", () => {
    // The NUL separator keeps (a, bc) and (ab, c) apart for any split of one string.
    const joined = "abcdefgh";
    const seen = new Set<string>();
    for (let i = 1; i < joined.length; i++) seen.add(placeSourceId(joined.slice(0, i), joined.slice(i)));
    expect(seen.size).toBe(joined.length - 1);
  });
});
