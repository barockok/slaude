import { describe, expect, test } from "bun:test";
import matter from "gray-matter";
// js-yaml 3 (gray-matter's parser) ships no types.
// @ts-ignore
import yaml from "js-yaml";
import { composePage, CREDENTIAL_REFUSAL, parseFrontmatter, PAGE_TYPES, readPageRecord } from "../../src/knowledge/memory-pages";

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
      'supersedes: "notes/old"',
      'symptom: "slow builds"',
      'last_touched: "2026-10-24"',
      "---",
      "Body text.",
      "",
    ].join("\n"));
  });

  test("subject: JSON-quoted after source; needs a type; not a field name", () => {
    const c = content(composePage(page({ type: "person-note", source: "told by U0BOB", subject: "U0ALICE" }), NOW));
    expect(c.split("\n").slice(3, 6)).toEqual(["confidence: inferred", 'source: "told by U0BOB"', 'subject: "U0ALICE"']);
    expect(parseFrontmatter(c).meta.subject).toBe("U0ALICE");
    expect(error(composePage(page({ subject: "U0ALICE" }), NOW))).toContain("need a type");
    expect(error(composePage(page({ type: "person-note", fields: { subject: "U0BOB" } }), NOW))).toContain("common key");
    expect(error(composePage(page({ type: "person-note", subject: "U0A\nx" }), NOW))).toContain("one line");
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
    const want = "refused: page contains a credential-like value; remove that value and try again";
    expect(CREDENTIAL_REFUSAL).toBe(want);
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

describe("composed frontmatter is valid YAML", () => {
  const tricky = ["@alice", ">later", "- x", "2026-11-01", "yes", "1e3", "a: b", "#tag", "[x]", "{y}", "|z", "'q'", '"dq"', "*ref", "&anchor", "!tag", "%dir", "`tick", "", " padded ", "ünïcode ✓", "back\\slash"];

  test("every free-text value reads back as the same string with js-yaml and gray-matter", () => {
    const fields: Record<string, string> = {};
    tricky.forEach((v, i) => { fields[`f${i}`] = v; });
    const c = content(composePage(page({ type: "investigation", source: "@U0ALICE", supersedes: "- old", fields }), NOW));
    const block = /^---\n([\s\S]*?)\n---\n/.exec(c)![1]!;
    const parsed = yaml.safeLoad(block) as Record<string, unknown>;
    const gm = matter(c).data as Record<string, unknown>;
    for (const data of [parsed, gm]) {
      expect(data.source).toBe("@U0ALICE");
      expect(data.supersedes).toBe("- old");
      tricky.forEach((v, i) => expect(data[`f${i}`]).toBe(v));
      expect(data.type).toBe("investigation");
    }
    const ours = parseFrontmatter(c).meta;
    tricky.forEach((v, i) => expect(ours[`f${i}`]).toBe(v));
    expect(matter(c).content).toBe("Body text.\n");
  });

  test("only validated enum values and as_of are plain", () => {
    const c = content(composePage(page({ type: "commitment", confidence: "told", fields: { status: "open", beneficiary: "U0ALICE", on_no_change: "silent", due: "2026-11-01" } }), NOW));
    expect(c).toContain("\ntype: commitment\n");
    expect(c).toContain("\nas_of: 2026-10-25\n");
    expect(c).toContain("\nconfidence: told\n");
    expect(c).toContain("\nstatus: open\n");
    expect(c).toContain("\non_no_change: silent\n");
    expect(c).toContain('\nbeneficiary: "U0ALICE"\n');
    expect(c).toContain('\ndue: "2026-11-01"\n');
    expect((matter(c).data as Record<string, unknown>).due).toBe("2026-11-01");
  });
});

// The record shape the real engine returned (gbrain get_page, measured
// 2026-10-26): `type` in its own column, not in `frontmatter`; `as_of` an ISO
// timestamp string; `tags` empty even for a page tagged by add_tag (readers
// take superseded status from a tag listing, supersededSlugs).
describe("readPageRecord against the real engine's record shape", () => {
  test("type comes from the record's column; as_of reads back as a date", () => {
    const rec = readPageRecord({
      slug: "commitments/deploy-42",
      type: "commitment",
      compiled_truth: "Tell Alice when deploy 42 is out.",
      frontmatter: { due: "after deploy 42 ships", as_of: "2026-10-26T00:00:00.000Z", status: "open", beneficiary: "U0ALICE" },
      tags: [],
    });
    expect(rec).toEqual({
      meta: { due: "after deploy 42 ships", as_of: "2026-10-26", status: "open", beneficiary: "U0ALICE", type: "commitment" },
      body: "Tell Alice when deploy 42 is out.",
      superseded: false,
    });
  });

  test("a frontmatter type wins over the column; a timestamp that is not midnight is kept", () => {
    const rec = readPageRecord({ type: "note", compiled_truth: "x", frontmatter: { type: "profile", as_of: "2026-10-26T09:30:00.000Z" } });
    expect(rec!.meta).toEqual({ type: "profile", as_of: "2026-10-26T09:30:00.000Z" });
  });
});
