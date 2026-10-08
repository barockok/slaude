import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../src/persona/registry";
import type { Persona } from "../../src/persona/types";
import { SoulDataSchema } from "../../src/soul/data";
import { writeSoulCacheEntry } from "../../src/soul/extract";
import { monoPersonaSoul } from "../../src/voice/mono-soul";
import { instructionsFrom } from "../../src/voice/hosts";

const persona = (name: string, soulMd: string): Persona =>
  ({ name, slackUserId: "U0PER1", soulMd, config: { slackUserId: "U0PER1", name }, outClient: null }) as Persona;

function registry(personas: Persona[], managed: boolean): PersonaRegistry {
  return {
    lookupByUserId: () => null,
    lookupByName: (n) => personas.find((p) => p.name === n) ?? null,
    list: () => personas,
    isMultiPersonaMode: () => personas.length > 0,
    isManaged: () => managed,
    tombstonedPersonaFor: () => null,
  };
}

afterEach(() => __resetPersonaRegistry());

describe("monoPersonaSoul", () => {
  it("a named persona speaks with its own extracted soul, channel mandate applied", () => {
    const md = "# Ops Bot\nRuns the on-call rota for #team-channel C0OPS1.";
    writeSoulCacheEntry(md, SoulDataSchema.parse({
      identity: { name: "Ops Bot", role: "on-call helper" },
      values: ["calm"],
      mandate: "keep the rota",
      channelOverrides: [{ channel: "C0OPS1", mandate: "only incidents" }],
    }));
    setPersonaRegistry(registry([persona("ops-bot", md)], true));
    const plain = instructionsFrom(monoPersonaSoul("ops-bot", "C0OTHER01"), "b");
    expect(plain).toContain("You are Ops Bot, on-call helper.");
    expect(plain).toContain("Mandate: keep the rota");
    expect(instructionsFrom(monoPersonaSoul("ops-bot", "C0OPS1"), "b")).toContain("Mandate: only incidents");
  });

  it("without an extracted soul the voice still carries the persona's name, not the default's", () => {
    setPersonaRegistry(registry([persona("helper", "# never extracted")], false));
    expect(instructionsFrom(monoPersonaSoul("helper", "C1"), "b")).toContain("You are helper.");
  });

  it("a retired or unknown persona cannot be resolved", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    setPersonaRegistry(registry([], true));
    expect(monoPersonaSoul("retired", "C1")).toBeNull();
    setPersonaRegistry(registry([], false));
    expect(monoPersonaSoul("unknown", "C1")).toBeNull();
    warn.mockRestore();
  });

  it("the default persona uses the gateway's effective soul", () => {
    expect(monoPersonaSoul(null, "C1")).toBeTruthy();
    expect(monoPersonaSoul("default", "C1")).toBeTruthy();
  });
});
