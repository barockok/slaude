import { describe, expect, test } from "bun:test";
import { MAX_RULES, parseGuardrail, ruleView, splitFrontmatter, MAX_GUARDRAIL_BYTES } from "../../src/guardrails/format";
import { atPath, combine, stringLeaves, textRuleMatches, toolRuleMatches } from "../../src/guardrails/match";
import { compileGlob, compilePattern, MAX_MATCH_CHARS, MAX_PATTERN_CHARS, PatternError } from "../../src/guardrails/pattern";

const md = (front: string, body = "", rules?: string) =>
  `---\n${front}\n---\n${body}${rules !== undefined ? `\n\n\`\`\`rules\n${rules}\n\`\`\`\n` : ""}`;

const EXAMPLE = md(
  "name: no-outbound-email\ndescription: The agent drafts email but never sends it.\nscope: shared",
  "Draft email, never send it.",
  [
    "- id: no-send",
    "  on: tool",
    "  match:",
    '    tool: "mcp__*__*send*"',
    "    input:",
    '      to: "(?i)@external\\\\.example$"',
    "  action: deny",
    '  message: "Sending email is not allowed; save a draft instead."',
    "- id: no-prices",
    "  on: reply",
    "  match:",
    '    text: "(?i)\\\\b(price|quote)\\\\b.*\\\\$\\\\d"',
    "  action: approve",
    '  message: "Replies with prices need an approver."',
    "- id: no-secrets-in",
    "  on: inbound",
    "  match:",
    '    text: "(?i)password\\\\s*[:=]"',
    "  action: deny",
    '  message: "Please do not paste passwords here."',
  ].join("\n"),
);

describe("parseGuardrail", () => {
  test("the design's example: frontmatter, prose and three rules", () => {
    const g = parseGuardrail("no-outbound-email", EXAMPLE);
    expect(g.errors).toEqual([]);
    expect(g.meta).toMatchObject({ name: "no-outbound-email", scope: "shared", agents: [], channels: [], enabled: true, load: "always" });
    expect(g.prose).toBe("Draft email, never send it.");
    expect(g.rules.map((r) => [r.id, r.on, r.action, r.status])).toEqual([
      ["no-send", "tool", "deny", "enforced"],
      ["no-prices", "reply", "approve", "pending"],
      ["no-secrets-in", "inbound", "deny", "enforced"],
    ]);
    expect(ruleView(g.rules[0]!)).toEqual({
      id: "no-send", on: "tool", action: "deny", message: "Sending email is not allowed; save a draft instead.", status: "enforced",
      tool: ["mcp__*__*send*"], input: { to: "(?i)@external\\.example$" },
    });
    expect(ruleView(g.rules[2]!).text).toBe("(?i)password\\s*[:=]");
  });

  test("no frontmatter, bad YAML, and unknown keys are errors; nothing of the meta applies", () => {
    expect(parseGuardrail("x", "just text").errors[0]).toMatch(/no frontmatter/);
    expect(parseGuardrail("x", "just text").meta).toBeNull();
    const bad = parseGuardrail("x", md("name: [x"));
    expect(bad.meta).toBeNull();
    expect(bad.errors[0]).toMatch(/not valid YAML/);
    const unknown = parseGuardrail("x", md("name: x\nbogus: 1"));
    expect(unknown.meta).toBeNull();
    expect(unknown.errors[0]).toMatch(/frontmatter: .*bogus/);
  });

  test("frontmatter checks: name matches the folder, scope agents needs agents, triggers only with on-match", () => {
    expect(parseGuardrail("y", md("name: x")).errors).toEqual(["frontmatter: name 'x' differs from the guardrail's folder 'y'"]);
    expect(parseGuardrail("x", md("name: x\nscope: agents")).errors[0]).toMatch(/needs at least one name/);
    expect(parseGuardrail("x", md("name: x\nagents: [a]")).errors[0]).toMatch(/only with scope: agents/);
    expect(parseGuardrail("x", md("name: x\nload: on-match")).errors[0]).toMatch(/needs a tool or inbound trigger/);
    expect(parseGuardrail("x", md("name: x\ntriggers: { tool: Bash }")).errors[0]).toMatch(/only with load: on-match/);
    expect(parseGuardrail("x", md("name: x\nchannels: [not-an-id]")).errors[0]).toMatch(/channels entries/);
    expect(parseGuardrail("x", md("name: x\ntriggers: { inbound: '(' }\nload: on-match")).errors.join()).toMatch(/triggers.inbound is not a valid pattern/);
    expect(parseGuardrail("x", md("name: x\ntriggers: { tool: [''] }\nload: on-match")).errors.join()).toMatch(/triggers.tool\[0\]/);
  });

  test("on-match triggers compile", () => {
    const g = parseGuardrail("x", md("name: x\nload: on-match\ntriggers: { tool: ['mcp__*__send*', Bash], inbound: '(?i)invoice', channels: [C1] }"));
    expect(g.errors).toEqual([]);
    expect(g.meta!.triggers.tool.map((p) => p.source)).toEqual(["mcp__*__send*", "Bash"]);
    expect(g.meta!.triggers.inbound!.test("an INVOICE")).toBe(true);
    expect(g.meta!.triggers.channels).toEqual(["C1"]);
    const single = parseGuardrail("x", md("name: x\nload: on-match\ntriggers: { tool: Bash }"));
    expect(single.meta!.triggers.tool).toHaveLength(1);
  });

  test("an invalid rule is reported; the other rules and the prose still load", () => {
    const g = parseGuardrail(
      "x",
      md("name: x", "Be careful.", [
        "- id: good",
        "  on: inbound",
        "  match: { text: hello }",
        "  action: audit",
        "- id: bad-regex",
        "  on: inbound",
        "  match: { text: '(' }",
        "  action: deny",
        "- id: bad-combo",
        "  on: inbound",
        "  match: { text: x }",
        "  action: approve",
        "- id: bad-shape",
        "  on: tool",
        "  match: { text: x }",
        "  action: deny",
        "- id: good",
        "  on: inbound",
        "  match: { text: again }",
        "  action: audit",
        "- on: nowhere",
      ].join("\n")),
    );
    expect(g.rules.map((r) => r.id)).toEqual(["good"]);
    expect(g.prose).toBe("Be careful.");
    expect(g.errors).toHaveLength(5);
    expect(g.errors[0]).toMatch(/^rule bad-regex match.text is not a valid pattern/);
    expect(g.errors[1]).toMatch(/action approve is not available for on: inbound \(deny, audit\)/);
    expect(g.errors[2]).toMatch(/a tool rule matches tool and input, not text/);
    expect(g.errors[3]).toMatch(/id repeats/);
    expect(g.errors[4]).toMatch(/^rule 6: /);
  });

  test("every on/action pair of v1, and the unknown ones", () => {
    const one = (on: string, action: string, match: string) =>
      parseGuardrail("x", md("name: x", "", `- id: r\n  on: ${on}\n  match: ${match}\n  action: ${action}`));
    for (const a of ["deny", "approve", "audit"]) expect(one("tool", a, "{ tool: Bash }").errors).toEqual([]);
    expect(one("tool", "redact", "{ tool: Bash }").errors[0]).toMatch(/not available/);
    for (const a of ["deny", "approve", "redact", "audit"]) expect(one("reply", a, "{ text: x }").errors).toEqual([]);
    for (const a of ["deny", "audit"]) expect(one("inbound", a, "{ text: x }").errors).toEqual([]);
    expect(one("inbound", "redact", "{ text: x }").errors[0]).toMatch(/not available/);
    expect(one("tool", "explode", "{ tool: Bash }").errors[0]).toMatch(/action/);
    expect(one("tool", "deny", "{ input: x }").errors[0]).toMatch(/needs match.tool/);
    expect(one("reply", "deny", "{ tool: Bash }").errors[0]).toMatch(/matches text only/);
    expect(one("reply", "deny", "{}").errors[0]).toMatch(/needs match.text/);
    expect(one("tool", "deny", "{ tool: Bash, input: { 'a..b': x } }").errors[0]).toMatch(/not a dot path/);
    expect(one("tool", "deny", "{ tool: Bash, input: '(?i)rm -rf' }").rules[0]!.tool!.anyValue).toBeDefined();
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, "x"]));
    expect(one("tool", "deny", `{ tool: Bash, input: ${JSON.stringify(many)} }`).errors[0]).toMatch(/at most 20/);
  });

  test("a catastrophic pattern runs in linear time; backtracking constructs are rejected", () => {
    const g = parseGuardrail("x", md("name: x", "", "- id: r\n  on: inbound\n  match: { text: '(a+)+$' }\n  action: deny"));
    expect(g.errors).toEqual([]);
    const evil = "a".repeat(MAX_MATCH_CHARS - 1) + "!";
    const t0 = performance.now();
    expect(g.rules[0]!.text!.test(evil)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(2000);
    for (const p of ["(a)\\1", "(?=a)", "(?<=a)b"]) {
      expect(parseGuardrail("x", md("name: x", "", `- id: r\n  on: inbound\n  match: { text: '${p}' }\n  action: deny`)).errors[0]).toMatch(/not a valid pattern/);
    }
  });

  test("caps: pattern length, rule count, file size, message length", () => {
    expect(() => compilePattern("a".repeat(MAX_PATTERN_CHARS + 1), "p")).toThrow(PatternError);
    expect(() => compilePattern("", "p")).toThrow(/non-empty/);
    expect(() => compileGlob("a".repeat(300), "g")).toThrow(/at most 256/);
    const rules = Array.from({ length: MAX_RULES + 5 }, (_, i) => `- id: r${i}\n  on: inbound\n  match: { text: x }\n  action: audit`).join("\n");
    const g = parseGuardrail("x", md("name: x", "", rules));
    expect(g.rules).toHaveLength(MAX_RULES);
    expect(g.errors[0]).toMatch(/55 rules; at most 50/);
    const big = parseGuardrail("x", "x".repeat(MAX_GUARDRAIL_BYTES + 1));
    expect(big.errors[0]).toMatch(/bytes; at most/);
    expect(parseGuardrail("x", md("name: x", "", `- id: r\n  on: inbound\n  match: { text: x }\n  action: audit\n  message: ${"m".repeat(501)}`)).errors[0]).toMatch(/message/);
  });

  test("the rules block: not a list, bad YAML, unclosed, a second block, tildes", () => {
    expect(parseGuardrail("x", md("name: x", "", "id: r")).errors[0]).toMatch(/must be a YAML list/);
    expect(parseGuardrail("x", md("name: x", "", "- [")).errors[0]).toMatch(/not valid YAML/);
    expect(parseGuardrail("x", "---\nname: x\n---\n```rules\n- id: r\n").errors[0]).toMatch(/not closed/);
    const two = parseGuardrail("x", "---\nname: x\n---\n```rules\n- id: a\n  on: inbound\n  match: { text: x }\n  action: audit\n```\nmid\n```rules\n- id: b\n```\n");
    expect(two.rules.map((r) => r.id)).toEqual(["a"]);
    expect(two.errors[0]).toMatch(/only one rules block/);
    expect(two.prose).toBe("mid");
    const tilde = parseGuardrail("x", "---\nname: x\n---\n~~~~ rules\n- id: a\n  on: inbound\n  match: { text: x }\n  action: audit\n~~~~\n");
    expect(tilde.rules).toHaveLength(1);
    expect(parseGuardrail("x", "---\nname: x\n---\n```rules\n```\n").rules).toEqual([]);
    expect(parseGuardrail("x", "---\nname: x\n---\nprose\n```ts\ncode\n```\n").prose).toBe("prose\n```ts\ncode\n```");
  });

  test("splitFrontmatter tolerates a BOM and CRLF", () => {
    expect(splitFrontmatter("﻿---\r\nname: x\r\n---\r\nbody")).toEqual({ front: "name: x", body: "body" });
  });
});

describe("matching", () => {
  const rule = (rules: string) => parseGuardrail("x", md("name: x", "", rules)).rules[0]!;

  test("tool glob over the full name; input per dot path, never the serialised JSON", () => {
    const r = rule("- id: r\n  on: tool\n  match:\n    tool: 'mcp__*__*send*'\n    input: { to: '@external\\.example$', 'opts.0.cc': '^boss' }\n  action: deny");
    const input = { to: "a@external.example", opts: [{ cc: "boss@x" }] };
    expect(toolRuleMatches(r, "mcp__mail__send_email", input)).toBe(true);
    expect(toolRuleMatches(r, "mcp__mail__draft", input)).toBe(false);
    expect(toolRuleMatches(r, "mcp__mail__send_email", { ...input, to: "a@internal.example" })).toBe(false);
    expect(toolRuleMatches(r, "mcp__mail__send_email", { to: input.to })).toBe(false);
    // A key name or another field's text never satisfies a field pattern.
    const k = rule("- id: r\n  on: tool\n  match: { tool: Bash, input: { command: 'secret' } }\n  action: deny");
    expect(toolRuleMatches(k, "Bash", { secret: "ls", description: "secret" })).toBe(false);
    expect(toolRuleMatches(k, "Bash", { command: "cat secret" })).toBe(true);
    expect(toolRuleMatches(k, "Bash", "not an object")).toBe(false);
  });

  test("one pattern on every string value", () => {
    const r = rule("- id: r\n  on: tool\n  match: { tool: '*', input: '(?i)drop table' }\n  action: deny");
    expect(toolRuleMatches(r, "mcp__db__query", { sql: { text: ["select 1", "DROP TABLE x"] } })).toBe(true);
    expect(toolRuleMatches(r, "mcp__db__query", { sql: "select 1", n: 3, ok: true })).toBe(false);
    expect(toolRuleMatches(r, "x", undefined)).toBe(false);
  });

  test("text rules match their own kind only, dotall by default", () => {
    const r = rule("- id: r\n  on: inbound\n  match: { text: 'begin.*end' }\n  action: deny");
    expect(textRuleMatches(r, "inbound", "begin\nmiddle\nend")).toBe(true);
    expect(textRuleMatches(r, "reply", "begin end")).toBe(false);
    expect(toolRuleMatches(r, "Bash", {})).toBe(false);
  });

  test("the walk is bounded in depth, count and size", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 20; i++) deep = { d: deep };
    expect(stringLeaves(deep)).toEqual([]);
    expect(stringLeaves(Array.from({ length: 500 }, () => "a"))).toHaveLength(200);
    expect(stringLeaves("a".repeat(MAX_MATCH_CHARS * 2))[0]!.length).toBe(MAX_MATCH_CHARS);
    expect(atPath({ a: [1, { b: "c" }] }, "a.1.b")).toBe("c");
    expect(atPath({ a: [1] }, "a.x")).toBeUndefined();
    expect(atPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(atPath({}, "constructor")).toBeUndefined();
  });

  test("combining: the strictest action decides, every hit is kept, ties go to the first", () => {
    const mk = (id: string, action: string) => ({ slug: id, rule: rule(`- id: ${id}\n  on: reply\n  match: { text: x }\n  action: ${action}`) });
    expect(combine([])).toBeNull();
    const d = combine([mk("a", "audit"), mk("b", "redact"), mk("c", "deny"), mk("d", "approve"), mk("e", "deny")])!;
    expect(d.action).toBe("deny");
    expect(d.deciding.slug).toBe("c");
    expect(d.hits).toHaveLength(5);
    expect(combine([mk("a", "audit"), mk("b", "redact")])!.action).toBe("redact");
    expect(combine([mk("a", "redact"), mk("b", "approve")])!.action).toBe("approve");
  });
});
