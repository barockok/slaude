/**
 * A node builds a SOUL.md persona's channel mandate from the soul text the
 * gateway sent in the runtime bundle, never from a database or from the
 * node's own disk. A filesystem persona's bundle carries `soulJson: null`.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../../src/agent/manager";
import { __resetNodeRefusalLogForTests } from "../../src/db/client";
import { __resetCacheForTests } from "../../src/db/soul-overrides";
import { __resetSoulDataMemo, soulData } from "../../src/soul/extract";
import { approvalTimeoutFor, redactPatternsFor, soulDataFor } from "../../src/soul/per-persona";
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

const SOUL = [
  "# Sam",
  "## Mandate",
  "Keep the board tidy.",
  "## Channel CTEAM01",
  "### Mandate",
  "In this channel only triage incoming asks.",
].join("\n");

function capture() {
  const errs: string[] = [];
  const e = spyOn(console, "error").mockImplementation((...a: unknown[]) => { errs.push(a.map(String).join(" ")); });
  // The guard logs once per process: re-arm it so each test sees its own refusal.
  __resetNodeRefusalLogForTests();
  __resetCacheForTests();
  return { errs, restore: () => e.mockRestore() };
}

describe("node channel mandate without a database", () => {
  test("soulJson null: the channel mandate is parsed from the bundle's soul text, no database access", async () => {
    const c = capture();
    try {
      const agent = new AgentManager();
      agent.setPersonaSoulResolver(async () => ({ soulMd: SOUL, soulJson: null }));
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

  test("soulData() on a node never reaches for the database", () => {
    const c = capture();
    try {
      soulData();
    } finally {
      c.restore();
    }
    expect(c.errs.filter((l) => l.includes("[db]"))).toEqual([]);
  });

  test("personaMandateText on a node does not read the database either", () => {
    const c = capture();
    try {
      personaMandateText("sam");
    } finally {
      c.restore();
    }
    expect(c.errs.filter((l) => l.includes("[db]"))).toEqual([]);
  });

  test("the per-persona readers (soulDataFor, redact patterns, approval timeout) skip the database on a node", () => {
    const c = capture();
    try {
      soulDataFor("sam");
      redactPatternsFor("sam");
      approvalTimeoutFor("sam");
    } finally {
      c.restore();
    }
    expect(c.errs.filter((l) => l.includes("[db]"))).toEqual([]);
  });
});
