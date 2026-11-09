import { describe, expect, test } from "bun:test";
import { clipEffectiveMandate, mandateContext, modeLineValue, resolveMandate, subMandatesOf, usesScopedMandates, type SubMandate } from "../../src/soul/mandate-scope";
import { SoulDataSchema } from "../../src/soul/data";

const G = "Help the team ship.";
const sub = (boundary: SubMandate["boundary"], mode: SubMandate["mode"], text: string): SubMandate => ({ boundary, mode, text });

describe("resolveMandate modes", () => {
  test("override replaces the global text with the sub-mandate", () => {
    const s = sub("channel:C1", "override", "Only incidents.");
    expect(resolveMandate(G, [s], { channelId: "C1" })).toEqual({ text: "Only incidents.", applied: s });
  });

  test("extend renders the global text then a labelled addition", () => {
    const r = resolveMandate(G, [sub("channel:C1", "extend", "Also triage bugs.")], { channelId: "C1" });
    expect(r.text).toBe("Help the team ship.\n\nAdditional mandate for this channel (in addition to the mandate above):\nAlso triage bugs.");
    expect(r.applied?.mode).toBe("extend");
  });

  test("reduce renders the global text then a limit that wins", () => {
    const r = resolveMandate(G, [sub("channel:C1", "reduce", "No deploys.")], { channelId: "C1" });
    expect(r.text).toBe("Help the team ship.\n\nLimit for this channel (this narrows the mandate above and wins over it wherever they conflict):\nNo deploys.");
  });

  test("each boundary is named in the label", () => {
    const label = (b: SubMandate["boundary"], ctx: Parameters<typeof resolveMandate>[2]) => resolveMandate(G, [sub(b, "reduce", "x")], ctx).text.split("\n\n")[1]!.split(" (")[0];
    expect(label("trust:public", { trust: "public" })).toBe("Limit for public channels");
    expect(label("trust:trusted", { trust: "trusted" })).toBe("Limit for trusted channels");
    expect(label("dm", { dm: true })).toBe("Limit for direct messages");
  });

  test("an empty global leaves only the labelled part", () => {
    expect(resolveMandate("  ", [sub("dm", "extend", "x")], { dm: true }).text).toBe("Additional mandate for direct messages (in addition to the mandate above):\nx");
  });
});

describe("resolveMandate precedence", () => {
  const all = [sub("dm", "override", "dm"), sub("trust:trusted", "override", "trusted"), sub("trust:public", "override", "public"), sub("channel:C1", "override", "channel")];

  test("channel beats trust class beats dm", () => {
    expect(resolveMandate(G, all, { channelId: "C1", trust: "trusted", dm: true }).text).toBe("channel");
    expect(resolveMandate(G, all, { channelId: "C2", trust: "trusted", dm: true }).text).toBe("trusted");
    expect(resolveMandate(G, all, { channelId: "C2", trust: "public" }).text).toBe("public");
    expect(resolveMandate(G, all, { channelId: "D2", dm: true }).text).toBe("dm");
  });

  test("no match keeps the global text exactly, untrimmed", () => {
    expect(resolveMandate(" g ", all, { channelId: "C2" })).toEqual({ text: " g ", applied: null });
    expect(resolveMandate(" g ", all, {})).toEqual({ text: " g ", applied: null });
  });

  test("no stacking: a matching channel extend ignores the trust limit", () => {
    const r = resolveMandate(G, [sub("trust:public", "reduce", "limit"), sub("channel:C1", "extend", "more")], { channelId: "C1", trust: "public" });
    expect(r.text).not.toContain("limit");
    expect(r.applied?.boundary).toBe("channel:C1");
  });

  test("a sub-mandate with no text is no match: the next boundary applies", () => {
    expect(resolveMandate(G, [sub("channel:C1", "extend", "   "), sub("trust:public", "override", "public")], { channelId: "C1", trust: "public" }).text).toBe("public");
  });
});

describe("subMandatesOf and mandateContext", () => {
  const soul = SoulDataSchema.parse({
    channelOverrides: [{ channel: "C1", mandate: " a " }, { channel: "C2", mandate: "b", mandateMode: "reduce" }, { channel: "C3", approvers: [] }],
    scopeMandates: [{ scope: "dm", mandate: "d" }, { scope: "public", mandate: "p", mode: "extend" }, { scope: "trusted", mandate: "t", mode: "reduce" }],
  });

  test("no mode means override; a block with no mandate is no sub-mandate", () => {
    expect(subMandatesOf(soul)).toEqual([
      { boundary: "channel:C1", mode: "override", text: "a" },
      { boundary: "channel:C2", mode: "reduce", text: "b" },
      { boundary: "dm", mode: "override", text: "d" },
      { boundary: "trust:public", mode: "extend", text: "p" },
      { boundary: "trust:trusted", mode: "reduce", text: "t" },
    ]);
  });

  test("context comes from the soul's lists and the channel's D prefix", () => {
    const lists = { trustedChannels: ["CT"], allowedChannels: ["CP"] };
    expect(mandateContext(lists, "CT")).toEqual({ channelId: "CT", trust: "trusted", dm: false });
    expect(mandateContext(lists, "CP")).toEqual({ channelId: "CP", trust: "public", dm: false });
    expect(mandateContext(lists, "D1")).toEqual({ channelId: "D1", trust: null, dm: true });
    expect(mandateContext(lists, undefined)).toEqual({});
  });
});

describe("clipEffectiveMandate", () => {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();

  test("plain text is cut at the end", () => {
    expect(clipEffectiveMandate("a".repeat(20), 10, flat)).toBe(`${"a".repeat(10)}…`);
    expect(clipEffectiveMandate("short", 10, flat)).toBe("short");
  });

  test("a limit survives: the global part is what is cut", () => {
    const text = resolveMandate("g".repeat(500), [sub("channel:C1", "reduce", "Never deploy.")], { channelId: "C1" }).text;
    const out = clipEffectiveMandate(text, 200, flat);
    expect(out).toContain("Never deploy.");
    expect(out).toContain("Limit for this channel");
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

describe("mode lines and the scoped-syntax check", () => {
  test("modeLineValue accepts the written forms and nothing else", () => {
    expect(modeLineValue("Mode: extend")).toBe("extend");
    expect(modeLineValue("- mode: Reduce  # narrower here")).toBe("reduce");
    expect(modeLineValue("**Mode:** override")).toBe("override");
    expect(modeLineValue("Mode: stack")).toBeNull();
    expect(modeLineValue("Model: extend")).toBeNull();
  });

  test("usesScopedMandates finds a mode line or a scope block, and nothing else", () => {
    expect(usesScopedMandates("## Channel C1\n### Mandate\nMode: reduce\nx")).toBe(true);
    expect(usesScopedMandates("# s\n\n## Scope dm\n### Mandate\nx")).toBe(true);
    expect(usesScopedMandates("## Mandate\nHelp in `## Scope dm` docs.\n## Channel C1\n### Mandate\nx")).toBe(false);
  });
});
