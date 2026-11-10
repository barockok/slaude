import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAgentYaml, renderDir } from "../../src/cli/personas";
import { parse as parseYaml } from "yaml";
import { agentDocument, documentPartsFromSoul, proseOnlySoul } from "../../src/persona/agent-def";
import { SoulDataSchema, type SoulData } from "../../src/soul/data";
import { subMandatesOf } from "../../src/soul/mandate-scope";
import { parseProactive } from "../../src/soul/proactive";

const meta = { revision: "r1", committedAt: "2026-10-01T10:00:00Z" };
const tmp = () => mkdtempSync(join(tmpdir(), "slaude-agent-export-"));

describe("export to agent.yaml", () => {
  const soulMd = [
    "# Persona", "## Identity", "- Name: Ana", "- Voice: terse", "",
    "## Reporting", "- Manager: UBOSS", "",
    "## Mandate", "Help the team.", "",
    "## Channel <#COPS|ops>", "### Mandate", "Watch deploys.", "",
    "## Values", "- be honest", "",
  ].join("\n");
  const extracted: SoulData = SoulDataSchema.parse({
    identity: { name: "Ana", role: "Support", voice: "terse" },
    manager: { userId: "UBOSS" },
    approvers: [{ userId: "UBOB", scope: "budget", catchall: false }],
    allowedChannels: ["CPUB"],
    trustedChannels: ["CTEAM"],
    blockedUsers: ["UNOISY"],
    dmAllowedUsers: ["UFRIEND"],
    redactPatterns: ["x-[0-9]+"],
    approvalTimeoutSeconds: 45,
    mandate: "Help the team.",
    channelOverrides: [{ channel: "COPS", mandate: "Watch deploys.", approvers: [{ userId: "UEVE", scope: "ops", catchall: false }] }],
    scopeMandates: [{ scope: "dm", mandate: "Be brief.", mode: "reduce" }],
  });

  function home(): string {
    const h = tmp();
    writeFileSync(join(h, "SOUL.md"), "default soul\n");
    mkdirSync(join(h, "personas", "ana"), { recursive: true });
    writeFileSync(join(h, "personas", "ana", "SOUL.md"), soulMd);
    writeFileSync(join(h, "personas", "ana", "config.json"), JSON.stringify({ slackUserId: "UTESTUSER1", userToken: "user-token-live-secret" }));
    writeFileSync(join(h, "personas", "ana", "mcp.json"), JSON.stringify({ mcpServers: { tracker: { type: "http", url: "https://x.example.com/mcp", headers: { Authorization: "Bearer live-secret" } } } }));
    return h;
  }

  test("round trip: exported files render to the same structure, secrets stay references", async () => {
    const out = tmp();
    const { variables } = await exportAgentYaml(home(), out, { extract: async () => extracted });
    expect(variables).toContain("PERSONA_ANA_XOXP");
    const text = readFileSync(join(out, "personas", "ana", "agent.yaml"), "utf8");
    expect(text).not.toContain("user-token-live-secret");
    expect(text).not.toContain("live-secret");
    expect(text).toContain("${PERSONA_ANA_XOXP}");

    const p = renderDir(out, meta);
    const ana = p.personas.find((x) => x.name === "ana")!;
    const compiled = ana.definition!.soulData;
    for (const k of ["manager", "approvers", "allowedChannels", "trustedChannels", "blockedUsers", "dmAllowedUsers", "redactPatterns", "approvalTimeoutSeconds", "mandate"] as const) {
      expect(compiled[k]).toEqual(extracted[k]);
    }
    // A channel block's mode is written out explicitly; absent and override mean the same.
    expect(compiled.channelOverrides.map((c) => c.approvers)).toEqual(extracted.channelOverrides.map((c) => c.approvers));
    expect(subMandatesOf(compiled)).toEqual(subMandatesOf(extracted));
    expect(ana.definition!.description).toBe("Support");
    // The prose keeps identity and values; structured sections are gone.
    expect(ana.soul).toContain("Voice: terse");
    expect(ana.soul).toContain("be honest");
    expect(ana.soul).not.toContain("## Reporting");
    expect(ana.soul).not.toContain("## Channel");
    expect(ana.slackUserId).toBe("UTESTUSER1");
    expect(ana.mcp).toEqual({ mcpServers: { tracker: { type: "http", url: "https://x.example.com/mcp", headers: { Authorization: "${PERSONA_ANA_TRACKER_AUTHORIZATION}" } } } });
  });

  test("channel session and proactive settings survive the export and re-compile the same", async () => {
    const source = `${soulMd}\n## Channel <#CSESS>\n### Session\n- Mode: channel\n### Proactive\n- Enabled: yes\n\n## Channel <#CQUIET>\n### Proactive\n- Enabled: no\n\n## Channel <#CBAD>\n### Session\n- Mode: thread\n`;
    const h = home();
    writeFileSync(join(h, "personas", "ana", "SOUL.md"), source);
    const out = tmp();
    await exportAgentYaml(h, out, { extract: async () => extracted });
    const doc = parseYaml(readFileSync(join(out, "personas", "ana", "agent.yaml"), "utf8")) as Record<string, unknown>;
    expect(doc.channels).toEqual({ CSESS: { session: "channel", proactive: true }, CQUIET: { proactive: false } });
    const ana = renderDir(out, meta).personas.find((p) => p.name === "ana")!;
    const before = parseProactive(source);
    const after = parseProactive(ana.soul);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.channels).toEqual(before.channels);
  });

  async function exportChannels(blocks: string): Promise<{ channels: unknown; warned: string; out: string }> {
    const h = home();
    writeFileSync(join(h, "personas", "ana", "SOUL.md"), `${soulMd}\n${blocks}`);
    const out = tmp();
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await exportAgentYaml(h, out, { extract: async () => extracted });
      const doc = parseYaml(readFileSync(join(out, "personas", "ana", "agent.yaml"), "utf8")) as Record<string, unknown>;
      return { channels: doc.channels, warned: spy.mock.calls.map((c) => String(c[0])).join("\n"), out };
    } finally {
      spy.mockRestore();
    }
  }

  test("an Enabled: yes channel with limits exports as proactive: the limits have no effect in a channel session", async () => {
    const { channels, warned } = await exportChannels("## Channel <#CLIMIT>\n### Proactive\n- Enabled: yes\n- Highest: ask\n- Cooldown: 4 hours\n");
    expect(channels).toEqual({ CLIMIT: { proactive: true } });
    expect(warned).not.toContain("CLIMIT");
  });

  test("a channel with an invalid Mode exports as off", async () => {
    const { channels } = await exportChannels("## Channel <#CBAD>\n### Session\n- Mode: thread\n### Proactive\n- Enabled: yes\n");
    expect(channels).toEqual({ CBAD: { proactive: false } });
  });

  test("a classic channel with limits that is off stays off", async () => {
    const { channels, warned } = await exportChannels("## Channel <#CLIMIT>\n### Proactive\n- Enabled: no\n- Max per day: 2\n");
    expect(channels).toEqual({ CLIMIT: { proactive: false } });
    expect(warned).toContain("Max per day");
  });

  test("a channel-mode channel carries proactive, with no warning", async () => {
    const { channels, warned } = await exportChannels("## Channel <#CSESS>\n### Session\n- Mode: channel\n### Proactive\n- Enabled: yes\n- Highest: ask\n");
    expect(channels).toEqual({ CSESS: { session: "channel", proactive: true } });
    expect(warned).not.toContain("CSESS");
  });

  test("a soul of only structured sections keeps them in the soul, and still compiles", async () => {
    const h = home();
    writeFileSync(join(h, "personas", "ana", "SOUL.md"), "## Channel <#CSESS>\n### Session\n- Mode: channel\n");
    const out = tmp();
    await exportAgentYaml(h, out, { extract: async () => extracted });
    const ana = renderDir(out, meta).personas.find((p) => p.name === "ana")!;
    expect(parseProactive(ana.soul).sessions).toEqual({ CSESS: "channel" });
  });

  test("--persona exports one persona only, and asks no extraction for the others", async () => {
    const out = tmp();
    let calls = 0;
    await exportAgentYaml(home(), out, { only: "ana", extract: async () => { calls++; return extracted; } });
    expect(calls).toBe(1);
    expect(() => readFileSync(join(out, "personas", "default", "agent.yaml"))).toThrow();
    rmSync(out, { recursive: true });
  });

  test("agentDocument leaves out what is empty, and proseOnlySoul keeps what it does not recognise", () => {
    const doc = agentDocument({ name: "a", soul: "s", ...documentPartsFromSoul(SoulDataSchema.parse({})) });
    expect(doc).toEqual({ name: "a", soul: "s" });
    expect(proseOnlySoul("## Goals\nkeep\n## Manager\ndrop\n")).toBe("## Goals\nkeep\n");
  });
});
