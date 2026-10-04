import { describe, expect, test } from "bun:test";
import { FAILURE_TEXT, createOnceGuard, failureText } from "../../../src/gateway/core/failure-codes";

describe("failure codes", () => {
  test("every code maps to fixed text; the required codes exist", () => {
    for (const c of ["PROVIDER_CREDENTIALS_UNAVAILABLE", "LABEL_MISMATCH", "TURN_FAILED", "UNKNOWN"]) {
      expect(typeof (FAILURE_TEXT as any)[c]).toBe("string");
      expect(failureText(c)).toBe((FAILURE_TEXT as any)[c]);
    }
  });
  test("unknown or absent code gives the generic message", () => {
    expect(failureText("SOMETHING_ELSE")).toBe(FAILURE_TEXT.UNKNOWN);
    expect(failureText(undefined)).toBe(FAILURE_TEXT.UNKNOWN);
    expect(failureText("toString")).toBe(FAILURE_TEXT.UNKNOWN);
  });
  test("once guard admits a key once and is bounded", () => {
    const once = createOnceGuard(2);
    expect(once("a")).toBe(true);
    expect(once("a")).toBe(false);
    once("b");
    once("c");
    expect(once("a")).toBe(true); // evicted
  });
});
