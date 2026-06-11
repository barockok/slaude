import { describe, expect, test } from "bun:test";
import { sessionIdOpts } from "../../src/agent/session-id-opts";

describe("sessionIdOpts", () => {
  test("fresh session: seeds the CLI with slaude's id", () => {
    expect(sessionIdOpts({ id: "abc-123", claude_started: 0 })).toEqual({
      extraArgs: { "session-id": "abc-123" },
    });
  });
  test("started session: resumes the same id", () => {
    expect(sessionIdOpts({ id: "abc-123", claude_started: 1 })).toEqual({
      resume: "abc-123",
    });
  });
});
