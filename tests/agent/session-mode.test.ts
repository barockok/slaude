import { describe, expect, test } from "bun:test";
import { sessionModeBlock } from "../../src/agent/session-mode";
import type { OneOnOneLockRow } from "../../src/db/one-on-one";

const lock = (locked_user: string): OneOnOneLockRow => ({
  channel_id: "C1",
  thread_ts: "1.1",
  locked_user,
  created_by: locked_user,
  created_at: 0,
});

describe("sessionModeBlock", () => {
  test("locked thread → a <session-mode> block naming the locked user", () => {
    const b = sessionModeBlock(lock("U123"));
    expect(b).toContain("<session-mode>");
    expect(b).toContain("</session-mode>");
    expect(b).toContain("1on1");
    expect(b).toContain("<@U123>");
  });

  test("unlocked thread → empty string (no block)", () => {
    expect(sessionModeBlock(null)).toBe("");
  });
});
