import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../src/config/home";
import {
  __resetPersonaRegistry,
  getPersonaRegistry,
  loadPersonaRegistry,
  managedPersonaDefinition,
  refreshPersonaState,
  skillsAllowedFor,
} from "../../src/persona/registry";
import { personaSoulText } from "../../src/persona/soul-source";
import { compiledSoulFor, soulDataFor } from "../../src/soul/per-persona";
import { soulData } from "../../src/soul/extract";
import { channelSessionOn, proactiveRead } from "../../src/soul/proactive";

let root: string;
let prevHome: string;
let prevPersonas: string;

const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slaude-file-agent-"));
  prevHome = paths.home;
  prevPersonas = paths.personas;
  (paths as { home: string }).home = root;
  (paths as { personas: string }).personas = join(root, "personas");
  (paths as { soul: string }).soul = join(root, "SOUL.md");
  __resetPersonaRegistry();
});

afterEach(() => {
  (paths as { home: string }).home = prevHome;
  (paths as { personas: string }).personas = prevPersonas;
  (paths as { soul: string }).soul = join(prevHome, "SOUL.md");
  __resetPersonaRegistry();
  rmSync(root, { recursive: true, force: true });
});

const ANA = [
  "name: ana",
  "slackUserId: slack:user:U0ANA",
  "soul: |",
  "  You are Ana.",
  "access:",
  "  manager: slack:user:U0BOSS",
  "  channels:",
  "    trusted: [slack:channel:C0TEAM]",
  "skills: [triage]",
  "channels:",
  "  slack:channel:C0TEAM: { proactive: true }",
  "",
].join("\n");

describe("a persona directory with an agent.yaml", () => {
  test("loads with no SOUL.md and carries the compiled fields", () => {
    put(join(root, "personas/ana/agent.yaml"), ANA);
    const p = loadPersonaRegistry().lookupByName("ana")!;
    expect(p.slackUserId).toBe("U0ANA");
    expect(p.soulMd).toContain("You are Ana.");
    expect(p.definition).toEqual({ skills: ["triage"] });
    expect((p.soulJson as { manager: { userId: string } }).manager.userId).toBe("U0BOSS");
    expect(p.outClient).toBeNull();
  });

  test("the token and the id come from config.json when the file has none", () => {
    put(join(root, "personas/ana/agent.yaml"), "name: ana\nsoul: x\n");
    put(join(root, "personas/ana/config.json"), JSON.stringify({ slackUserId: "U0CFG", userToken: "tok-seam" }));
    const p = loadPersonaRegistry().lookupByName("ana")!;
    expect(p.slackUserId).toBe("U0CFG");
    expect(p.outClient).not.toBeNull();
  });

  test("no Slack user anywhere stops the load", () => {
    put(join(root, "personas/ana/agent.yaml"), "name: ana\nsoul: x\n");
    expect(() => loadPersonaRegistry()).toThrow(/no Slack user/);
  });

  test("a malformed file stops the load instead of skipping the persona", () => {
    put(join(root, "personas/ana/agent.yaml"), "name: ana\nsoul: x\nbogus: 1\n");
    expect(() => loadPersonaRegistry()).toThrow(/persona 'ana'/);
  });

  test("the readers see it as compiled: access is its own, soul text and proactive follow", async () => {
    put(join(root, "personas/ana/agent.yaml"), ANA);
    put(join(root, "SOUL.md"), "# Default\n\n## Trusted channels\n- <#C0DEFAULT>\n");
    await refreshPersonaState("default");
    expect(getPersonaRegistry().lookupByName("ana")).not.toBeNull();
    expect(personaSoulText("ana")).toContain("You are Ana.");
    expect(compiledSoulFor("ana")?.manager.userId).toBe("U0BOSS");
    expect(soulDataFor("ana").trustedChannels).toEqual(["C0TEAM"]);
    expect(managedPersonaDefinition("ana")).toEqual({ skills: ["triage"] });
    expect(skillsAllowedFor("ana")).toEqual(["triage"]);
    expect(channelSessionOn("ana", "C0TEAM")).toBe(true);
    expect(proactiveRead("ana")).toEqual(["C0TEAM"]);
  });

  test("a directory without one still reads SOUL.md as before", () => {
    put(join(root, "personas/old/SOUL.md"), "# Old\n");
    put(join(root, "personas/old/config.json"), JSON.stringify({ slackUserId: "U0OLD" }));
    const p = loadPersonaRegistry().lookupByName("old")!;
    expect(p.soulPath).toBeDefined();
    expect(p.definition).toBeUndefined();
    expect(managedPersonaDefinition("old")).toBeNull();
  });
});

describe("the default persona with $SLAUDE_HOME/agent.yaml", () => {
  const DEFAULT = [
    "name: default",
    "soul: |",
    "  You are the default.",
    "access:",
    "  manager: slack:user:U0BOSS",
    "  channels:",
    "    trusted: [slack:channel:C0HOME]",
    "proactive:",
    "  read: [slack:channel:C0HOME]",
    "channels:",
    "  slack:channel:C0HOME: { proactive: true }",
    "",
  ].join("\n");

  test("installs its soul text and structure with no model call", async () => {
    put(join(root, "agent.yaml"), DEFAULT);
    expect(await refreshPersonaState("default")).toBe(true);
    expect(personaSoulText()).toContain("You are the default.");
    expect(soulData().manager.userId).toBe("U0BOSS");
    expect(soulData().trustedChannels).toEqual(["C0HOME"]);
    expect(managedPersonaDefinition(undefined)).not.toBeNull();
    expect(compiledSoulFor("default")?.manager.userId).toBe("U0BOSS");
    expect(channelSessionOn("default", "C0HOME")).toBe(true);
    expect(getPersonaRegistry().isManaged()).toBe(false);
  });

  test("SOUL.md beside it is refused", () => {
    put(join(root, "agent.yaml"), DEFAULT);
    put(join(root, "SOUL.md"), "# old\n");
    expect(() => loadPersonaRegistry()).toThrow(/cannot sit beside SOUL\.md/);
  });

  test("without the file the default is read exactly as before", async () => {
    put(join(root, "SOUL.md"), "# Plain\n");
    await refreshPersonaState("default");
    expect(getPersonaRegistry().defaultPersona).toBeUndefined();
    expect(managedPersonaDefinition(undefined)).toBeNull();
    expect(compiledSoulFor("default")).toBeNull();
  });
});
