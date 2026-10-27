import { afterEach, describe, expect, it } from "bun:test";
import { inWindow, parseClock, parseProactive, proactiveFor, __setProactiveSoulSource } from "../../src/soul/proactive";
import { FIELD_ALIASES, mutateOverride } from "../../src/soul/overrides";
import { EXTRACTION_PROMPT, SoulDataSchema } from "../../src/soul/data";

const SOUL = (body: string) => `# Persona\n\n## Identity\n- Name: Helper\n\n${body}\n`;

afterEach(() => __setProactiveSoulSource(null));

describe("parseClock / inWindow", () => {
  it("parses HH:MM and rejects junk", () => {
    expect(parseClock("21:00")).toBe(21 * 60);
    expect(parseClock("8:05")).toBe(8 * 60 + 5);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("12:60")).toBeNull();
    expect(parseClock("noon")).toBeNull();
  });

  it("wraps midnight", () => {
    const w = { start: 21 * 60, end: 8 * 60 };
    expect(inWindow(23 * 60, w)).toBe(true);
    expect(inWindow(7 * 60, w)).toBe(true);
    expect(inWindow(12 * 60, w)).toBe(false);
    expect(inWindow(8 * 60, w)).toBe(false);
    expect(inWindow(21 * 60, w)).toBe(true);
  });

  it("handles a same-day window and an empty one", () => {
    expect(inWindow(13 * 60, { start: 12 * 60, end: 14 * 60 })).toBe(true);
    expect(inWindow(15 * 60, { start: 12 * 60, end: 14 * 60 })).toBe(false);
    expect(inWindow(12 * 60, { start: 12 * 60, end: 12 * 60 })).toBe(false);
  });
});

describe("parseProactive", () => {
  it("defaults to disabled, cap 1, cooldown 4, no quiet hours", () => {
    expect(parseProactive(SOUL(""))).toEqual({ enabled: false, quietHours: null, maxPerPersonPerDay: 1, cooldownHours: 4, watch: [], highest: "inform", channels: {}, channelHighest: {} });
  });

  it("reads the global section", () => {
    const c = parseProactive(SOUL("## Proactive\n- Enabled: yes\n- Quiet hours: 21:00–08:00\n- Max per person per day: 3\n- Cooldown: 2 hours\n"));
    expect(c).toEqual({ enabled: true, quietHours: { start: 21 * 60, end: 8 * 60 }, maxPerPersonPerDay: 3, cooldownHours: 2, watch: [], highest: "inform", channels: {}, channelHighest: {} });
  });

  it("is case-insensitive, accepts a hyphen, and ignores comments", () => {
    const c = parseProactive(SOUL("## proactive\n- ENABLED: Yes   # turn on\n* quiet hours: 22:30-07:00\n"));
    expect(c.enabled).toBe(true);
    expect(c.quietHours).toEqual({ start: 22 * 60 + 30, end: 7 * 60 });
  });

  it("anything but yes is off", () => {
    expect(parseProactive(SOUL("## Proactive\n- Enabled: maybe\n")).enabled).toBe(false);
    expect(parseProactive(SOUL("## Proactive\n- Enabled: no\n")).enabled).toBe(false);
    expect(parseProactive(SOUL("## Proactive\n- Enabled: true\n")).enabled).toBe(false);
  });

  it("ignores malformed numbers and quiet hours", () => {
    const c = parseProactive(SOUL("## Proactive\n- Enabled: yes\n- Quiet hours: late\n- Max per person per day: lots\n- Cooldown: -3 hours\n"));
    expect(c.quietHours).toBeNull();
    expect(c.maxPerPersonPerDay).toBe(1);
    expect(c.cooldownHours).toBe(4);
  });

  it("stops the section at the next ## heading", () => {
    const c = parseProactive(SOUL("## Proactive\n- Enabled: no\n\n## Values\n- Enabled: yes\n"));
    expect(c.enabled).toBe(false);
  });

  it("reads per-channel overrides in either direction", () => {
    const text = SOUL(
      [
        "## Proactive",
        "- Enabled: no",
        "",
        "## Channel <#C0TEAMCHAN|team-channel>",
        "### Mandate",
        "Help the team.",
        "### Proactive",
        "- Enabled: yes",
        "",
        "## Channel G0QUIETCHAN",
        "### Proactive",
        "- Enabled: no",
      ].join("\n"),
    );
    expect(parseProactive(text).channels).toEqual({ C0TEAMCHAN: true, G0QUIETCHAN: false });
  });

  it("ignores a channel block without a Proactive subsection, a placeholder id, and Enabled outside the subsection", () => {
    const text = SOUL(
      [
        "## Channel <#C0TEAMCHAN|team-channel>",
        "- Enabled: yes",
        "### Mandate",
        "- Enabled: yes",
        "",
        "## Channel <#Cxxx|name>",
        "### Proactive",
        "- Enabled: yes",
      ].join("\n"),
    );
    expect(parseProactive(text).channels).toEqual({});
  });

  it("a channel subsection ends at the next ### heading", () => {
    const text = SOUL(["## Channel C0TEAMCHAN", "### Proactive", "### Mandate", "- Enabled: yes"].join("\n"));
    expect(parseProactive(text).channels).toEqual({});
  });

  it("ignores headings inside fenced code blocks", () => {
    const text = SOUL(["```md", "## Proactive", "- Enabled: yes", "```"].join("\n"));
    expect(parseProactive(text).enabled).toBe(false);
  });

  it("a top-level # heading ends the section", () => {
    expect(parseProactive(SOUL("## Proactive\n- Enabled: no\n\n# Appendix\n- Enabled: yes\n")).enabled).toBe(false);
  });

  it("a ### Proactive outside a channel block does nothing", () => {
    expect(parseProactive(SOUL("### Proactive\n- Enabled: yes\n")).enabled).toBe(false);
  });
});

describe("proactiveFor", () => {
  it("resolves the global switch and a channel override from the persona's soul text", () => {
    __setProactiveSoulSource(() => SOUL("## Proactive\n- Enabled: no\n- Max per person per day: 2\n\n## Channel C0TEAMCHAN\n### Proactive\n- Enabled: yes\n"));
    expect(proactiveFor("default").enabled).toBe(false);
    expect(proactiveFor("default", "C0OTHER").enabled).toBe(false);
    const ch = proactiveFor("default", "C0TEAMCHAN");
    expect(ch.enabled).toBe(true);
    expect(ch.maxPerPersonPerDay).toBe(2);
  });

  it("passes the persona name to the soul source", () => {
    const seen: (string | undefined)[] = [];
    __setProactiveSoulSource((n) => {
      seen.push(n);
      return SOUL("## Proactive\n- Enabled: yes\n");
    });
    expect(proactiveFor("helper").enabled).toBe(true);
    expect(seen).toEqual(["helper"]);
  });

  it("a soul that cannot be read reads as disabled", () => {
    __setProactiveSoulSource(() => {
      throw new Error("no soul");
    });
    expect(proactiveFor("default", "C0TEAMCHAN")).toEqual({ enabled: false, quietHours: null, maxPerPersonPerDay: 1, cooldownHours: 4, watch: [], highest: "inform" });
  });

  it("anyEnabled is true when only a channel is on", async () => {
    const { anyProactiveEnabled } = await import("../../src/soul/proactive");
    __setProactiveSoulSource(() => SOUL("## Channel C0TEAMCHAN\n### Proactive\n- Enabled: yes\n"));
    expect(anyProactiveEnabled("default")).toBe(true);
    __setProactiveSoulSource(() => SOUL(""));
    expect(anyProactiveEnabled("default")).toBe(false);
  });
});

describe("invariant 3: proactiveness is raised only by the SOUL", () => {
  it("no runtime override field names it", () => {
    for (const v of [...Object.keys(FIELD_ALIASES), ...Object.values(FIELD_ALIASES)]) expect(v).not.toMatch(/proactive/i);
  });

  it("the structured soul has no proactive field and the extraction prompt never asks for one", () => {
    expect(Object.keys(SoulDataSchema.shape).some((k) => /proactive/i.test(k))).toBe(false);
    expect(EXTRACTION_PROMPT).not.toMatch(/proactive/i);
  });

  it("an override write for it is refused", async () => {
    const r = await mutateOverride({ field: "proactive" as never, action: "add", value: "C0TEAMCHAN", by: "U0MANAGER" }, {});
    expect(r.ok).toBe(false);
  });
});

describe("Watch and Highest", () => {
  it("parse globally; Highest replaces per channel; Watch is global only", () => {
    const c = parseProactive(
      "## Proactive\n- Enabled: yes\n- Watch: mail, tracker\n- Highest: ask\n\n## Channel <#C0EXAMPLE>\n### Proactive\n- Enabled: yes\n- Highest: act\n- Watch: other\n",
    );
    expect(c.watch).toEqual(["mail", "tracker"]);
    expect(c.highest).toBe("ask");
    expect(c.channelHighest).toEqual({ C0EXAMPLE: "act" });
  });

  it("defaults: no Watch, Highest inform; an unknown level keeps the default", () => {
    expect(parseProactive("## Proactive\n- Enabled: yes\n- Highest: always\n")).toMatchObject({
      watch: [],
      highest: "inform",
      channelHighest: {},
    });
  });

  it("proactiveFor resolves highest per channel", () => {
    __setProactiveSoulSource(
      () => "## Proactive\n- Enabled: yes\n- Watch: mail\n- Highest: ask\n\n## Channel <#C0EXAMPLE>\n### Proactive\n- Highest: act\n",
    );
    expect(proactiveFor("default", "C0EXAMPLE").highest).toBe("act");
    expect(proactiveFor("default", "C0OTHER0").highest).toBe("ask");
    expect(proactiveFor("default").highest).toBe("ask");
    expect(proactiveFor("default", "C0EXAMPLE").watch).toEqual(["mail"]);
  });
});
