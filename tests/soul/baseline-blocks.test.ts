/**
 * The runtime baseline split into its `##` blocks for the Guardrails page:
 * every block is an exact slice, so the blocks join back to the rendered text,
 * with the brain on and off.
 */
import { describe, expect, test } from "bun:test";
import { runtimeBaseline } from "../../src/soul/loader";
import { splitBaseline } from "../../src/soul/runtime/blocks";
import { paths } from "../../src/config/home";

describe("splitBaseline", () => {
  for (const brain of [true, false]) {
    test(`brain ${brain ? "on" : "off"}: the blocks round-trip and name every heading`, () => {
      const text = runtimeBaseline(brain);
      const blocks = splitBaseline(text);
      expect(blocks.map((b) => b.markdown).join("")).toBe(text);
      expect(blocks[0]!.id).toBe("preamble");
      expect(blocks[0]!.markdown.startsWith("<runtime-baseline>")).toBe(true);
      const titles = blocks.map((b) => b.title);
      for (const t of ["Slack output discipline", "Slack formatting", "How you write", "Approval discipline", "Engagement", "Channel trust", "Progress visibility"]) {
        expect(titles).toContain(t);
      }
      expect(titles.some((t) => t.startsWith("Memory"))).toBe(true);
      expect(titles.some((t) => t.startsWith("Built-in skills"))).toBe(true);
      expect(titles.some((t) => t.startsWith("Harness overrides"))).toBe(true);
      expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
      // The brain-off variant names the knowledge directory on disk.
      expect(text.includes(paths.knowledge)).toBe(!brain);
    });
  }

  test("a heading inside a code fence does not start a block; duplicates get a suffix", () => {
    const text = "intro\n## A\nx\n```\n## Not a heading\n```\n## A\ny\n## `Code` title\nz";
    const blocks = splitBaseline(text);
    expect(blocks.map((b) => b.id)).toEqual(["preamble", "a", "a-2", "code-title"]);
    expect(blocks[1]!.markdown).toBe("## A\nx\n```\n## Not a heading\n```\n");
    expect(blocks.map((b) => b.markdown).join("")).toBe(text);
  });

  test("a fence closes only on its own marker: a ~~~ line inside a ``` block does not end it", () => {
    const text = "## A\n```\n~~~\n## Still code\n~~~\n## Still code too\n```\n## B\nz";
    const blocks = splitBaseline(text);
    expect(blocks.map((b) => b.title)).toEqual(["A", "B"]);
    expect(blocks[0]!.markdown).toContain("## Still code too");
    expect(blocks.map((b) => b.markdown).join("")).toBe(text);
  });

  test("no built-in skills: no such block, nothing lost", () => {
    const text = "<runtime-baseline>\nhi\n## Memory\n- m\n\n\n## Progress visibility\n- p\n</runtime-baseline>";
    const blocks = splitBaseline(text);
    expect(blocks.map((b) => b.title)).toEqual(["Preamble", "Memory", "Progress visibility"]);
    expect(blocks.map((b) => b.markdown).join("")).toBe(text);
  });

  test("text with no heading is one preamble block; empty text is none", () => {
    expect(splitBaseline("just text")).toEqual([{ id: "preamble", title: "Preamble", markdown: "just text" }]);
    expect(splitBaseline("")).toEqual([]);
  });
});
