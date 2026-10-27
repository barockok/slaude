import { describe, expect, test } from "bun:test";
import { readPageRecord } from "../../src/knowledge/memory-pages";
import { agentSourceId } from "../../src/knowledge/scope";
import { composeRulePage, loadRules, resolveLevel, type ProactiveRule } from "../../src/proactive/rules";
import type { Level } from "../../src/proactive/levels";
import { fakeBrain } from "../memory/fake-brain";

const NOW = new Date("2026-10-27T10:00:00Z");
const R = (kind: string, scope: string, level: Level): ProactiveRule => ({
  slug: `rules/proactive/${kind.replace(/\s+/g, "-")}-${scope.toLowerCase()}`,
  kind, scope, level, how: null, taughtBy: "U0EXAMPLE1", taughtAt: "2026-10-27", thread: "C0EXAMPLE/1.2", quote: null,
});

describe("resolveLevel", () => {
  test("channel rule beats global for the same kind", () => {
    const r = resolveLevel({
      rules: [R("invoice emails", "global", "act"), R("invoice emails", "C0EXAMPLE", "inform")],
      kind: "Invoice  Emails", destination: "C0EXAMPLE", proposed: "act", highest: "act",
    });
    expect(r.level).toBe("inform");
    expect(r.rule?.scope).toBe("C0EXAMPLE");
  });
  test("proposed only lowers", () => {
    const g = [R("x", "global", "act")];
    expect(resolveLevel({ rules: g, kind: "x", destination: "C0EXAMPLE", proposed: "ask", highest: "act" }).level).toBe("ask");
    const i = [R("x", "global", "inform")];
    expect(resolveLevel({ rules: i, kind: "x", destination: "C0EXAMPLE", proposed: "act", highest: "act" }).level).toBe("inform");
  });
  test("ceiling clamps", () => {
    expect(resolveLevel({ rules: [R("x", "global", "act")], kind: "x", destination: "C0EXAMPLE", proposed: "act", highest: "inform" }).level).toBe("inform");
  });
  test("a ruleSlug scoped to another place is not used", () => {
    const other = R("x", "C0OTHER0", "act");
    const r = resolveLevel({ rules: [other], ruleSlug: other.slug, kind: "y", destination: "C0EXAMPLE", proposed: "act", highest: "act" });
    expect(r).toEqual({ level: "inform", rule: null });
  });
  test("a ruleSlug for the destination or global is used", () => {
    const g = R("x", "global", "ask");
    const r = resolveLevel({ rules: [g], ruleSlug: g.slug, kind: "other", destination: "C0EXAMPLE", proposed: "act", highest: "act" });
    expect(r.rule).toBe(g);
    expect(r.level).toBe("ask");
  });
  test("no rule means inform; ignore stays ignore", () => {
    expect(resolveLevel({ rules: [], kind: "x", destination: "D", proposed: "act", highest: "act" }).level).toBe("inform");
    expect(resolveLevel({ rules: [R("x", "global", "ignore")], kind: "x", destination: "D", proposed: "act", highest: "act" }).level).toBe("ignore");
  });
});

describe("composeRulePage", () => {
  const base = { kind: "Invoice emails", scope: "C0EXAMPLE", level: "ask" as Level, how: "one line", taughtBy: "U0EXAMPLE1", taughtAt: "2026-10-27", thread: "C0EXAMPLE/1.2", quote: "just ask me" };
  test("default slug and fields", () => {
    const p = composeRulePage(base, NOW);
    if ("error" in p) throw new Error(p.error);
    expect(p.slug).toBe("rules/proactive/invoice-emails-c0example");
    const rec = readPageRecord({ content: p.content })!;
    expect(rec.meta.type).toBe("proactive-rule");
    expect(rec.meta.level).toBe("ask");
    expect(rec.meta.quote).toBe("just ask me");
    expect(rec.meta.subject).toBe("U0EXAMPLE1");
  });
  test("global rule pages never keep the quote", () => {
    const p = composeRulePage({ ...base, scope: "global" }, NOW);
    if ("error" in p) throw new Error(p.error);
    expect(p.slug).toBe("rules/proactive/invoice-emails-global");
    expect(readPageRecord({ content: p.content })!.meta.quote).toBeUndefined();
  });
  test("refuses a credential-like value", () => {
    const p = composeRulePage({ ...base, how: "use sk-abcdefghijklmnopqrstuvwxyz123456" }, NOW);
    expect("error" in p).toBe(true);
  });
});

describe("loadRules", () => {
  test("skips superseded and malformed pages", async () => {
    const brain = fakeBrain();
    const scope = { clientId: "a", sourceId: agentSourceId("a"), allowedSources: [agentSourceId("a")] };
    const put = async (r: Omit<ProactiveRule, "slug">, slug: string, drop?: string) => {
      const p = composeRulePage({ ...r, slug }, NOW);
      if ("error" in p) throw new Error(p.error);
      const content = drop ? p.content.replace(new RegExp(`^${drop}:.*\\n`, "m"), "") : p.content;
      await brain.call("put_page", { slug, content }, scope);
    };
    const r = (kind: string) => ({ kind, scope: "global", level: "act" as Level, how: null, taughtBy: "U0EXAMPLE1", taughtAt: "2026-10-27", thread: "t", quote: null });
    await put(r("good"), "rules/proactive/good-global");
    await put(r("old"), "rules/proactive/old-global");
    await brain.call("add_tag", { slug: "rules/proactive/old-global", tag: "superseded" }, scope);
    await put(r("bad"), "rules/proactive/bad-global", "level");
    const rules = await loadRules("a", brain.call);
    expect(rules.map((x) => x.slug)).toEqual(["rules/proactive/good-global"]);
    expect(rules[0]!.level).toBe("act");
  });
});
