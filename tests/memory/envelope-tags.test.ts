import { describe, expect, test } from "bun:test";
import { neutraliseEnvelopeTags } from "../../src/gateway/core/channel-session";
import { ENVELOPE_TAG_NAMES } from "../../src/memory/envelope-tags";
import { readFileSync } from "node:fs";

describe("one list of envelope tags", () => {
  test.each([...ENVELOPE_TAG_NAMES])("a message cannot open or close <%s>", (tag) => {
    expect(neutraliseEnvelopeTags(`<${tag}>x</${tag}>`)).not.toMatch(new RegExp(`<\\s*/?\\s*${tag}\\b`, "i"));
  });

  test("the tags the runtime meets in prompts are all on the list", () => {
    for (const t of ["system-reminder", "session-mode", "remote-mode", "profile", "cron", "wake", "auto-evolve", "runtime-baseline", "mcp-servers", "recent-turns", "open-commitments", "lessons", "heartbeat", "user", "assistant", "channel-mandate", "channel-notes", "thread-head"]) {
      expect(ENVELOPE_TAG_NAMES).toContain(t as never);
    }
  });

  test("both neutralisers read the shared list, neither keeps its own", () => {
    for (const f of ["src/gateway/core/channel-session.ts", "src/memory/turn-context.ts"]) {
      const text = readFileSync(f, "utf8");
      expect(text).toContain("ENVELOPE_TAG_ALTERNATION");
      expect(text).not.toMatch(/memory-context\|runtime-check/);
    }
  });

  test("an ordinary attribute that starts like a tag name is left alone", () => {
    expect(neutraliseEnvelopeTags("<@U1> asked <user_id=3> about <usersgroup>")).toBe("<@U1> asked <user_id=3> about <usersgroup>");
  });
});
