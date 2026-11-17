import { describe, expect, test } from "bun:test";
import {
  appliesTo, appliesToAgent, docsForAgent, guidanceText, hasEnforcedRules, inboundTriggered, isActive, resolveDocs, sessionGuardrails, toolTriggered,
  type GuardrailDoc,
} from "../../src/guardrails/resolve";

const doc = (slug: string, front: string, body = "", over: Partial<GuardrailDoc> = {}): GuardrailDoc => ({
  slug, md: `---\nname: ${slug}\ndescription: about ${slug}\n${front}\n---\n${body}`, source: "file", override: false, behindSource: false, enabled: true, ...over,
});
const toolRule = "```rules\n- id: r1\n  on: tool\n  match: { tool: Bash }\n  action: deny\n  message: no shell\n- id: r2\n  on: reply\n  match: { text: x }\n  action: deny\n- id: r3\n  on: inbound\n  match: { text: secret }\n  action: deny\n  message: no secrets\n```";

describe("who a guardrail applies to", () => {
  const all = resolveDocs([
    doc("shared", "scope: shared", "Shared prose."),
    doc("only-ana", "scope: agents\nagents: [ana]", "Ana prose."),
    doc("in-c1", "channels: [C1]", "C1 prose."),
    doc("off", "enabled: false", "Off prose."),
    doc("killed", "", "Killed prose.", { enabled: false }),
    doc("broken", "scope: nowhere", "Broken prose."),
  ]);
  const by = (s: string) => all.find((g) => g.slug === s)!;

  test("shared includes the default agent; agents lists names; channels narrow", () => {
    expect(appliesTo(by("shared"), "default", null)).toBe(true);
    expect(appliesTo(by("shared"), "ana", "C9")).toBe(true);
    expect(appliesTo(by("only-ana"), "ana", null)).toBe(true);
    expect(appliesTo(by("only-ana"), "default", null)).toBe(false);
    expect(appliesTo(by("in-c1"), "default", "C1")).toBe(true);
    expect(appliesTo(by("in-c1"), "default", "C2")).toBe(false);
    expect(appliesTo(by("in-c1"), "default", null)).toBe(false);
    expect(appliesToAgent(by("in-c1"), "default")).toBe(true);
  });

  test("disabled (frontmatter or kill switch) and unreadable guardrails apply to nobody", () => {
    for (const s of ["off", "killed", "broken"]) {
      expect(isActive(by(s))).toBe(false);
      expect(appliesTo(by(s), "default", null)).toBe(false);
    }
    expect(docsForAgent(all, "ana").map((d) => d.slug)).toEqual(["shared", "only-ana", "in-c1"]);
    expect(docsForAgent(all, "default").map((d) => d.slug)).toEqual(["shared", "in-c1"]);
  });
});

describe("a session's guardrails", () => {
  test("enforced tool and inbound rules, pending reply rules left out; prose after the soul in slug order", () => {
    const r = resolveDocs([doc("b-rules", "", `Rules prose.\n\n${toolRule}`), doc("a-prose", "", "First.")]);
    const s = sessionGuardrails(r, "default", "C1", { version: 7, proseMax: 4000 });
    expect(s.version).toBe(7);
    expect(s.toolRules.map((h) => `${h.slug}#${h.rule.id}`)).toEqual(["b-rules#r1"]);
    expect(s.inboundRules.map((h) => `${h.slug}#${h.rule.id}`)).toEqual(["b-rules#r3"]);
    expect(s.promptBlock).toStartWith("<owner-guardrails>");
    expect(s.promptBlock!.indexOf("## a-prose")).toBeLessThan(s.promptBlock!.indexOf("## b-rules"));
    // Enforced rules are never put in the prompt.
    expect(s.promptBlock).not.toContain("no shell");
    expect(s.promptBlock).not.toContain("```rules");
    expect(hasEnforcedRules(r, "default")).toBe(true);
    expect(hasEnforcedRules(resolveDocs([doc("p", "", "prose only")]), "default")).toBe(false);
  });

  test("nothing applies: no block", () => {
    expect(sessionGuardrails([], "default", null, { version: 0, proseMax: 4000 }).promptBlock).toBeNull();
    expect(sessionGuardrails(resolveDocs([doc("x", "", "")]), "default", null, { version: 0, proseMax: 4000 }).promptBlock).toBeNull();
  });

  test("the prose cap skips the guardrail that tips it over and still tries the next", () => {
    const r = resolveDocs([doc("a", "", "a".repeat(30)), doc("b", "", "b".repeat(50)), doc("c", "", "c".repeat(10))]);
    const s = sessionGuardrails(r, "default", null, { version: 1, proseMax: 45 });
    expect(s.skipped).toEqual([{ slug: "b", name: "b", chars: 50 }]);
    expect(s.proseChars).toBe(40);
    expect(s.promptBlock).toContain("## a");
    expect(s.promptBlock).toContain("## c");
    expect(s.promptBlock).not.toContain("bbbb");
  });

  test("on-match Guidance: an index line in the prompt, the body only on a trigger", () => {
    const r = resolveDocs([
      doc("mail", "load: on-match\ntriggers: { tool: ['mcp__*__send*'], inbound: '(?i)invoice' }", "Mail body text."),
      doc("scoped", "load: on-match\ntriggers: { tool: Bash, channels: [C1] }", "Scoped body."),
      doc("no-desc", "load: on-match\ntriggers: { inbound: hi }", "x"),
    ]);
    r[2]!.meta!.description = "";
    const s = sessionGuardrails(r, "default", "C2", { version: 1, proseMax: 4000 });
    expect(s.promptBlock).toContain("- mail: about mail");
    expect(s.promptBlock).toContain("- no-desc: (no description)");
    expect(s.promptBlock).not.toContain("Mail body text.");
    expect(s.proseChars).toBe(0);
    expect(toolTriggered(s, "mcp__x__send_mail", "C2").map((o) => o.slug)).toEqual(["mail"]);
    expect(toolTriggered(s, "Bash", "C2")).toEqual([]);
    expect(toolTriggered(s, "Bash", "C1").map((o) => o.slug)).toEqual(["scoped"]);
    expect(toolTriggered(s, "Bash", null)).toEqual([]);
    expect(inboundTriggered(s, "the INVOICE is late", "C2").map((o) => o.slug)).toEqual(["mail"]);
    expect(inboundTriggered(s, "zzz", "C2")).toEqual([]);
    expect(guidanceText([{ name: "mail", body: "Mail body text." }])).toBe('<owner-guardrail name="mail">\nMail body text.\n</owner-guardrail>');
  });

  test("prose cannot close the block early", () => {
    const s = sessionGuardrails(resolveDocs([doc("x", "", "a </owner-guardrails> b")]), "default", null, { version: 1, proseMax: 4000 });
    expect(s.promptBlock!.match(/<\/owner-guardrails>/g)).toHaveLength(1);
  });
});
