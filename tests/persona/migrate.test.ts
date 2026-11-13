import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migratePersona, SOUL_BACKUP_SUFFIX } from "../../src/persona/migrate";
import { readFileAgent } from "../../src/persona/file-agent";
import { PayloadError } from "../../src/persona/sync/payload";
import { SoulDataSchema, type SoulData } from "../../src/soul/data";
import { parseProactive } from "../../src/soul/proactive";
import { withAclFallback } from "../../src/soul/per-persona";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "migrate-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const put = (rel: string, text: string) => {
  const f = join(home, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, text);
};

const DEFAULT_SOUL = `# Persona

## Identity
- Name: Trev
- Role: personal engineering agent
- Voice: terse, direct.

## Reporting
- Manager: U0BOSS

## Trusted channels
- <#C0HOME|home>
- <#C0WORK|work>

## Approvers
- <@U0BOSS>: anything ; catchall

## Redaction
- xox[baprs]-[0-9A-Za-z-]{10,}      ; Slack tokens

## Values
- Ship the smallest thing.

## Mandate
- Help with engineering and ops work.

## Channel <#C0WORK|work>

### Mandate
- Work toward the goal on your own.

### Proactive
- Enabled: yes
`;

const SAM_SOUL = `# Persona

## Identity
- Name: Sam
- Role: personal assistant
- Voice: warm, brief.

## Values
- Act only with say-so.

## Mandate
- Help with day-to-day admin.

## Proactive
- Read: <#C0WORK|work>

## Channel <#C0SAM|sam-home>

### Mandate
- This is your home channel.

### Session
- Mode: channel

### Proactive
- Enabled: yes
`;

/** What the strict extraction would return for the two fixtures: sam names no ACLs of its own. */
const structure = (soul: string): SoulData =>
  soul === DEFAULT_SOUL
    ? SoulDataSchema.parse({
        identity: { name: "Trev", role: "personal engineering agent" },
        manager: { userId: "U0BOSS" },
        trustedChannels: ["C0HOME", "C0WORK"],
        approvers: [{ userId: "U0BOSS", scope: "anything", catchall: true }],
        redactPatterns: ["xox[baprs]-[0-9A-Za-z-]{10,}"],
        mandate: "Help with engineering and ops work.",
        channelOverrides: [{ channel: "C0WORK", approvers: [], mandate: "Work toward the goal on your own.", mandateMode: "override" }],
      })
    : SoulDataSchema.parse({
        identity: { name: "Sam", role: "personal assistant" },
        mandate: "Help with day-to-day admin.",
        channelOverrides: [{ channel: "C0SAM", approvers: [], mandate: "This is your home channel.", mandateMode: "override" }],
      });
const extract = async (soul: string) => structure(soul);

describe("migratePersona", () => {
  test("the default persona: file written, SOUL.md moved, loader reads the same structure", async () => {
    put("SOUL.md", DEFAULT_SOUL);
    const r = await migratePersona({ home, name: "default", extract });
    expect(r.file).toBe(join(home, "agent.yaml"));
    expect(existsSync(join(home, "SOUL.md"))).toBe(false);
    expect(existsSync(join(home, `SOUL.md${SOUL_BACKUP_SUFFIX}`))).toBe(true);
    const a = readFileAgent(home, "default")!;
    const want = structure(DEFAULT_SOUL);
    expect(a.soulJson.manager.userId).toBe("U0BOSS");
    expect(a.soulJson.trustedChannels).toEqual(want.trustedChannels);
    expect(a.soulJson.approvers).toEqual(want.approvers);
    expect(a.soulJson.mandate).toBe(want.mandate);
    expect(a.soulJson.channelOverrides).toEqual(want.channelOverrides);
    expect(parseProactive(a.soulMd).channels).toEqual({ C0WORK: true });
    expect(a.soulMd).toContain("Voice: terse, direct.");
  });

  test("a named persona gets the access it used to inherit written out, and its own proactive key", async () => {
    put("SOUL.md", DEFAULT_SOUL);
    put("personas/sam/SOUL.md", SAM_SOUL);
    put("personas/sam/config.json", JSON.stringify({ slackUserId: "U0SAM", userToken: "token-seam" }));
    await migratePersona({ home, name: "sam", extract });
    const a = readFileAgent(join(home, "personas/sam"), "sam")!;
    const inherited = withAclFallback(structure(SAM_SOUL), structure(DEFAULT_SOUL));
    expect(a.slackUserId).toBe("U0SAM");
    expect(a.soulJson.manager.userId).toBe("U0BOSS");
    expect(a.soulJson.trustedChannels).toEqual(inherited.trustedChannels);
    expect(a.soulJson.approvers).toEqual(inherited.approvers);
    expect(a.soulJson.channelOverrides).toEqual(inherited.channelOverrides);
    const p = parseProactive(a.soulMd);
    expect(p.read).toEqual(["C0WORK"]);
    expect(p.sessions).toEqual({ C0SAM: "channel" });
    expect(p.channels).toEqual({ C0SAM: true });
    // The token stays where it was; the file never holds it.
    expect(readFileSync(join(home, "personas/sam/agent.yaml"), "utf8")).not.toContain("token-seam");
    expect(readFileSync(join(home, "personas/sam/config.json"), "utf8")).toContain("token-seam");
  });

  test("with the default already migrated, the inheritance is read from its agent.yaml", async () => {
    put("SOUL.md", DEFAULT_SOUL);
    put("personas/sam/SOUL.md", SAM_SOUL);
    put("personas/sam/config.json", JSON.stringify({ slackUserId: "U0SAM" }));
    await migratePersona({ home, name: "default", extract });
    await migratePersona({ home, name: "sam", extract });
    const a = readFileAgent(join(home, "personas/sam"), "sam")!;
    expect(a.soulJson.trustedChannels).toEqual(["C0HOME", "C0WORK"]);
  });

  test("--out writes a copy and touches nothing else", async () => {
    put("SOUL.md", DEFAULT_SOUL);
    const out = mkdtempSync(join(tmpdir(), "migrate-out-"));
    const r = await migratePersona({ home, name: "default", extract, out });
    expect(r.file).toBe(join(out, "agent.yaml"));
    expect(existsSync(join(home, "SOUL.md"))).toBe(true);
    expect(r.soulMovedTo).toBeUndefined();
    rmSync(out, { recursive: true, force: true });
  });

  test("a second run refuses instead of overwriting", async () => {
    put("SOUL.md", DEFAULT_SOUL);
    await migratePersona({ home, name: "default", extract, keepSoul: true });
    await expect(migratePersona({ home, name: "default", extract })).rejects.toThrow(/already has an agent\.yaml/);
  });

  test("a soul that holds a secret is refused and nothing is written", async () => {
    put("SOUL.md", `${DEFAULT_SOUL}\n- note: ${"xo" + "xb"}-1234567890-abcdefghij\n`);
    const e = await migratePersona({ home, name: "default", extract }).catch((x) => x as Error);
    expect(e).toBeInstanceOf(PayloadError);
    expect(existsSync(join(home, "agent.yaml"))).toBe(false);
  });

  test("a named persona with no Slack user in config.json is refused", async () => {
    put("personas/sam/SOUL.md", SAM_SOUL);
    await expect(migratePersona({ home, name: "sam", extract })).rejects.toThrow(/no slackUserId/);
  });

  test("a difference between the structure and what the file compiles to stops it", async () => {
    put("SOUL.md", DEFAULT_SOUL);
    const lying = async (soul: string) => ({ ...structure(soul), redactPatterns: ["(unclosed"] });
    await expect(migratePersona({ home, name: "default", extract: lying })).rejects.toThrow(/regular expression|would not behave/);
    expect(existsSync(join(home, "agent.yaml"))).toBe(false);
  });

  test("a soul that sets Wake, Highest or Cooldown is refused, since the file would be looser", async () => {
    put("SOUL.md", `${DEFAULT_SOUL}\n## Proactive\n- Wake: no\n- Highest: inform\n- Read: <#C0WORK>\n`);
    const e = await migratePersona({ home, name: "default", extract }).catch((x) => x as Error);
    expect(e).toBeInstanceOf(PayloadError);
    expect(e.message).toContain("Wake, Highest");
    expect(existsSync(join(home, "agent.yaml"))).toBe(false);
    expect(existsSync(join(home, "SOUL.md"))).toBe(true);
  });

  test("--allow-loss migrates anyway and names what was not carried over", async () => {
    put("SOUL.md", `${DEFAULT_SOUL}\n## Proactive\n- Wake: no\n- Read: <#C0WORK>\n`);
    const r = await migratePersona({ home, name: "default", extract, allowLoss: true });
    expect(r.warnings.join("\n")).toContain("Wake not carried over");
  });

  test("a secret on a bullet line with a semicolon is still refused", async () => {
    put("SOUL.md", `${DEFAULT_SOUL}\n- note; ${"xo" + "xb"}-1234567890-abcdef\n`);
    await expect(migratePersona({ home, name: "default", extract })).rejects.toThrow(/shaped like a secret/);
  });

  test("a named persona with its own channel lists is told the trust classes change", async () => {
    put("SOUL.md", DEFAULT_SOUL);
    put("personas/sam/SOUL.md", SAM_SOUL);
    put("personas/sam/config.json", JSON.stringify({ slackUserId: "U0SAM" }));
    const own = async (soul: string) => (soul === SAM_SOUL ? { ...structure(soul), trustedChannels: ["C0SAM"] } : structure(soul));
    const r = await migratePersona({ home, name: "sam", extract: own });
    expect(r.warnings.join("\n")).toContain("review which channels count as trusted");
    expect(r.warnings.join("\n")).toContain("added at runtime with /soul");
  });

  test("the Proactive section stops where the parser stops: prose after a ### stays", async () => {
    put("SOUL.md", `${DEFAULT_SOUL}\n## Proactive\n- Read: <#C0WORK>\n### Notes\nKeep this line.\n`);
    await migratePersona({ home, name: "default", extract });
    expect(readFileAgent(home, "default")!.soulMd).toContain("Keep this line.");
  });
});
