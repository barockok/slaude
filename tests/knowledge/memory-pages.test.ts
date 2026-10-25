import { describe, expect, test } from "bun:test";
import { composePage, markSuperseded, pageMarkdown, parseFrontmatter, PAGE_TYPES } from "../../src/knowledge/memory-pages";

const NOW = new Date("2026-10-25T13:00:00Z");
const page = (over: Record<string, unknown> = {}) => ({ slug: "notes/x", content: "Body text.\n", summary: "s", ...over });
const content = (r: { content: string } | { error: string }): string => {
  if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
  return r.content;
};
const error = (r: { content: string } | { error: string }): string => {
  if (!("error" in r)) throw new Error("expected an error");
  return r.error;
};

describe("PAGE_TYPES", () => {
  test("the exact type strings", () => {
    expect([...PAGE_TYPES]).toEqual(["profile", "person-note", "commitment", "investigation", "correction", "outcome", "lessons", "heartbeat", "team-fact"]);
  });
});

describe("composePage", () => {
  test("type, as_of, confidence first; then source, supersedes, fields; then the body", () => {
    const c = content(composePage(page({
      type: "investigation", confidence: "inferred", source: "C0CHAN:1700000000.000100", supersedes: "notes/old",
      fields: { symptom: "slow builds", last_touched: "2026-10-24" },
    }), NOW));
    expect(c).toBe([
      "---",
      "type: investigation",
      "as_of: 2026-10-25",
      "confidence: inferred",
      'source: "C0CHAN:1700000000.000100"',
      "supersedes: notes/old",
      "symptom: slow builds",
      "last_touched: 2026-10-24",
      "---",
      "Body text.",
      "",
    ].join("\n"));
  });

  test("profile defaults to told and refuses inferred", () => {
    expect(parseFrontmatter(content(composePage(page({ slug: "profile", type: "profile" }), NOW))).meta.confidence).toBe("told");
    expect(error(composePage(page({ slug: "profile", type: "profile", confidence: "inferred" }), NOW))).toContain("told");
  });

  test("person-note defaults to inferred and refuses told", () => {
    expect(parseFrontmatter(content(composePage(page({ type: "person-note" }), NOW))).meta.confidence).toBe("inferred");
    expect(error(composePage(page({ type: "person-note", confidence: "told" }), NOW))).toContain("inferred");
  });

  test("commitment needs status and beneficiary", () => {
    expect(error(composePage(page({ type: "commitment", fields: { beneficiary: "U0ALICE" } }), NOW))).toContain("status");
    expect(error(composePage(page({ type: "commitment", fields: { status: "open" } }), NOW))).toContain("beneficiary");
    expect(error(composePage(page({ type: "commitment", fields: { status: "later", beneficiary: "U0ALICE" } }), NOW))).toContain("status");
  });

  test("commitment keys in their fixed order, then any other key", () => {
    const c = content(composePage(page({
      type: "commitment",
      fields: { extra: "x", status: "open", on_no_change: "silent", check: "is the deploy green", due: "2026-10-26", thread: "C0CHAN:1700000000.000100", beneficiary: "U0ALICE", promiser: "U0AGENT" },
    }), NOW));
    expect(Object.keys(parseFrontmatter(c).meta)).toEqual(["type", "as_of", "promiser", "beneficiary", "thread", "due", "check", "on_no_change", "status", "extra"]);
  });

  test("on_no_change outside close-in-one-line|silent is refused", () => {
    expect(error(composePage(page({ type: "commitment", fields: { status: "open", beneficiary: "U0ALICE", on_no_change: "nag" } }), NOW))).toContain("on_no_change");
    content(composePage(page({ type: "commitment", fields: { status: "open", beneficiary: "U0ALICE", on_no_change: "close-in-one-line" } }), NOW));
  });

  test("an unknown type is refused", () => {
    expect(error(composePage(page({ type: "diary" }), NOW))).toContain("unknown page type");
  });

  test("a confidence other than told|inferred is refused", () => {
    expect(error(composePage(page({ type: "outcome", confidence: "maybe" }), NOW))).toContain("confidence");
  });

  test("a field that reuses a common key, or a key that is not a plain name, is refused", () => {
    expect(error(composePage(page({ type: "outcome", fields: { as_of: "2020-01-01" } }), NOW))).toContain("as_of");
    expect(error(composePage(page({ type: "outcome", fields: { "bad key": "v" } }), NOW))).toContain("bad key");
  });

  test("a multi-line field value is refused", () => {
    expect(error(composePage(page({ type: "outcome", fields: { signal: "a\nb" } }), NOW))).toContain("one line");
  });

  test("typed content that already carries frontmatter is refused", () => {
    expect(error(composePage(page({ type: "outcome", content: "---\ntype: outcome\n---\nbody" }), NOW))).toContain("frontmatter");
  });

  test("a credential-like value is refused, typed or not", () => {
    const want = "refused: page contains a credential-like value";
    expect(error(composePage(page({ type: "outcome", content: "the key is sk-abcdefghijklmnop" }), NOW))).toBe(want);
    expect(error(composePage(page({ type: "outcome", fields: { note: "password: hunter2" } }), NOW))).toBe(want);
    expect(error(composePage(page({ content: "token: abc123" }), NOW))).toBe(want);
  });

  test("content without a type passes through unchanged", () => {
    const raw = "---\ntitle: Old style\n---\n# Old style\n\nUntyped note.\n";
    expect(content(composePage(page({ content: raw }), NOW))).toBe(raw);
  });

  test("typed-only options without a type are refused", () => {
    expect(error(composePage(page({ supersedes: "notes/old" }), NOW))).toContain("type");
    expect(error(composePage(page({ confidence: "told" }), NOW))).toContain("type");
  });

  test("a page cannot supersede itself", () => {
    expect(error(composePage(page({ type: "outcome", supersedes: "notes/x" }), NOW))).toContain("itself");
  });
});

describe("parseFrontmatter", () => {
  test("round-trips composePage", () => {
    const fields = { promiser: "U0AGENT", beneficiary: "U0ALICE", thread: "C0CHAN:1700000000.000100", due: "after the deploy", check: 'look for "done: yes" #1', on_no_change: "silent", status: "open" };
    const c = content(composePage(page({ type: "commitment", source: "told by U0ALICE", supersedes: "commitments/old", fields }), NOW));
    const { meta, body } = parseFrontmatter(c);
    expect(meta).toEqual({ type: "commitment", as_of: "2026-10-25", source: "told by U0ALICE", supersedes: "commitments/old", ...fields });
    expect(body).toBe("Body text.\n");
  });

  test("no frontmatter: empty meta, the whole content as body", () => {
    expect(parseFrontmatter("# Hi\n\ntext")).toEqual({ meta: {}, body: "# Hi\n\ntext" });
  });

  test("single-quoted values are unquoted", () => {
    expect(parseFrontmatter("---\na: 'it''s'\n---\nb").meta).toEqual({ a: "it's" });
  });
});

describe("markSuperseded", () => {
  test("adds superseded_by and keeps the body and the other keys", () => {
    const old = content(composePage(page({ type: "outcome", fields: { signal: "thumbs up" } }), NOW));
    const marked = markSuperseded(old, "notes/new");
    const before = parseFrontmatter(old);
    const after = parseFrontmatter(marked);
    expect(after.body).toBe(before.body);
    expect(after.meta).toEqual({ ...before.meta, superseded_by: "notes/new" });
  });

  test("replaces an earlier superseded_by", () => {
    const once = markSuperseded("---\ntype: outcome\n---\nbody", "a/1");
    const twice = markSuperseded(once, "a/2");
    expect(parseFrontmatter(twice).meta).toEqual({ type: "outcome", superseded_by: "a/2" });
    expect(twice.match(/superseded_by/g)?.length).toBe(1);
  });

  test("a page without frontmatter gets one, body unchanged", () => {
    const m = markSuperseded("# Note\n\ntext\n", "a/2");
    expect(m).toBe("---\nsuperseded_by: a/2\n---\n# Note\n\ntext\n");
  });
});

describe("pageMarkdown", () => {
  test("a string or a { content } page is its own markdown", () => {
    expect(pageMarkdown("x")).toBe("x");
    expect(pageMarkdown({ slug: "a", content: "y" })).toBe("y");
  });

  test("a gbrain page record is rebuilt from frontmatter + compiled truth (+ timeline)", () => {
    const md = pageMarkdown({ slug: "a", type: "outcome", title: "A", compiled_truth: "Body.", timeline: "", frontmatter: { type: "outcome", as_of: "2026-10-24", tags: ["x"] } })!;
    expect(parseFrontmatter(md).meta).toEqual({ type: "outcome", as_of: "2026-10-24", tags: '["x"]', title: "A" });
    expect(parseFrontmatter(md).body).toBe("Body.");
    expect(pageMarkdown({ slug: "a", compiled_truth: "Body.", timeline: "- 2026-10-24 x", frontmatter: {} })).toBe("Body.\n\n---\n\n- 2026-10-24 x");
  });

  test("anything else is null", () => {
    expect(pageMarkdown(null)).toBeNull();
    expect(pageMarkdown({ slug: "a" })).toBeNull();
  });
});
