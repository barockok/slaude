import { describe, expect, test } from "bun:test";
import { findTag, lastTagIn, messageText, paramInt, parseDurationMs, parseTag, stripTags } from "./tag";
import type { MockRequest } from "./types";

describe("parseTag", () => {
  test("parses a bare tag", () => {
    expect(parseTag("hi [[mock:echo]] there")).toEqual({ name: "echo", params: {} });
  });
  test("parses params", () => {
    expect(parseTag("[[mock:multi-tool n=3 tool=Bash]]")).toEqual({
      name: "multi-tool",
      params: { n: "3", tool: "Bash" },
    });
  });
  test("returns null without a tag, and for uppercase or unterminated tags", () => {
    expect(parseTag("no tag here")).toBeNull();
    expect(parseTag("[[MOCK:echo]]")).toBeNull();
    expect(parseTag("[[mock:echo")).toBeNull();
  });
  test("ignores params that break the grammar", () => {
    expect(parseTag("[[mock:echo Bad=1]]")).toBeNull();
  });
});

describe("lastTagIn", () => {
  test("returns the last of several tags", () => {
    expect(lastTagIn("[[mock:echo]] a [[mock:think]] b")?.name).toBe("think");
  });
  test("returns null when there is none", () => {
    expect(lastTagIn("nothing")).toBeNull();
  });
});

describe("stripTags", () => {
  test("removes tags and collapses whitespace", () => {
    expect(stripTags("  hello [[mock:echo n=1]]   world ")).toBe("hello world");
  });
});

describe("messageText", () => {
  test("handles string, part arrays and null", () => {
    expect(messageText({ role: "user", content: "a" })).toBe("a");
    expect(messageText({ role: "user", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })).toBe("a\n\nb");
    expect(messageText({ role: "user", content: null })).toBe("");
  });
});

describe("findTag", () => {
  const req = (...msgs: MockRequest["messages"]): MockRequest => ({ messages: msgs });

  test("picks the most recent user message that carries a tag", () => {
    const found = findTag(
      req(
        { role: "user", content: "[[mock:echo]] first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "[[mock:think]] second" },
      ),
    );
    expect(found).toEqual({ index: 2, tag: { name: "think", params: {} } });
  });

  test("ignores tags inside assistant messages", () => {
    const found = findTag(
      req({ role: "user", content: "[[mock:echo]] q" }, { role: "assistant", content: "[[mock:think]] echoed" }),
    );
    expect(found?.tag.name).toBe("echo");
    expect(found?.index).toBe(0);
  });

  test("skips user messages without a tag, and returns null when none has one", () => {
    expect(findTag(req({ role: "user", content: "plain" }))).toBeNull();
    expect(findTag(req({ role: "user", content: "[[mock:echo]]" }, { role: "user", content: "plain" }))?.index).toBe(0);
  });
});

describe("paramInt", () => {
  test("parses, defaults on missing or non-numeric", () => {
    const tag = { name: "x", params: { n: "3", bad: "abc" } };
    expect(paramInt(tag, "n", 9)).toBe(3);
    expect(paramInt(tag, "missing", 9)).toBe(9);
    expect(paramInt(tag, "bad", 9)).toBe(9);
  });
});

describe("parseDurationMs", () => {
  test("parses ms, s and bare numbers; defaults otherwise", () => {
    expect(parseDurationMs("500ms", 0)).toBe(500);
    expect(parseDurationMs("2s", 0)).toBe(2000);
    expect(parseDurationMs("750", 0)).toBe(750);
    expect(parseDurationMs(undefined, 7)).toBe(7);
    expect(parseDurationMs("soon", 7)).toBe(7);
  });
});
