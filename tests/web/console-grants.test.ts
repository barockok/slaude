import { describe, expect, test } from "bun:test";
import { GRANT_STATES } from "../../src/access/grant-state";
import { STATE_HINT, STATE_LABEL, STATE_TONE, isPersonRef, normaliseSubjectInput, subjectIdError, subjectPlaceholder } from "../../src/web/console/lib/grant-input";

describe("the grant form's person references (slice C task 22)", () => {
  test("a Slack id is validated and upper-cased as before", () => {
    expect(subjectIdError("user", "U1234ABCD")).toBeNull();
    expect(subjectIdError("user", "alice")).toContain("Slack user id");
    expect(normaliseSubjectInput("u1234abcd")).toBe("U1234ABCD");
    expect(subjectIdError("channel", "email:a@example.com")).toContain("Slack channel id");
  });

  test("an email or user reference keeps its case and passes the form's own check", () => {
    expect(isPersonRef("email:Alice@Example.com")).toBe(true);
    expect(isPersonRef("user:abc")).toBe(true);
    expect(isPersonRef("slack:user:T0EXAMPLE/U0EXAMPLE")).toBe(true);
    expect(isPersonRef("U0EXAMPLE")).toBe(false);
    expect(normaliseSubjectInput("email:Alice@Example.com")).toBe("email:Alice@Example.com");
    expect(subjectIdError("user", "email:alice@example.com")).toBeNull();
    expect(subjectIdError("user", "user:abc123")).toBeNull();
  });

  test("a malformed reference says what is wrong", () => {
    expect(subjectIdError("user", "email:not-an-address")).toContain("one plain address");
    expect(subjectIdError("user", "email:a b@example.com")).toContain("one plain address");
    expect(subjectIdError("user", "user:")).not.toBeNull();
  });

  test("the placeholder mentions an email for a user, not for a channel", () => {
    expect(subjectPlaceholder("user")).toContain("email:");
    expect(subjectPlaceholder("channel")).not.toContain("email:");
  });

  test("every state has a label, a tone and a hint", () => {
    for (const s of GRANT_STATES) {
      expect(STATE_LABEL[s].length).toBeGreaterThan(0);
      expect(["success", "warning", "neutral"]).toContain(STATE_TONE[s]);
      expect(STATE_HINT[s].length).toBeGreaterThan(10);
    }
    expect(STATE_LABEL.active).toBe("Active");
  });
});
