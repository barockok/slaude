import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileAgent } from "../../src/persona/file-agent";
import { PayloadError } from "../../src/persona/sync/payload";
import { parseProactive } from "../../src/soul/proactive";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "file-agent-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const put = (f: string, text: string) => writeFileSync(join(dir, f), text);
const err = (f: () => unknown): Error => { try { f(); } catch (e) { return e as Error; } throw new Error("did not throw"); };

describe("readFileAgent", () => {
  test("no agent.yaml reads as null", () => {
    expect(readFileAgent(dir, "ana")).toBeNull();
  });

  test("compiles the soul, the structure and the definition", () => {
    put("agent.yaml", [
      "name: ana",
      "description: Handles support",
      "slackUserId: slack:user:U0ANA",
      "soul: |",
      "  You are Ana.",
      "access:",
      "  manager: slack:user:U0BOSS",
      "  channels:",
      "    trusted: [slack:channel:C0TEAM]",
      "skills: [triage]",
      "proactive:",
      "  read: [slack:channel:C0TEAM]",
      "channels:",
      "  slack:channel:C0TEAM: { proactive: true }",
      "",
    ].join("\n"));
    const a = readFileAgent(dir, "ana")!;
    expect(a.slackUserId).toBe("U0ANA");
    expect(a.soulJson.manager.userId).toBe("U0BOSS");
    expect(a.soulJson.trustedChannels).toEqual(["C0TEAM"]);
    expect(a.definition).toEqual({ description: "Handles support", skills: ["triage"] });
    expect(a.soulMd.startsWith("You are Ana.")).toBe(true);
    const p = parseProactive(a.soulMd);
    expect(p.read).toEqual(["C0TEAM"]);
    expect(p.channels).toEqual({ C0TEAM: true });
    expect(a.warnings).toEqual([]);
  });

  test("SOUL.md or persona.yaml beside it is refused", () => {
    put("agent.yaml", "name: ana\nsoul: x\n");
    put("SOUL.md", "old");
    const e = err(() => readFileAgent(dir, "ana"));
    expect(e).toBeInstanceOf(PayloadError);
    expect(e.message).toContain("SOUL.md");
  });

  test("config.json and mcp.json beside it are fine", () => {
    put("agent.yaml", "name: ana\nsoul: x\n");
    put("config.json", "{}");
    put("mcp.json", "{}");
    expect(readFileAgent(dir, "ana")).not.toBeNull();
  });

  for (const [yaml, key, where] of [
    ["model: provider/m\n", "model", "SLAUDE_MODEL"],
    ["runsOn: finance\n", "runsOn", "config.json"],
    ["userToken: \"${PERSONA_ANA_XOXP}\"\n", "userToken", "config.json"],
    ["mcp:\n  mcpServers: {}\n", "mcp", "mcp.json"],
    ["provider:\n  apiKey: env://PERSONA_ANA_KEY\n", "provider", "environment"],
    ["memory:\n  kbSources: [kb-a]\n", "memory.kbSources", "knowledge bases"],
    ["memory:\n  background: { budgetUsd: 2 }\n", "memory.background", "environment"],
  ] as const) {
    test(`${key} is refused and says where it lives`, () => {
      put("agent.yaml", `name: ana\nsoul: x\n${yaml}`);
      const e = err(() => readFileAgent(dir, "ana"));
      expect(e).toBeInstanceOf(PayloadError);
      expect(e.message).toContain(`agent.yaml ${key} cannot be set in a file on disk yet`);
      expect(e.message).toContain(where);
    });
  }

  test("a malformed file throws with the persona and the key", () => {
    mkdirSync(join(dir, "x"));
    put("agent.yaml", "name: ana\nsoul: x\naccess:\n  manager: 12\n");
    const e = err(() => readFileAgent(dir, "ana"));
    expect(e).toBeInstanceOf(PayloadError);
    expect(e.message).toContain("persona 'ana'");
  });
});
