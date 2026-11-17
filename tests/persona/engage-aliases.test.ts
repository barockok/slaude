import { describe, expect, test } from "bun:test";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { aliasIssues, ALIAS_MAX_COUNT } from "../../src/persona/aliases";
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
    expect(soulOf(doc("aliases: [Anabot, ' ana-2 ']\n")).aliases).toEqual(["Anabot", "ana-2"]);
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
    expect(aliasIssues(Array.from({ length: ALIAS_MAX_COUNT + 1 }, (_, i) => `name${i}`))[0]).toMatchObject({ index: null });
  });
});
