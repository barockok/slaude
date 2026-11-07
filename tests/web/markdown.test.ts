import { describe, expect, test } from "bun:test";
import { parseInline, parseMarkdown, safeHref, splitFrontmatter, type Block, type Inline } from "../../src/web/ui/md-parse";

const blocks = (src: string): Block[] => parseMarkdown(src).blocks;
const text = (v: string): Inline => ({ t: "text", v });

/** Every link href anywhere in a document. */
function hrefs(src: string): string[] {
  const out: string[] = [];
  const inl = (xs: Inline[]) => {
    for (const x of xs) {
      if (x.t === "link") out.push(x.href);
      if ("c" in x) inl(x.c);
    }
  };
  const blk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.t === "heading" || b.t === "paragraph") inl(b.c);
      if (b.t === "list") for (const it of b.items) blk(it.blocks);
      if (b.t === "blockquote") blk(b.blocks);
      if (b.t === "table") [b.head, ...b.rows].forEach((r) => r.forEach(inl));
    }
  };
  blk(blocks(src));
  return out;
}

describe("markdown blocks", () => {
  test("headings, ATX and setext", () => {
    expect(blocks("# One\n## Two ##\n###### Six")).toEqual([
      { t: "heading", level: 1, c: [text("One")] },
      { t: "heading", level: 2, c: [text("Two")] },
      { t: "heading", level: 6, c: [text("Six")] },
    ]);
    expect(blocks("Title\n=====\n\nSub\n---")).toEqual([
      { t: "heading", level: 1, c: [text("Title")] },
      { t: "heading", level: 2, c: [text("Sub")] },
    ]);
    expect(blocks("#nospace")).toEqual([{ t: "paragraph", c: [text("#nospace")] }]);
  });

  test("paragraphs split on blank lines, lines inside break", () => {
    expect(blocks("one\ntwo\n\nthree")).toEqual([
      { t: "paragraph", c: [text("one"), { t: "br" }, text("two")] },
      { t: "paragraph", c: [text("three")] },
    ]);
  });

  test("fenced code keeps its text and language, closes on a matching fence", () => {
    expect(blocks("```ts\nconst a = 1;\n\n<b>x</b>\n```\nafter")).toEqual([
      { t: "code", lang: "ts", v: "const a = 1;\n\n<b>x</b>" },
      { t: "paragraph", c: [text("after")] },
    ]);
    expect(blocks("~~~~\n```\nstill code\n~~~~")).toEqual([{ t: "code", lang: "", v: "```\nstill code" }]);
    expect(blocks("```\nunclosed")).toEqual([{ t: "code", lang: "", v: "unclosed" }]);
  });

  test("bullet and ordered lists, nested", () => {
    const [list] = blocks("- a\n- b\n  - b1\n  - b2\n- c");
    expect(list).toMatchObject({ t: "list", ordered: false, tight: true });
    if (list?.t !== "list") throw new Error("not a list");
    expect(list.items).toHaveLength(3);
    expect(list.items[1]!.blocks[1]).toMatchObject({ t: "list", items: [{}, {}] });

    const [ol] = blocks("3. three\n4. four");
    expect(ol).toMatchObject({ t: "list", ordered: true, start: 3 });
  });

  test("task list items", () => {
    const [list] = blocks("- [ ] open\n- [x] done\n- plain");
    if (list?.t !== "list") throw new Error("not a list");
    expect(list.items.map((i) => i.checked)).toEqual([false, true, null]);
    expect(list.items[0]!.blocks).toEqual([{ t: "paragraph", c: [text("open")] }]);
  });

  test("a loose list and a list after a paragraph", () => {
    const [list] = blocks("- a\n\n- b");
    expect(list).toMatchObject({ t: "list", tight: false });
    expect(blocks("Steps:\n- one\n- two").map((b) => b.t)).toEqual(["paragraph", "list"]);
    // An ordered marker that does not start at 1 does not interrupt a paragraph.
    expect(blocks("In\n2024. was a year").map((b) => b.t)).toEqual(["paragraph"]);
  });

  test("blockquotes, nested", () => {
    expect(blocks("> quoted\n> > deeper")).toEqual([
      {
        t: "blockquote",
        blocks: [
          { t: "paragraph", c: [text("quoted")] },
          { t: "blockquote", blocks: [{ t: "paragraph", c: [text("deeper")] }] },
        ],
      },
    ]);
  });

  test("tables with alignment and escaped pipes", () => {
    expect(blocks("| a | b | c |\n|:--|:-:|--:|\n| 1 | `x|y` | 3 \\| 4 |")).toEqual([
      {
        t: "table",
        align: ["left", "center", "right"],
        head: [[text("a")], [text("b")], [text("c")]],
        rows: [[[text("1")], [{ t: "code", v: "x|y" }], [text("3 | 4")]]],
      },
    ]);
    // A delimiter row with the wrong cell count is not a table.
    expect(blocks("a | b\n--|--|--").map((b) => b.t)).not.toContain("table");
  });

  test("horizontal rules, and a dash line under text is a heading", () => {
    expect(blocks("***\n- - -\n___")).toEqual([{ t: "hr" }, { t: "hr" }, { t: "hr" }]);
  });

  test("deep nesting stops at a limit instead of overflowing", () => {
    const deep = `${">".repeat(5000)} x`;
    expect(() => parseMarkdown(deep)).not.toThrow();
    const stars = `${"*a ".repeat(3000)}`;
    expect(() => parseMarkdown(stars)).not.toThrow();
  });
});

describe("markdown inline", () => {
  test("emphasis, strong, strikethrough and code", () => {
    expect(parseInline("a **b** *c* _d_ ~~e~~ `f`")).toEqual([
      text("a "),
      { t: "strong", c: [text("b")] },
      text(" "),
      { t: "em", c: [text("c")] },
      text(" "),
      { t: "em", c: [text("d")] },
      text(" "),
      { t: "del", c: [text("e")] },
      text(" "),
      { t: "code", v: "f" },
    ]);
  });

  test("intraword underscores and lone stars stay text", () => {
    expect(parseInline("snake_case_name")).toEqual([text("snake_case_name")]);
    expect(parseInline("2 * 3 * 4")).toEqual([text("2 * 3 * 4")]);
  });

  test("code spans keep their content literally", () => {
    expect(parseInline("`` a ` b ``")).toEqual([{ t: "code", v: "a ` b" }]);
    expect(parseInline("`**not bold**`")).toEqual([{ t: "code", v: "**not bold**" }]);
  });

  test("backslash escapes and entities", () => {
    expect(parseInline("\\*not em\\* &amp; &lt;b&gt; &#65;")).toEqual([text("*not em* & <b> A")]);
  });

  test("links, autolinks and bare urls", () => {
    expect(parseInline("[docs](https://example.com/a_(b) \"t\")")).toEqual([
      { t: "link", href: "https://example.com/a_(b)", c: [text("docs")] },
    ]);
    expect(parseInline("<https://example.com>")).toEqual([{ t: "link", href: "https://example.com", c: [text("https://example.com")] }]);
    expect(parseInline("see https://example.com/x.")).toEqual([
      text("see "),
      { t: "link", href: "https://example.com/x", c: [text("https://example.com/x")] },
      text("."),
    ]);
    expect(parseInline("[mail](mailto:jane@example.com)")).toEqual([{ t: "link", href: "mailto:jane@example.com", c: [text("mail")] }]);
  });

  test("images are never loaded: alt text, linked when the source is safe", () => {
    expect(parseInline("![a cat](https://example.com/cat.png)")).toEqual([
      { t: "link", href: "https://example.com/cat.png", c: [text("a cat")] },
    ]);
  });
});

describe("markdown safety", () => {
  test("safeHref allows only http, https and mailto", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("HTTP://example.com")).toBe("HTTP://example.com");
    expect(safeHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      "\u0000javascript:alert(1)",
      " javascript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "/relative/path",
      "//example.com",
      "file:///etc/passwd",
      "https://",
      "mailto:",
    ]) {
      expect(safeHref(bad)).toBeNull();
    }
  });

  test("unsafe link targets render as text, never as links", () => {
    expect(hrefs("[click](javascript:alert(1))")).toEqual([]);
    expect(hrefs("[x](data:text/html;base64,PHNjcmlwdD4=)")).toEqual([]);
    expect(hrefs("<javascript:alert(1)>")).toEqual([]);
    expect(hrefs("![x](javascript:alert(1))")).toEqual([]);
    expect(hrefs("[x](  javascript:alert(1) )")).toEqual([]);
    expect(hrefs("[x](java&#09;script:alert(1))")).toEqual([]);
    expect(parseInline("[click](javascript:alert(1))")).toEqual([text("click")]);
  });

  test("raw HTML is kept as text", () => {
    expect(blocks("<script>alert(1)</script>")).toEqual([{ t: "paragraph", c: [text("<script>alert(1)</script>")] }]);
    expect(blocks('<img src=x onerror="alert(1)">')).toEqual([{ t: "paragraph", c: [text('<img src=x onerror="alert(1)">')] }]);
    expect(parseInline("&lt;script&gt;")).toEqual([text("<script>")]);
  });

  test("an html-looking link text stays text inside a safe link", () => {
    expect(parseInline("[<b>x</b>](https://example.com)")).toEqual([
      { t: "link", href: "https://example.com", c: [text("<b>x</b>")] },
    ]);
  });
});

describe("markdown frontmatter", () => {
  test("top-level keys, lists and block scalars", () => {
    const { frontmatter, body } = splitFrontmatter(
      "---\nname: triage\ndescription: \"Sort the queue\"\ngoverns:\n  - mcp__a__b\n  - mcp__c__d\nnotes: |\n  line one\n  line two\n---\n# Body",
    );
    expect(frontmatter?.entries).toEqual([
      { key: "name", value: "triage" },
      { key: "description", value: "Sort the queue" },
      { key: "governs", value: "mcp__a__b, mcp__c__d" },
      { key: "notes", value: "line one\nline two" },
    ]);
    expect(body).toBe("# Body");
  });

  test("no frontmatter, or a rule later in the text, is body", () => {
    expect(splitFrontmatter("# T\n---\nx").frontmatter).toBeNull();
    expect(parseMarkdown("text").frontmatter).toBeNull();
  });
});
