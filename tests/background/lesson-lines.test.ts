import { describe, expect, test } from "bun:test";
import { lessonLineViolation, lessonPageViolation } from "../../src/background/lesson-lines";

const ok = (t: string) => `- 2026-11-24 ${t}`;

describe("lessonLineViolation accepts a general line", () => {
  for (const t of [
    "Confirm the deadline before promising a date.",
    "When a reply is corrected, restate the corrected fact first (replaces: 2026-11-01).",
    "Keep status replies to three sentences; offer detail on request.",
    "Ask which environment is meant before running a destructive command.",
  ]) test(t, () => expect(lessonLineViolation(ok(t))).toBeNull());
});

describe("lessonLineViolation refuses anything that points at a thing", () => {
  const bad: Array<[string, string]> = [
    ["a platform id", "Check with U0ABCDEF1 before merging."],
    ["a platform id", "Post updates in C012AB3CD45 only."],
    ["a mention", "Tell <@U0ABCDEF1> first."],
    ["a mention", "Ask @dana about the release."],
    ["a mention", "Use <!here> sparingly."],
    ["a channel name", "Do not post in #team-ops after hours."],
    ["a mention", "Link to <#C012AB3CD45|ops> when asked."],
    ["an email address", "Send the report to jane.doe@example.org."],
    ["a URL", "See https://example.org/runbook for steps."],
    ["a URL", "Read www.example.org first."],
    ["a host name", "The staging.example.io box restarts at night."],
    ["an IP address", "The host at 10.0.0.12 drops connections."],
    ["a platform id", "Prefer slack:channel:C0123456789 for alerts."],
    ["a typed reference", "Prefer slack:channel:general for alerts."],
    ["a typed reference", "Treat email:person:jane as the owner."],
    ["a source id", "Pages in mb-0123456789abcdef0123456789ab are stale."],
    ["a source id", "Read agent-udefault before answering."],
    ["a page slug", "Update conversations/abc123 after each turn."],
    ["a page slug", "Keep people/someone current."],
    ["a message timestamp", "Reply under 1699999999.000100 instead."],
    ["a long identifier", "Use ticket 4829104857 as the key."],
    ["a long identifier", "Hash 3f2a9c1b7d4e5f60 is the right one."],
    ["a provenance note", "Be brief (source: thread with the team; evidence: correction)."],
  ];
  for (const [what, t] of bad) {
    test(`${what}: ${t.slice(0, 40)}`, () => {
      const why = lessonLineViolation(ok(t));
      expect(why).not.toBeNull();
      expect(why).toContain(what);
    });
  }
  test("a refusal never repeats the matched text", () => {
    expect(lessonLineViolation(ok("Check with U0ABCDEF1 before merging."))).not.toContain("U0ABCDEF1");
  });
});

describe("shape", () => {
  test("a line is `- YYYY-MM-DD text`, one line", () => {
    expect(lessonLineViolation("Be brief.")).toContain("YYYY-MM-DD");
    expect(lessonLineViolation("- 2026-11-24")).not.toBeNull();
    expect(lessonLineViolation("- 2026-11-24 a\n- 2026-11-24 b")).toContain("one line");
  });
});

describe("lessonPageViolation", () => {
  test("names the first bad line and passes unchanged lines already on the page", () => {
    const old = "- 2025-01-01 An old lesson (source: U0ABCDEF1; evidence: pattern)";
    expect(lessonPageViolation([ok("Be brief."), old])).toBe("line 2: it holds a platform id");
    expect(lessonPageViolation([ok("Be brief."), old], new Set([old]))).toBeNull();
    expect(lessonPageViolation([ok("Be brief."), ok("See https://x.example.org")])).toBe("line 2: it holds a URL");
  });
});
