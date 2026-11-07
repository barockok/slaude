import { describe, expect, test } from "bun:test";
import { CONNECT_RESULT, connectionDetail, isConnectResult, linkedViaLabel } from "../../src/web/portal/lib/labels";
import { shortDate } from "../../src/web/shared/time";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("linkedViaLabel", () => {
  test("names the signed link", () => {
    expect(linkedViaLabel("signed-link")).toBe("/link in Slack");
  });
  test("sentence-cases an unknown method", () => {
    expect(linkedViaLabel("admin_import")).toBe("Admin import");
    expect(linkedViaLabel("oauth")).toBe("Oauth");
  });
  test("an empty or separator-only method is Unknown", () => {
    expect(linkedViaLabel("")).toBe("Unknown");
    expect(linkedViaLabel("--")).toBe("Unknown");
  });
});

describe("connectionDetail", () => {
  test("nothing for a connection without an expiry", () => {
    expect(connectionDetail(null, NOW)).toBe("");
  });
  test("a past or current expiry renews on next use, not an error", () => {
    expect(connectionDetail(NOW - 2 * DAY, NOW)).toBe("Renews on next use");
    expect(connectionDetail(NOW, NOW)).toBe("Renews on next use");
  });
  test("a near expiry is relative", () => {
    expect(connectionDetail(NOW + 3 * HOUR, NOW)).toBe("Access token expires in 3 h");
    expect(connectionDetail(NOW + 10 * MIN, NOW)).toBe("Access token expires in 10 min");
    expect(connectionDetail(NOW + 5 * DAY, NOW)).toBe("Access token expires in 5 d");
  });
  test("a far expiry is a date", () => {
    const at = NOW + 60 * DAY;
    expect(connectionDetail(at, NOW)).toBe(`Access token valid until ${shortDate(at)}`);
  });
  test("defaults now to the clock", () => {
    expect(connectionDetail(Date.now() - 1)).toBe("Renews on next use");
  });
});

describe("isConnectResult", () => {
  test("accepts every result the callback sends", () => {
    for (const r of ["connected", "expired", "failed", "no-flow", "state-mismatch", "exchange-failed"]) {
      expect(isConnectResult(r)).toBe(true);
      expect(CONNECT_RESULT[r as keyof typeof CONNECT_RESULT].title.length).toBeGreaterThan(0);
    }
  });
  test("rejects anything else, including inherited keys", () => {
    for (const r of ["", "nope", "toString", "__proto__", "constructor"]) expect(isConnectResult(r)).toBe(false);
  });
  test("only connected is a success", () => {
    expect(CONNECT_RESULT.connected.tone).toBe("success");
    expect(Object.entries(CONNECT_RESULT).filter(([, v]) => v.tone === "success").map(([k]) => k)).toEqual(["connected"]);
  });
});
