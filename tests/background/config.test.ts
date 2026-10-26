import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { budgetConfigFor, __resetBackgroundConfigWarnings } from "../../src/background/config";
import { canStart } from "../../src/background/budget";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../src/persona/registry";
import type { Persona } from "../../src/persona/types";
import type { PersonaBackground } from "../../src/persona/sync/payload";

const persona = (name: string, background?: PersonaBackground | null): Persona => ({
  name, slackUserId: `U0${name.toUpperCase()}`, soulMd: "s", config: { slackUserId: `U0${name.toUpperCase()}`, name }, outClient: null, background,
});
function install(personas: Persona[], def?: PersonaBackground | null) {
  const reg: PersonaRegistry = {
    lookupByUserId: () => null,
    lookupByName: (n) => personas.find((p) => p.name === n) ?? null,
    list: () => personas,
    isMultiPersonaMode: () => personas.length > 0,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => ({ model: null, mcp: null, background: def ?? null }),
  };
  setPersonaRegistry(reg);
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.SLAUDE_BACKGROUND_BUDGET_USD;
  delete process.env.SLAUDE_BACKGROUND_BUDGET_USD;
  delete process.env.SLAUDE_BACKGROUND_TIMEZONE;
  __resetBackgroundConfigWarnings();
});
afterEach(() => {
  delete process.env.SLAUDE_BACKGROUND_TIMEZONE;
  if (saved === undefined) delete process.env.SLAUDE_BACKGROUND_BUDGET_USD;
  else process.env.SLAUDE_BACKGROUND_BUDGET_USD = saved;
  __resetPersonaRegistry();
});

describe("budgetConfigFor", () => {
  test("defaults: 1 USD, UTC", () => {
    install([persona("ana")]);
    expect(budgetConfigFor("ana")).toEqual({ limitUsd: 1, timeZone: "UTC" });
    expect(budgetConfigFor("not-listed")).toEqual({ limitUsd: 1, timeZone: "UTC" });
  });
  test("env wins over the default", () => {
    process.env.SLAUDE_BACKGROUND_BUDGET_USD = "3";
    install([persona("ana")]);
    expect(budgetConfigFor("ana").limitUsd).toBe(3);
  });
  test("persona wins over env", () => {
    process.env.SLAUDE_BACKGROUND_BUDGET_USD = "3";
    install([persona("ana", { budgetUsd: 7, timezone: "Asia/Tokyo" }), persona("bea", { timezone: "Europe/Berlin" })]);
    expect(budgetConfigFor("ana")).toEqual({ limitUsd: 7, timeZone: "Asia/Tokyo" });
    expect(budgetConfigFor("bea")).toEqual({ limitUsd: 3, timeZone: "Europe/Berlin" });
  });
  test("timezone: persona > env > UTC", () => {
    process.env.SLAUDE_BACKGROUND_TIMEZONE = "Asia/Tokyo";
    install([persona("ana", { timezone: "Europe/Berlin" }), persona("bea")]);
    expect(budgetConfigFor("ana").timeZone).toBe("Europe/Berlin");
    expect(budgetConfigFor("bea").timeZone).toBe("Asia/Tokyo");
    delete process.env.SLAUDE_BACKGROUND_TIMEZONE;
    expect(budgetConfigFor("bea").timeZone).toBe("UTC");
  });
  test("an invalid env timezone falls back to UTC with one warning", () => {
    process.env.SLAUDE_BACKGROUND_TIMEZONE = "Mars/Olympus";
    install([persona("ana")]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(budgetConfigFor("ana").timeZone).toBe("UTC");
      budgetConfigFor("ana");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
  test("a process with no persona registry (mono) uses env then defaults", () => {
    process.env.SLAUDE_BACKGROUND_TIMEZONE = "Asia/Tokyo";
    process.env.SLAUDE_BACKGROUND_BUDGET_USD = "2";
    setPersonaRegistry({
      lookupByUserId: () => null, lookupByName: () => null, list: () => [],
      isMultiPersonaMode: () => false, isManaged: () => false, tombstonedPersonaFor: () => null,
    });
    expect(budgetConfigFor("default")).toEqual({ limitUsd: 2, timeZone: "Asia/Tokyo" });
  });
  test("the default persona reads the tenant's default row", () => {
    install([], { budgetUsd: 2 });
    expect(budgetConfigFor("default").limitUsd).toBe(2);
  });
  test("a bad timezone falls back to UTC with one warning per persona, and canStart never throws", async () => {
    install([persona("ana", { timezone: "Mars/Olympus" }), persona("bea", { timezone: "Nope" })]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cfg = budgetConfigFor("ana");
      expect(cfg.timeZone).toBe("UTC");
      budgetConfigFor("ana");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("persona=ana");
      budgetConfigFor("bea");
      expect(warn).toHaveBeenCalledTimes(2);
      const r = await canStart(cfg, "cfg-bad-zone", "skill-check", new Date("2026-10-26T12:00:00Z"));
      expect(r.ok).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
