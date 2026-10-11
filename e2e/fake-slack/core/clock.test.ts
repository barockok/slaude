import { expect, test } from "bun:test";
import { TsClock } from "./clock";

test("timestamps have Slack's shape and strictly increase within one second", () => {
  const c = new TsClock(() => 1_700_000_000_500);
  const a = c.next();
  const b = c.next();
  expect(a).toMatch(/^\d+\.\d{6}$/);
  expect(a).toBe("1700000000.000001");
  expect(b).toBe("1700000000.000002");
});

test("follows the clock forward and resets the sequence", () => {
  let now = 1_700_000_000_000;
  const c = new TsClock(() => now);
  c.next();
  now += 5_000;
  expect(c.next()).toBe("1700000005.000001");
});

test("never goes backwards when the clock does", () => {
  let now = 1_700_000_010_000;
  const c = new TsClock(() => now);
  const a = c.next();
  now -= 60_000;
  const b = c.next();
  expect(Number(b)).toBeGreaterThan(Number(a));
});
