/**
 * A node builds a persona's channel mandate from the structured soul the
 * gateway sent in the runtime bundle, never from a database or from the
 * node's own disk, and never by reading the soul text.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../../src/agent/manager";
import { __resetNodeRefusalLogForTests } from "../../src/db/client";
import { __resetCacheForTests } from "../../src/db/soul-overrides";
import { __resetSoulDataMemo, setSoulData, soulData } from "../../src/soul/extract";
import { SoulDataSchema } from "../../src/soul/data";
import { approvalTimeoutFor, redactPatternsFor, soulDataFor } from "../../src/soul/per-persona";
import { __resetPersonaRegistry, setPersonaRegistry } from "../../src/persona/registry";
import type { Persona } from "../../src/persona/types";
import { personaMandateText } from "../../src/soul/persona-mandates";

const KEYS = ["SLAUDE_ROLE", "SLAUDE_DB", "SLAUDE_PG_URL", "SLAUDE_HOME"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "node-soul-"));
  process.env.SLAUDE_HOME = home;
  process.env.SLAUDE_ROLE = "node";
  delete process.env.SLAUDE_DB;
  delete process.env.SLAUDE_PG_URL;
  __resetCacheForTests();
  __resetSoulDataMemo();
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
  __resetCacheForTests();
  __resetSoulDataMemo();
});

const SOUL_TEXT = "# Sam\nKeeps the board tidy.";
const COMPILED = {
  mandate: "Keep the board tidy.",
  channelOverrides: [{ channel: "CTEAM01", mandate: "In this channel only triage incoming asks.", approvers: [] }],
};

function capture() {
  const errs: string[] = [];
  const e = spyOn(console, "error").mockImplementation((...a: unknown[]) => { errs.push(a.map(String).join(" ")); });
  // The guard logs once per process: re-arm it so each test sees its own refusal.
  __resetNodeRefusalLogForTests();
  __resetCacheForTests();
  return { errs, restore: () => e.mockRestore() };
}

describe("node channel mandate without a database", () => {
  test("the channel mandate comes from the bundle's structured soul, no database access", async () => {
    const c = capture();
    try {
      const agent = new AgentManager();
      agent.setPersonaSoulResolver(async () => ({ soulMd: SOUL_TEXT, soulJson: COMPILED }));
      const prompt = await agent.__systemPromptForTests("s-1", "sam", { channelId: "CTEAM01" });
      expect(prompt).toContain("<channel-mandate>");
      expect(prompt).toContain("In this channel only triage incoming asks.");
      const other = await agent.__systemPromptForTests("s-2", "sam", { channelId: "COTHER01" });
      expect(other).not.toContain("<channel-mandate>");
    } finally {
      c.restore();
    }
    expect(c.errs.filter((l) => l.includes("[db]"))).toEqual([]);
  });

  test("a bundle with no structured soul gets no channel mandate: the soul text is never read for one", async () => {
    const c = capture();
    try {
      const agent = new AgentManager();
      const text = "# Sam\n## Mandate\nKeep the board tidy.\n## Channel CTEAM01\n### Mandate\nIn this channel only triage incoming asks.";
      agent.setPersonaSoulResolver(async () => ({ soulMd: text, soulJson: null }));
      const prompt = await agent.__systemPromptForTests("s-1", "sam", { channelId: "CTEAM01" });
      expect(prompt).not.toContain("<channel-mandate>");
    } finally {
      c.restore();
    }
  });

  test("a bundle with no structured soul says so once per persona, not on every turn", async () => {
    const c = capture();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const agent = new AgentManager();
      agent.setPersonaSoulResolver(async () => ({ soulMd: "# Sam\n", soulJson: null }));
      await agent.__systemPromptForTests("s-1", "once-persona", { channelId: "CTEAM01" });
      await agent.__systemPromptForTests("s-2", "once-persona", { channelId: "CTEAM01" });
      const said = warn.mock.calls.filter((a) => String(a[0]).includes("persona=once-persona") && String(a[0]).includes("no structured soul"));
      expect(said).toHaveLength(1);
    } finally {
      warn.mockRestore();
      c.restore();
    }
  });

  test("soulData() on a node never reaches for the database", () => {
    const c = capture();
    try {
      setSoulData(SoulDataSchema.parse({ mandate: "Base mandate.", trustedChannels: ["CT1"] }));
      const got = soulData();
      expect(got.mandate).toBe("Base mandate.");
      expect(got.trustedChannels).toEqual(["CT1"]);
    } finally {
      __resetSoulDataMemo();
      c.restore();
    }
    expect(c.errs.filter((l) => l.includes("[db]"))).toEqual([]);
  });

  test("personaMandateText for a compiled persona does not read the database either", () => {
    const c = capture();
    try {
      const sam = { name: "sam", slackUserId: "U0P", config: { slackUserId: "U0P", name: "sam" }, outClient: null, soulMd: SOUL_TEXT, soulJson: COMPILED, definition: {} } as unknown as Persona;
      setPersonaRegistry({
        lookupByUserId: () => null, lookupByName: (n) => (n === "sam" ? sam : null), list: () => [sam],
        isMultiPersonaMode: () => true, isManaged: () => true, tombstonedPersonaFor: () => null,
      });
      const t = personaMandateText("sam");
      expect(t.global).toBe("Keep the board tidy.");
      expect(t.channels).toEqual({ CTEAM01: "In this channel only triage incoming asks." });
    } finally {
      __resetPersonaRegistry();
      c.restore();
    }
    expect(c.errs.filter((l) => l.includes("[db]"))).toEqual([]);
  });

  test("the per-persona readers (soulDataFor, redact patterns, approval timeout) skip the database on a node", () => {
    const c = capture();
    try {
      setSoulData(SoulDataSchema.parse({ redactPatterns: ["secret-\\d+"], approvalTimeoutSeconds: 123, allowedChannels: ["CA1"] }));
      expect(soulDataFor("sam").allowedChannels).toEqual(["CA1"]);
      expect(redactPatternsFor("sam")).toEqual(["secret-\\d+"]);
      expect(approvalTimeoutFor("sam")).toBe(123);
    } finally {
      __resetSoulDataMemo();
      c.restore();
    }
    expect(c.errs.filter((l) => l.includes("[db]"))).toEqual([]);
  });
});
