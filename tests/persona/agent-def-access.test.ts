import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { AgentManager } from "../../src/agent/manager";
import { SkillGate } from "../../src/agent/skill-gate";
import { admit } from "../../src/access/admission";
import { effectiveGrants } from "../../src/access/grants";
import { __setGrantsReader, approversFor, invalidateGrants, loadGrants } from "../../src/access/role";
import { paths } from "../../src/config/home";
import { agentDefinitionView } from "../../src/gateway/panel/definition-view";
import { ApprovalGate } from "../../src/gateway/slack/approval-gate";
import { channelTrustFor } from "../../src/knowledge/scope";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { __resetPersonaRegistry, __setPersonaStateLoader, refreshPersonaState, setPersonaRegistry, type PersonaRegistry } from "../../src/persona/registry";
import type { EffectivePersona } from "../../src/persona/effective";
import type { Persona } from "../../src/persona/types";
import { SoulDataSchema, type SoulData } from "../../src/soul/data";
import { setSoulData, soulData } from "../../src/soul/extract";
import { compiledSoulFor, soulDataFor, trustSoulFor } from "../../src/soul/per-persona";

const DEFAULT_SOUL: SoulData = SoulDataSchema.parse({
  manager: { userId: "UDEFMGR" },
  backupManager: { userId: "UDEFBAK" },
  approvers: [{ userId: "UDEFAPP", scope: "anything", catchall: true }],
  allowedChannels: ["CDEFPUB"],
  trustedChannels: ["CDEFTEAM"],
  dmAllowedUsers: ["UDEFDM"],
  blockedUsers: ["UBLOCKED"],
  channelOverrides: [{ channel: "CDEFTEAM", approvers: [{ userId: "UDEFCHAN", scope: "x", catchall: false }] }],
});

function persona(name: string, body: string): Persona {
  const { spec } = parseAgentYaml(name, `name: ${name}\nslackUserId: U${name.toUpperCase()}\nsoul: Prose.\n${body}`);
  const { soulData: compiled, ...definition } = spec.definition;
  return { name, slackUserId: `U${name.toUpperCase()}`, soulMd: spec.soul, config: { slackUserId: `U${name.toUpperCase()}`, name }, outClient: null, model: null, mcp: null, soulJson: compiled, definition };
}

function managed(personas: Persona[], defaults?: ReturnType<NonNullable<PersonaRegistry["defaultPersona"]>>): PersonaRegistry {
  const byName = new Map(personas.map((p) => [p.name, p]));
  return {
    lookupByUserId: () => null,
    lookupByName: (n) => byName.get(n) ?? null,
    list: () => personas,
    isMultiPersonaMode: () => true,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => defaults ?? { model: null, mcp: null },
  };
}

const soulMdPersona: Persona = { name: "legacy", slackUserId: "ULEGACY", soulMd: "Legacy prose.", config: { slackUserId: "ULEGACY", name: "legacy" }, outClient: null, soulJson: { approvers: [] } };

beforeEach(() => {
  __resetPersonaRegistry();
  __setGrantsReader(async () => []);
  setSoulData(DEFAULT_SOUL);
});
afterEach(() => {
  __setGrantsReader(null);
  invalidateGrants();
  __resetPersonaRegistry();
  if (existsSync(paths.soul)) rmSync(paths.soul);
});

describe("an agent.yaml persona inherits no access", () => {
  const empties = "access:\n  dm: []\n  approvers: []\n  channels: { public: [], trusted: [] }\n";

  test.each([["explicit empty lists", empties], ["a missing access key", ""]])("%s: exactly the file, nothing from the default", (_label, body) => {
    setPersonaRegistry(managed([persona("ana", body as string)]));
    const s = soulDataFor("ana");
    expect(s.manager.userId).toBeUndefined();
    expect(s.backupManager.userId).toBeUndefined();
    expect(s.approvers).toEqual([]);
    expect(s.channelOverrides).toEqual([]);
    expect(s.allowedChannels).toEqual([]);
    expect(s.trustedChannels).toEqual([]);
    expect(s.dmAllowedUsers).toEqual([]);
  });

  test("the default persona's blocked users still apply, added to the file's", () => {
    setPersonaRegistry(managed([persona("ana", "access:\n  blocked: [UOWNBLOCK]\n"), persona("bob", "")]));
    expect(soulDataFor("ana").blockedUsers.sort()).toEqual(["UBLOCKED", "UOWNBLOCK"]);
    expect(soulDataFor("bob").blockedUsers).toEqual(["UBLOCKED"]);
  });

  test("it answers only where it is listed: not the default's channels, not its DM list", () => {
    setPersonaRegistry(managed([persona("ana", "access:\n  channels: { trusted: [CMINE] }\n  dm: [UMYDM]\n")]));
    const grants = effectiveGrants("ana", []);
    const canTalk = (userId: string, channelId: string, isDM: boolean) => admit({ grants, userId, channelId, isDM }).ok;
    expect(canTalk("USOMEONE", "CMINE", false)).toBe(true);
    expect(canTalk("USOMEONE", "CDEFPUB", false)).toBe(false);
    expect(canTalk("USOMEONE", "CDEFTEAM", false)).toBe(false);
    expect(canTalk("USOMEONE", "COTHER", false)).toBe(false);
    expect(canTalk("UMYDM", "DX", true)).toBe(true);
    expect(canTalk("UDEFDM", "DX", true)).toBe(false);
    expect(canTalk("UDEFMGR", "DX", true)).toBe(false);
    expect(canTalk("UBLOCKED", "CMINE", false)).toBe(false);
  });

  test("with no access key it answers nobody, and nobody can approve", async () => {
    setPersonaRegistry(managed([persona("ana", "")]));
    const grants = await loadGrants("ana");
    expect(admit({ grants, userId: "UDEFMGR", channelId: "CDEFPUB", isDM: false }).ok).toBe(false);
    expect(admit({ grants, userId: "UDEFMGR", channelId: "DX", isDM: true }).ok).toBe(false);
    expect(await approversFor("ana")).toEqual([]);
  });

  test("its own approvers and managers approve; the default's managers do not", async () => {
    setPersonaRegistry(managed([persona("ana", "access:\n  manager: UANAMGR\n  approvers: [{ user: UANAAPP }]\n")]));
    expect((await approversFor("ana")).sort()).toEqual(["UANAAPP", "UANAMGR"]);
  });

  test("a stored structure that does not parse is no access, never the default's", () => {
    setPersonaRegistry(managed([{ ...persona("ana", ""), soulJson: { manager: "not-an-object" } }]));
    const s = soulDataFor("ana");
    expect(s.manager.userId).toBeUndefined();
    expect(s.trustedChannels).toEqual([]);
    expect(s.blockedUsers).toEqual(["UBLOCKED"]);
  });

  test("a SOUL.md persona keeps inheriting exactly as before", async () => {
    setPersonaRegistry(managed([soulMdPersona]));
    const s = soulDataFor("legacy");
    expect(s.manager.userId).toBe("UDEFMGR");
    expect(s.trustedChannels).toEqual(["CDEFTEAM"]);
    expect(s.dmAllowedUsers).toEqual(["UDEFDM"]);
    expect((await approversFor("legacy")).length).toBeGreaterThan(0);
  });
});

describe("KB scope, the trust envelope and the decision gate read the persona's own channels", () => {
  test("an agent.yaml persona's lists class the channel; the default's do not", () => {
    setPersonaRegistry(managed([persona("ana", "access:\n  channels: { trusted: [CMINE] }\n"), soulMdPersona]));
    expect(channelTrustFor("CMINE", trustSoulFor("ana"))).toBe(channelTrustFor("CDEFTEAM", soulData()));
    expect(trustSoulFor("ana").trustedChannels).toEqual(["CMINE"]);
    expect(trustSoulFor("ana").allowedChannels).toEqual([]);
  });

  test("a SOUL.md persona and the default persona read the default soul, unchanged", () => {
    setPersonaRegistry(managed([soulMdPersona]));
    expect(trustSoulFor("legacy")).toBe(soulData());
    expect(trustSoulFor(undefined)).toBe(soulData());
    expect(trustSoulFor("default")).toBe(soulData());
  });
});

describe("the Definition view's sensitive values", () => {
  const fakeKey = () => `sk-${"a".repeat(30)}`;
  const body = () => `description: "uses ${fakeKey()}"\naccess:\n  redact: ["project-[a-z]+", "customer-x"]\n  approvers: [{ user: UAPP, scope: "rotate ${fakeKey()}" }]\n`;

  test("an operator sees a count of redaction patterns, a superadmin the patterns", () => {
    setPersonaRegistry(managed([persona("ana", body())]));
    const operator = agentDefinitionView("ana");
    expect((parseYaml(operator.yaml) as any).access.redact).toBe("2 patterns");
    expect(operator.yaml).not.toContain("project-[a-z]+");
    expect(operator.yaml).not.toContain("customer-x");
    const superadmin = agentDefinitionView("ana", undefined, { canSeeValues: true });
    expect((parseYaml(superadmin.yaml) as any).access.redact).toEqual(["project-[a-z]+", "customer-x"]);
  });

  test("description and approver scope go through the secret filter", () => {
    setPersonaRegistry(managed([persona("ana", body())]));
    const v = agentDefinitionView("ana", undefined, { canSeeValues: true });
    expect(v.yaml).not.toContain(fakeKey());
    expect(() => parseYaml(v.yaml)).not.toThrow();
  });
});

describe("a boot with a broken definition", () => {
  const prompt = (name: string) => new AgentManager().__systemPromptForTests("s", name, { channelId: "C" });

  test("a named persona's unparsable structure fails the boot", async () => {
    setPersonaRegistry(managed([{ ...persona("ana", "skills: [a]\n"), soulJson: { manager: "bad" } }]));
    await expect(prompt("ana")).rejects.toThrow(/defined by agent\.yaml but its stored structure does not parse/);
  });

  test("the node path refuses it too", async () => {
    const agent = new AgentManager();
    agent.setPersonaSoulResolver(async () => ({ soulMd: "x", soulJson: { manager: "bad" }, definition: { skills: [] } }));
    await expect(agent.__systemPromptForTests("s", "ana", {})).rejects.toThrow(/does not parse/);
  });

  test("a SOUL.md persona is not affected by the check", async () => {
    setPersonaRegistry(managed([soulMdPersona]));
    expect(await prompt("legacy")).toContain("Legacy prose.");
  });

  function defaultRow(soulJson: unknown): EffectivePersona {
    return { name: "default", slackUserId: null, userToken: null, model: null, soulMd: "Default prose.", soulJson, mcp: null, definition: {}, origin: "git", tombstonedAt: null, overridden: [] };
  }

  test("the default persona: an unparsable row fails the boot and leaves no access, not the disk soul's", async () => {
    const row = defaultRow({ manager: "bad" });
    __setPersonaStateLoader(async () => ({
      registry: managed([], { model: null, mcp: null, definition: {}, soulJson: row.soulJson }),
      managed: { defaultPersona: row },
    }));
    await refreshPersonaState("default");
    expect(soulData().manager.userId).toBeUndefined();
    expect(compiledSoulFor(undefined)).toBeNull();
    await expect(new AgentManager().__systemPromptForTests("s", undefined, {})).rejects.toThrow(/does not parse/);
  });
});

describe("a sync reaches a warm session's skill list", () => {
  const opts = { signal: new AbortController().signal };
  const skill = (name: string) => ({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: name } }) as never;
  const denied = (r: unknown) => (r as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === "deny";

  function booted(read: () => Promise<readonly string[] | null>, initial: readonly string[] | null) {
    const gate = new SkillGate();
    gate.reset("s");
    gate.markMounted("s", false);
    gate.setSkillListSource("s", { read, initial, mounted: new Set() });
    return gate;
  }

  test("the gate reads the current list on every Skill call", async () => {
    let list: string[] | null = ["a"];
    const gate = booted(async () => list, ["a"]);
    expect(denied(await gate.pre("s")(skill("b"), undefined, opts))).toBe(true);
    list = ["a", "b"];
    expect(denied(await gate.pre("s")(skill("b"), undefined, opts))).toBe(false);
    list = ["a"];
    expect(denied(await gate.pre("s")(skill("b"), undefined, opts))).toBe(true);
    list = null;
    expect(denied(await gate.pre("s")(skill("b"), undefined, opts))).toBe(false);
  });

  test("a persona that gains a list mid-session is limited from the next call", async () => {
    let list: string[] | null = null;
    const gate = booted(async () => list, null);
    expect(denied(await gate.pre("s")(skill("b"), undefined, opts))).toBe(false);
    list = ["a"];
    expect(denied(await gate.pre("s")(skill("b"), undefined, opts))).toBe(true);
  });

  test("a failed read keeps the last list, it does not open up", async () => {
    let fail = false;
    const gate = booted(async () => {
      if (fail) throw new Error("gateway away");
      return ["a"];
    }, ["a"]);
    expect(denied(await gate.pre("s")(skill("a"), undefined, opts))).toBe(false);
    fail = true;
    expect(denied(await gate.pre("s")(skill("b"), undefined, opts))).toBe(true);
    expect(denied(await gate.pre("s")(skill("a"), undefined, opts))).toBe(false);
  });

  test("other tools never read the list", async () => {
    let reads = 0;
    const gate = booted(async () => { reads++; return ["a"]; }, ["a"]);
    await gate.pre("s")({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} } as never, undefined, opts);
    expect(reads).toBe(0);
  });
});

describe("a default-persona agent.yaml and the on-disk SOUL.md", () => {
  const request = { summary: "ship the release", category: "deploy" } as never;
  const disk = "# Persona\n\n## Approvers\n- <@UDISKAPP>: anything\n\n```approvers\n{\"default\": [\"UDISKLEGACY\"]}\n```\n";
  const gate = (env: string[] = ["UENV"]) => {
    const app = { action: () => {}, client: {} } as never;
    return new ApprovalGate(app, env);
  };

  test("no approvers in the file: its managers, and never the disk file or the env list", async () => {
    writeFileSync(paths.soul, disk);
    setSoulData(SoulDataSchema.parse({ manager: { userId: "UOWNMGR" } }));
    setPersonaRegistry(managed([], { model: null, mcp: null, definition: {} }));
    expect(await gate().approversFor(request)).toEqual(["UOWNMGR"]);
  });

  test("no approver and no manager: nobody may approve, not anyone", async () => {
    writeFileSync(paths.soul, disk);
    setSoulData(SoulDataSchema.parse({}));
    setPersonaRegistry(managed([], { model: null, mcp: null, definition: {} }));
    // The sentinel is filtered from this list; tests/approval-gate.test.ts checks the card.
    expect(await gate().approversFor(request)).toEqual([]);
  });

  test("a default persona without an agent.yaml still reads the disk file", async () => {
    writeFileSync(paths.soul, disk);
    setSoulData(SoulDataSchema.parse({}));
    setPersonaRegistry(managed([]));
    expect(await gate().approversFor(request)).toContain("UDISKAPP");
  });
});
