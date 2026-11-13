/**
 * Every consumer of "the mandate here" reads one resolver, and a soul with no
 * `Mode:` line and no `## Scope` block resolves byte-identically to before.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { paths } from "../../src/config/home";
import { AgentManager } from "../../src/agent/manager";
import { personaMandates } from "../../src/background/scheduler";
import * as SO from "../../src/db/soul-overrides";
import { withChannelClasses } from "../../src/gateway/api/tenants";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../src/persona/registry";
import type { Persona } from "../../src/persona/types";
import { SoulDataSchema, type SoulData } from "../../src/soul/data";
import { __resetSoulDataMemo, channelMandate, effectiveSoulForChannel, setSoulData, soulData } from "../../src/soul/extract";
import { effectiveMandateIn, personaMandateText } from "../../src/soul/persona-mandates";
import { effectiveSoulForChannelFor } from "../../src/soul/per-persona";
import { makeNodeVoiceHost } from "../../src/voice/hosts";

const registry = (personas: Array<{ name: string; soulJson?: unknown; soulMd?: string }>): PersonaRegistry => {
  const full = personas.map((p) => ({ slackUserId: "U0P", config: { slackUserId: "U0P", name: p.name }, outClient: null, ...p }) as Persona);
  return {
    lookupByUserId: () => null,
    lookupByName: (n) => full.find((p) => p.name === n) ?? null,
    list: () => full,
    isMultiPersonaMode: () => full.length > 0,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
  };
};

const LEGACY: SoulData = SoulDataSchema.parse({
  manager: { userId: "UMGR" },
  mandate: "  Global mandate.  ",
  trustedChannels: ["CTEAM"],
  allowedChannels: ["CPUB"],
  channelOverrides: [
    { channel: "COVER", mandate: " Own text. ", approvers: [] },
    { channel: "CAPPR", approvers: [{ userId: "UAPP", scope: "all", catchall: true }] },
    { channel: "CEMPTY", mandate: "   ", approvers: [] },
  ],
});

/** The behaviour before scoped mandates, frozen here to compare against. */
function legacyEffective(base: SoulData, channelId: string): string | undefined {
  const ov = base.channelOverrides.find((c) => c.channel === channelId);
  if (!ov) return base.mandate;
  return channelMandate(base, channelId) ?? base.mandate;
}
function legacyPrompt(base: SoulData, channelId: string): string {
  const b = base.mandate?.trim();
  const eff = base.channelOverrides.find((c) => c.channel === channelId)?.mandate?.trim() || b;
  if (!eff || eff === b) return "";
  return `<channel-mandate>\nFor this channel your mandate is: ${eff}\nThis supersedes the Mandate section in your persona for this channel.\n</channel-mandate>`;
}

const CHANNELS = ["COVER", "CAPPR", "CEMPTY", "CTEAM", "CPUB", "CELSE", "D0ALICE"];

beforeEach(async () => {
  await SO.clear();
  setSoulData(LEGACY);
});
afterEach(() => {
  __resetPersonaRegistry();
  __resetSoulDataMemo();
});

describe("no Mode line resolves byte-identically to before", () => {
  test.each(CHANNELS)("effectiveSoulForChannel and the prompt block in %s", async (channel) => {
    expect(effectiveSoulForChannel(channel).mandate).toBe(legacyEffective(LEGACY, channel));
    expect(effectiveSoulForChannelFor("default", channel).mandate).toBe(legacyEffective(LEGACY, channel));
    const agent = new AgentManager();
    agent.setPersonaSoulResolver(async () => ({ soulMd: "s", soulJson: LEGACY }));
    const prompt = await agent.__systemPromptForTests("s", "ana", { channelId: channel });
    const expected = legacyPrompt(LEGACY, channel);
    if (expected) expect(prompt).toContain(expected);
    else expect(prompt).not.toContain("<channel-mandate>");
  });

  test("nothing applying keeps the very same soul object", () => {
    expect(effectiveSoulForChannelFor("default", "CTEAM").approvers).toBe(LEGACY.approvers);
    expect(effectiveSoulForChannel("CELSE")).toEqual(LEGACY);
  });

  test("the scheduler reads a block's own text, null when it follows the global", () => {
    expect(personaMandates("default", ["COVER", "CEMPTY", "CELSE"])).toEqual({ global: "Global mandate.", channels: { COVER: "Own text.", CEMPTY: null, CELSE: null } });
  });
});

const SCOPED: SoulData = SoulDataSchema.parse({
  ...LEGACY,
  mandate: "Global.",
  channelOverrides: [{ channel: "COVER", mandate: "Also this.", mandateMode: "extend", approvers: [] }],
  scopeMandates: [
    { scope: "public", mandate: "No internals.", mode: "reduce" },
    { scope: "trusted", mandate: "Open up.", mode: "extend" },
    { scope: "dm", mandate: "Be brief." },
  ],
});

describe("consumers go through the resolver", () => {
  test("effectiveSoulForChannel: channel, trust classes, dm and none", () => {
    setSoulData(SCOPED);
    expect(effectiveSoulForChannel("COVER").mandate).toContain("Additional mandate for this channel");
    expect(effectiveSoulForChannel("CPUB").mandate).toContain("Limit for public channels");
    expect(effectiveSoulForChannel("CTEAM").mandate).toContain("Additional mandate for trusted channels");
    expect(effectiveSoulForChannel("D0ALICE").mandate).toBe("Be brief.");
    expect(effectiveSoulForChannel("CELSE").mandate).toBe("Global.");
  });

  test("a runtime trust override moves a channel's class", async () => {
    setSoulData(SCOPED);
    await SO.upsert({ field: "trustedChannels", value: "CELSE", action: "add", created_by: "UMGR" });
    expect(effectiveSoulForChannel("CELSE").mandate).toContain("Open up.");
    await SO.clear();
  });

  test("the system prompt block carries a reduce from a trust class", async () => {
    const agent = new AgentManager();
    agent.setPersonaSoulResolver(async () => ({ soulMd: "s", soulJson: SCOPED }));
    const prompt = await agent.__systemPromptForTests("s", "ana", { channelId: "CPUB" });
    expect(prompt).toContain("<channel-mandate>\nFor this channel your mandate is: Global.\n\nLimit for public channels");
    expect(await agent.__systemPromptForTests("s2", "ana", { channelId: "CELSE" })).not.toContain("<channel-mandate>");
  });

  test("scheduler: a named persona's stored structure uses its own mandates, the default's lists and the resolver", () => {
    const scout = { mandate: "Scout.", scopeMandates: [{ scope: "public", mandate: "Quiet here.", mode: "reduce" }, { scope: "trusted", mandate: "Open up." }] };
    setSoulData(SoulDataSchema.parse({ trustedChannels: ["CTEAM"], allowedChannels: ["CPUB"] }));
    setPersonaRegistry(registry([{ name: "scout", soulMd: "# Scout\n", soulJson: scout }]));
    const m = personaMandates("scout", ["CPUB", "CTEAM", "CELSE"]);
    expect(m.channels.CPUB).toBe("Scout.\n\nLimit for public channels (this narrows the mandate above and wins over it wherever they conflict):\nQuiet here.");
    expect(m.channels.CTEAM).toBe("Open up.");
    expect(m.channels.CELSE).toBeNull();
    expect(effectiveMandateIn(personaMandateText("scout"), "CPUB").applied?.boundary).toBe("trust:public");
  });

  test("a node's bundle soul with scope mandates carries the lists it is admitted by; others ship as stored", () => {
    setSoulData(SoulDataSchema.parse({ trustedChannels: ["CTEAM"], allowedChannels: ["CPUB"] }));
    setPersonaRegistry(registry([{ name: "ana", soulJson: { mandate: "m" } }]));
    const stored = { mandate: "m", scopeMandates: [{ scope: "dm", mandate: "x" }] };
    expect(withChannelClasses("ana", stored)).toEqual({ ...stored, trustedChannels: ["CTEAM"], allowedChannels: ["CPUB"] });
    const plain = { mandate: "m" };
    expect(withChannelClasses("ana", plain)).toBe(plain);
    expect(withChannelClasses("ana", null)).toBeNull();
  });

  test("a node voice call speaks with its channel's effective mandate", async () => {
    const soulJson = { identity: { name: "Ana" }, mandate: "Global.", channelOverrides: [{ channel: "C0CALL", mandate: "No paging.", mandateMode: "reduce", approvers: [] }] };
    const host = makeNodeVoiceHost({
      agent: { holdIdle: () => true } as never,
      tokenFor: () => "tok",
      claims: () => ({ channel: "C0CALL" }),
      bindToken: () => {},
      refresh: async () => ({ jobToken: "t" }),
      lock: async (_id, fn) => fn(new AbortController().signal),
      bundle: async () => ({ soulJson }),
      workingDir: async () => "/tmp",
      draining: () => false,
    });
    const text = await host.instructions("s1", "b");
    expect(text).toContain("Limit for this channel");
    expect(text).toContain("No paging.");
  });
});

describe("a named persona's turn prompt (mono)", () => {
  const prompt = (persona: string, channelId: string) => new AgentManager().__systemPromptForTests("s", persona, { channelId });

  test("the default persona's sub-mandates never reach a named persona", async () => {
    setSoulData(SCOPED);
    setPersonaRegistry(registry([{ name: "scout", soulMd: "# Scout\n\n## Mandate\nScout.\n" }]));
    const text = await prompt("scout", "D0ALICE");
    expect(text).not.toContain("<channel-mandate>");
    expect(text).not.toContain("Be brief.");
  });

  test("a named persona's own reduce reaches its turn, compared against its own global", async () => {
    setSoulData(SoulDataSchema.parse({ mandate: "Default global." }));
    setPersonaRegistry(registry([{ name: "scout", soulMd: "# Scout\n", soulJson: { mandate: "Scout.", channelOverrides: [{ channel: "C0OPS", mandate: "No paging.", mandateMode: "reduce", approvers: [] }] } }]));
    const text = await prompt("scout", "C0OPS");
    expect(text).toContain("<channel-mandate>\nFor this channel your mandate is: Scout.\n\nLimit for this channel");
    expect(text).toContain("No paging.");
    expect(text).not.toContain("Default global.");
    expect(await prompt("scout", "C0ELSE")).not.toContain("<channel-mandate>");
  });

  test("the default persona still reads its own sub-mandates", async () => {
    setSoulData(SCOPED);
    expect(await prompt("default", "D0ALICE")).toContain("For this channel your mandate is: Be brief.");
  });
});

describe("scheduler: an empty channel mandate", () => {
  test("reads as null (it follows the global one), like an absent block", () => {
    setSoulData(SoulDataSchema.parse({}));
    setPersonaRegistry(registry([{ name: "scout", soulMd: "# Scout\n", soulJson: { mandate: "Scout.", channelOverrides: [{ channel: "C0EMPTY", mandate: "", approvers: [] }, { channel: "C0OWN", mandate: "Own.", approvers: [] }] } }]));
    expect(personaMandates("scout", ["C0EMPTY", "C0OWN", "C0NONE"]).channels).toEqual({ C0EMPTY: null, C0OWN: "Own.", C0NONE: null });
  });
});

describe("scheduler parts", () => {
  test("an extend or reduce carries parts, a legacy soul none", () => {
    setSoulData(SCOPED);
    const m = personaMandates("default", ["CPUB", "D0ALICE"]);
    expect(m.parts!.CPUB!.global).toBe("Global.");
    expect(m.parts!.CPUB!.addition).toContain("No internals.");
    expect(m.parts!.D0ALICE).toBeUndefined();
    setSoulData(LEGACY);
    expect(personaMandates("default", ["COVER"]).parts).toBeUndefined();
  });
});

describe("nothing installed", () => {
  test("the default structure is empty: no mandate, no channel lists, so nobody is admitted", () => {
    __resetSoulDataMemo();
    expect(effectiveSoulForChannel("C0OPS").mandate).toBeUndefined();
    expect(soulData().allowedChannels).toEqual([]);
    expect(soulData().trustedChannels).toEqual([]);
  });
});

describe("scope blocks and the raw persona text", () => {
  const md = "# Ana\n\n## Mandate\nGlobal.\n\n## Scope dm\n### Mandate\nDM-ONLY-TEXT\n\n## Values\n- calm\n";

  test("a turn elsewhere never reads a scope block; the turn it applies to reads it resolved", async () => {
    const agent = new AgentManager();
    agent.setPersonaSoulResolver(async () => ({ soulMd: md, soulJson: { mandate: "Global.", scopeMandates: [{ scope: "dm", mandate: "DM-ONLY-TEXT" }] } }));
    const elsewhere = await agent.__systemPromptForTests("s1", "ana", { channelId: "C0ELSE" });
    expect(elsewhere).not.toContain("DM-ONLY-TEXT");
    expect(elsewhere).toContain("## Values");
    expect(await agent.__systemPromptForTests("s2", "ana", { channelId: "D0ALICE" })).toContain("For this channel your mandate is: DM-ONLY-TEXT");
  });
});

describe("personaManager for a persona synced before agent.yaml", () => {
  test("reads the manager from its stored structure, even when the soul text has no Reporting section", async () => {
    const { personaManager } = await import("../../src/background/scheduler");
    setSoulData(SoulDataSchema.parse({ manager: { userId: "UDEFMGR" } }));
    setPersonaRegistry(registry([{ name: "scout", soulMd: "# Scout\nNo reporting section here.\n", soulJson: { manager: { userId: "USTOREDMGR" } } }]));
    expect(personaManager("scout")).toBe("USTOREDMGR");
  });
});
