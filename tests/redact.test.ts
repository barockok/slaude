import { describe, test, expect } from "bun:test";
import { redactSlack } from "../src/gateway/slack/redact";

describe("redactSlack", () => {
  test("no patterns → passthrough", () => {
    expect(redactSlack("hello world", [])).toBe("hello world");
  });
  test("simple substring match (case-insensitive global)", () => {
    expect(redactSlack("api_key=AKIA1234 and AKIA9999", ["AKIA\\w+"])).toBe(
      "api_key=[REDACTED] and [REDACTED]",
    );
  });
  test("invalid regex skipped, others applied", () => {
    expect(redactSlack("foo bar", ["[unclosed", "foo"])).toBe("[REDACTED] bar");
  });
  test("multiple patterns chained", () => {
    expect(redactSlack("email a@b.com phone 555", ["\\S+@\\S+", "\\d{3}"])).toBe(
      "email [REDACTED] phone [REDACTED]",
    );
  });
});
