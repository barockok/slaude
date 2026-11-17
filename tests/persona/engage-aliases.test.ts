import { describe, expect, test } from "bun:test";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { SoulDataSchema, SoulDataStrictSchema } from "../../src/soul/data";
import { buildSnapshotForTest } from "../../src/persona/registry";
import { aliasConflicts, aliasIssues, ALIAS_MAX_COUNT } from "../../src/persona/aliases";
import { PayloadError } from "../../src/persona/sync/payload";

const doc = (extra: string) => `name: ana\nsoul: You are Ana.\n${extra}`;
const soulOf = (yaml: string) => parseAgentYaml("ana", yaml).spec.definition.soulData;
const msgOf = (yaml: string): string => {
  try {
    parseAgentYaml("ana", yaml);
  } catch (e) {
    expect(e).toBeInstanceOf(PayloadError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("engage in agent.yaml", () => {
  test("no engage and no aliases: nothing recorded", () => {
    const s = soulOf(doc("channels:\n  C0EXAMPLE:\n    proactive: true\n"));
    expect(s.channelEngage).toEqual([]);
    expect(s.aliases).toEqual([]);
  });

  test("level and mode are carried per channel, as written", () => {
    const s = soulOf(
      doc("channels:\n  slack:channel:C0EXAMPLE:\n    engage: { level: addressed, mode: on }\n  C0OTHER1:\n    engage: { level: contribute }\n  C0OTHER2:\n    session: channel\n"),
    );
    expect(s.channelEngage).toEqual([
      { channel: "C0EXAMPLE", level: "addressed", mode: "on" },
      { channel: "C0OTHER1", level: "contribute" },
    ]);
  });

  test("a bad level or mode names the field and not the value", () => {
    const m = msgOf(doc("channels:\n  C0EXAMPLE:\n    engage: { level: sneaky-value }\n"));
    expect(m).toContain("engage.level");
    expect(m).toContain("mention, addressed or contribute");
    expect(m).not.toContain("sneaky-value");
    expect(msgOf(doc("channels:\n  C0EXAMPLE:\n    engage: { mode: live }\n"))).toContain("shadow or on");
  });
});

describe("aliases", () => {
  test("kept as written (trimmed), in order", () => {
    expect(soulOf(doc("aliases: [Anabot, ' ana2 ']\n")).aliases).toEqual(["Anabot", "ana2"]);
  });

  test("errors name the index and never the value", () => {
    const m = msgOf(doc("aliases: [anabot, team]\n"));
    expect(m).toContain("aliases[1]");
    expect(m).not.toContain("anabot");
    expect(m).not.toContain("team ");
    expect(msgOf(doc("aliases: [anabot, an]\n"))).toContain("aliases[1]");
  });

  test("rules", () => {
    expect(aliasIssues(["abc"])).toEqual([]);
    expect(aliasIssues(["ab"])[0]!.message).toContain("at least 3");
    expect(aliasIssues(["The"])[0]!.message).toContain("common word");
    expect(aliasIssues(["Sam", "sam"])[0]).toMatchObject({ index: 1 });
    expect(aliasIssues(["a b c"])[0]!.message).toContain("one word");
    expect(aliasIssues(["ana-bot"])[0]!.message).toContain("letters and digits");
    expect(aliasIssues(["anabot."])[0]!.message).toContain("letters and digits");
    expect(aliasIssues(Array.from({ length: ALIAS_MAX_COUNT + 1 }, (_, i) => `name${i}`))[0]).toMatchObject({ index: null });
  });
});

describe("alias hardening", () => {
  test("NFKC and case fold: full-width and cased spellings are one name; a full-width common word is still common", () => {
    expect(aliasIssues(["anabot", "\uff21\uff4e\uff41\uff42\uff4f\uff54"])[0]).toMatchObject({ index: 1 });
    expect(aliasIssues(["\uff34\uff28\uff25"])[0]!.message).toContain("common word");
  });
  test("mixed look-alike scripts are refused, single-script non-Latin names are fine", () => {
    expect(aliasIssues(["an\u0430bot"])[0]!.message).toContain("look-alike");
    expect(aliasIssues(["\u03b1\u03b2a"])[0]!.message).toContain("look-alike");
    expect(aliasIssues(["\u0430\u043d\u0430\u0431\u043e\u0442"])).toEqual([]);
  });
  test("length counts code points", () => {
    expect(aliasIssues(["\u{1d400}\u{1d401}"])[0]!.message).toContain("at least 3");
    expect(aliasIssues(["\u{1d400}\u{1d401}\u{1d402}"])).toEqual([]);
  });
  test("an alias equal to the agent's own name is refused, case and width folded", () => {
    expect(aliasIssues(["Anabot"], "anabot")[0]!.message).toContain("own name");
    const m = msgOf(doc("aliases: [ANA]\n"));
    expect(m).toContain("aliases[0]");
    expect(m).not.toContain("ANA");
  });
  test("two personas claiming one alias, or an alias that is another's name", () => {
    const out = aliasConflicts([
      { name: "ana", aliases: ["helper1", "bobby"] },
      { name: "bob", aliases: ["HELPER1"] },
      { name: "cy", aliases: ["bob"] },
    ]);
    expect(out).toEqual([
      "persona 'bob': aliases[0] is also claimed by persona 'ana'",
      "persona 'cy': aliases[0] is the name of persona 'bob'",
    ]);
    expect(out.join()).not.toMatch(/helper1/i);
  });
  test("the stored structure: read tolerates a bad list (as none), parse and sync refuse it", () => {
    const bad = { aliases: ["ok-name", "the"] };
    expect(SoulDataSchema.parse(bad).aliases).toEqual([]);
    expect(SoulDataSchema.parse({ aliases: ["anabot"] }).aliases).toEqual(["anabot"]);
    expect(SoulDataSchema.parse({ aliases: 5 }).aliases).toEqual([]);
    expect(SoulDataSchema.parse({}).aliases).toEqual([]);
    expect(SoulDataStrictSchema.safeParse(bad).success).toBe(false);
    expect(SoulDataStrictSchema.safeParse({ aliases: ["anabot"] }).success).toBe(true);
  });
  test("a file registry with two personas claiming one alias refuses to build", () => {
    const mk = (name: string, aliases: string[]) => ({
      name, slackUserId: `U${name}`, soulJson: SoulDataSchema.parse({ aliases }),
    });
    expect(() => buildSnapshotForTest([mk("ana", ["shared1"]), mk("bob", ["shared1"])])).toThrow(/persona 'bob': aliases\[0\]/);
    expect(() => buildSnapshotForTest([mk("ana", ["one11"]), mk("bob", ["two22"])])).not.toThrow();
  });
});
