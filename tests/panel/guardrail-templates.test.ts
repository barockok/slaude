/**
 * The console's guardrail templates and override diff (phase B). Every
 * template must parse with the server's parser (no error at all, so a new
 * guardrail never starts refused), and the diff must mark exactly the lines
 * an override changed.
 */
import { describe, expect, test } from "bun:test";
import { GUARDRAIL_TEMPLATES } from "../../src/web/console/pages/resources/guardrailTemplates";
import { lineDiff } from "../../src/web/console/lib/line-diff";
import { parseGuardrail, RESERVED_SLUGS } from "../../src/guardrails/format";
import { CONSOLE_GUARDRAIL_PAGES } from "../../src/web/console/pages/resources/guardrailPages";

describe("templates", () => {
  test("each parses cleanly with the server's parser, both kinds offered", () => {
    expect(new Set(GUARDRAIL_TEMPLATES.map((t) => t.kind))).toEqual(new Set(["enforced", "guidance"]));
    for (const t of GUARDRAIL_TEMPLATES) {
      const p = parseGuardrail("my-rule", t.md("my-rule"));
      expect({ id: t.id, errors: p.errors }).toEqual({ id: t.id, errors: [] });
      if (t.kind === "enforced") expect(p.rules.length).toBeGreaterThan(0);
      else expect(p.rules).toEqual([]);
    }
  });

  test("the enforced examples match what they say they match", () => {
    const tool = parseGuardrail("t", GUARDRAIL_TEMPLATES.find((t) => t.id === "tool-deny")!.md("t")).rules[0]!;
    expect(tool.tool!.fields![0]!.pattern.test("jane@external.example")).toBe(true);
    const reply = parseGuardrail("t", GUARDRAIL_TEMPLATES.find((t) => t.id === "reply-redact")!.md("t")).rules;
    expect(reply[0]!.text!.test("card 1234-5678-9012-3456")).toBe(true);
    expect(reply[1]!.text!.test("The price is $40")).toBe(true);
    const inbound = parseGuardrail("t", GUARDRAIL_TEMPLATES.find((t) => t.id === "inbound-deny")!.md("t")).rules[0]!;
    expect(inbound.text!.test("password: x")).toBe(true);
  });
});

test("the console's own /guardrails pages are exactly the reserved names", () => {
  expect([...CONSOLE_GUARDRAIL_PAGES].sort()).toEqual([...RESERVED_SLUGS].sort());
});

describe("lineDiff", () => {
  test("marks removed and added lines around the common ones", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
    expect(lineDiff("x", "x")).toEqual([{ kind: "same", text: "x" }]);
  });
});
