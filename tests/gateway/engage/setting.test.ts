import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseAgentYaml } from "../../../src/persona/agent-def";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../../src/persona/registry";
import type { Persona } from "../../../src/persona/types";
import { aliasesFor, engageFor } from "../../../src/gateway/engage/setting";

const YAML = `
name: ana
slackUserId: UANA1
soul: You are Ana.
aliases: [anabot]
access:
  channels:
    public: [C0PUBLIC]
    trusted: [C0TRUST1, C0TRUST2, C0TRUST3]
channels:
  C0PUBLIC: { engage: { level: addressed, mode: on } }
  C0TRUST1: { engage: { level: contribute } }
  C0TRUST2: { engage: { mode: on } }
  C0RESTRICT: { engage: { level: contribute, mode: on } }
`;

function registry(p: Persona): PersonaRegistry {
  return {
    lookupByUserId: (id) => (id === p.slackUserId ? p : null),
    lookupByName: (n) => (n === p.name ? p : null),
    list: () => [p],
    isMultiPersonaMode: () => true,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => ({ model: null, mcp: null, definition: null }),
  };
}
function persona(): Persona {
  const { spec } = parseAgentYaml("ana", YAML);
  const { soulData, ...definition } = spec.definition;
  return {
    name: "ana", slackUserId: "UANA1", soulMd: spec.soul, config: { slackUserId: "UANA1", name: "ana" },
    outClient: null, model: null, runsOn: null, provider: null, kbSources: null, background: null, mcp: null,
    soulJson: soulData, definition,
  };
}

const saved = process.env.SLAUDE_ENGAGE_DEFAULT;
beforeEach(() => {
  delete process.env.SLAUDE_ENGAGE_DEFAULT;
  setPersonaRegistry(registry(persona()));
});
afterEach(() => {
  __resetPersonaRegistry();
  if (saved === undefined) delete process.env.SLAUDE_ENGAGE_DEFAULT;
  else process.env.SLAUDE_ENGAGE_DEFAULT = saved;
});

describe("engageFor", () => {
  test("an explicit level and mode", () => {
    expect(engageFor("ana", "C0PUBLIC")).toEqual({ level: "addressed", mode: "on" });
    expect(engageFor("ana", "C0TRUST1")).toEqual({ level: "contribute", mode: "shadow" });
  });
  test("a level left out takes the deployment default; a mode left out is shadow", () => {
    expect(engageFor("ana", "C0TRUST2")).toEqual({ level: "mention", mode: "on" });
    process.env.SLAUDE_ENGAGE_DEFAULT = "addressed";
    expect(engageFor("ana", "C0TRUST2")).toEqual({ level: "addressed", mode: "on" });
    expect(engageFor("ana", "C0TRUST3")).toEqual({ level: "addressed", mode: "shadow" });
  });
  test("no config at all is mention in shadow; a bad default reads as mention", () => {
    expect(engageFor("ana", "C0TRUST3")).toEqual({ level: "mention", mode: "shadow" });
    process.env.SLAUDE_ENGAGE_DEFAULT = "loud";
    expect(engageFor("ana", "C0TRUST3")).toEqual({ level: "mention", mode: "shadow" });
  });
  test("a restricted channel is forced to mention, whatever it says", () => {
    process.env.SLAUDE_ENGAGE_DEFAULT = "contribute";
    expect(engageFor("ana", "C0RESTRICT")).toEqual({ level: "mention", mode: "on" });
    expect(engageFor("ana", "C0UNKNOWN")).toEqual({ level: "mention", mode: "shadow" });
  });
  test("aliases are read from the same structure", () => {
    expect(aliasesFor("ana")).toEqual(["anabot"]);
  });
});

describe("proactive implies addressed", () => {
  const PRO = `
name: ana
slackUserId: UANA1
soul: You are Ana.
access:
  channels:
    trusted: [C0PRO1, C0PRO2, C0PRO3, C0PRO4, C0PLAIN]
channels:
  C0PRO1: { proactive: true }
  C0PRO2: { proactive: true, engage: { level: mention } }
  C0PRO3: { proactive: true, engage: { mode: on } }
  C0PRO4: { proactive: false }
  C0PLAIN: {}
  C0PRORESTRICT: { proactive: true }
`;
  function proPersona(): Persona {
    const { spec } = parseAgentYaml("ana", PRO);
    const { soulData, ...definition } = spec.definition;
    return {
      name: "ana", slackUserId: "UANA1", soulMd: spec.soul, config: { slackUserId: "UANA1", name: "ana" },
      outClient: null, model: null, runsOn: null, provider: null, kbSources: null, background: null, mcp: null,
      soulJson: soulData, definition,
    };
  }
  beforeEach(() => setPersonaRegistry(registry(proPersona())));

  test("a proactive channel with no engage level is addressed, in shadow", () => {
    expect(engageFor("ana", "C0PRO1")).toEqual({ level: "addressed", mode: "shadow" });
  });
  test("an explicit level always wins, even mention; a mode alone leaves the level to proactive", () => {
    expect(engageFor("ana", "C0PRO2")).toEqual({ level: "mention", mode: "shadow" });
    expect(engageFor("ana", "C0PRO3")).toEqual({ level: "addressed", mode: "on" });
  });
  test("proactive beats the deployment default; no proactive keeps it", () => {
    process.env.SLAUDE_ENGAGE_DEFAULT = "contribute";
    expect(engageFor("ana", "C0PRO1")).toEqual({ level: "addressed", mode: "shadow" });
    expect(engageFor("ana", "C0PRO4")).toEqual({ level: "contribute", mode: "shadow" });
    expect(engageFor("ana", "C0PLAIN")).toEqual({ level: "contribute", mode: "shadow" });
  });
  test("SLAUDE_ENGAGE_PROACTIVE_DEFAULT=off restores the deployment default; an explicit level is unaffected", () => {
    const saved = process.env.SLAUDE_ENGAGE_PROACTIVE_DEFAULT;
    try {
      process.env.SLAUDE_ENGAGE_PROACTIVE_DEFAULT = "off";
      expect(engageFor("ana", "C0PRO1")).toEqual({ level: "mention", mode: "shadow" });
      process.env.SLAUDE_ENGAGE_DEFAULT = "contribute";
      expect(engageFor("ana", "C0PRO1")).toEqual({ level: "contribute", mode: "shadow" });
      expect(engageFor("ana", "C0PRO2")).toEqual({ level: "mention", mode: "shadow" });
      process.env.SLAUDE_ENGAGE_PROACTIVE_DEFAULT = "on";
      expect(engageFor("ana", "C0PRO1")).toEqual({ level: "addressed", mode: "shadow" });
    } finally {
      if (saved === undefined) delete process.env.SLAUDE_ENGAGE_PROACTIVE_DEFAULT;
      else process.env.SLAUDE_ENGAGE_PROACTIVE_DEFAULT = saved;
    }
  });
  test("without proactive nothing changes; a restricted channel still mentions", () => {
    expect(engageFor("ana", "C0PLAIN")).toEqual({ level: "mention", mode: "shadow" });
    expect(engageFor("ana", "C0PRORESTRICT")).toEqual({ level: "mention", mode: "shadow" });
  });
});
