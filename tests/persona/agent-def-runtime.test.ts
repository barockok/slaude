import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { paths } from "../../src/config/home";
import { AgentManager } from "../../src/agent/manager";
import { allowedSkillNames, homeSkillNamespace, isSkillAllowed, sdkSkillsOption } from "../../src/agent/skill-allow";
import { SkillGate } from "../../src/agent/skill-gate";
import { agentDefinitionView, redactedMcp } from "../../src/gateway/panel/definition-view";
import { attachedResolved, attachmentsOf } from "../../src/guardrails/attached";
import { definitionNeedsNode, hasCapability, AGENT_DEFINITION_CAPABILITY } from "../../src/guardrails/capability";
import { bundleSessionGuardrails } from "../../src/guardrails/node";
import { resolveDocs, appliesToAgent, withAgentAttachments, type GuardrailDoc } from "../../src/guardrails/resolve";
import { __resetPersonaRegistry, managedPersonaDefinition, setPersonaRegistry, skillsAllowedFor, type PersonaRegistry } from "../../src/persona/registry";
import { parseAgentYaml } from "../../src/persona/agent-def";
import type { Persona } from "../../src/persona/types";
import { allowedSkillsOf, discoverSkills } from "../../src/skills/loader";
import { makeSkillHandlers } from "../../src/skills/mcp-tools";
import { effectiveMandateIn, personaMandateText } from "../../src/soul/persona-mandates";
import { compiledPromptSoul, compiledSoulFor, soulDataFor } from "../../src/soul/per-persona";

const AGENT = `
name: ana
description: Support
slackUserId: UANA1
soul: You are Ana.
mandate:
  global: Answer support questions.
  scoped:
    - { boundary: "channel:COPS", mode: extend, text: "Also watch deploys." }
    - { boundary: "trust:trusted", mode: reduce, text: "No production changes." }
access:
  manager: UBOSS
  approvers: [{ user: UBOB, scope: budget, catchall: false }]
  channels:
    trusted: [CTEAM]
skills: [triage]
guardrails: [only-scout]
`;

function managed(persona: Persona, defaultDefinition: Persona["definition"] = null): PersonaRegistry {
  return {
    lookupByUserId: (id) => (id === persona.slackUserId ? persona : null),
    lookupByName: (n) => (n === persona.name ? persona : null),
    list: () => [persona],
    isMultiPersonaMode: () => true,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => ({ model: null, mcp: null, definition: defaultDefinition }),
  };
}

function compiledPersona(): Persona {
  const { spec } = parseAgentYaml("ana", AGENT);
  const { soulData, ...definition } = spec.definition;
  return {
    name: "ana", slackUserId: "UANA1", soulMd: spec.soul,
    config: { slackUserId: "UANA1", name: "ana", userToken: "user-token-live-secret" },
    outClient: null, model: null, runsOn: null, provider: { apiKey: "env://PERSONA_ANA_KEY" }, kbSources: ["kb-handbook"], background: null,
    mcp: { mcpServers: { tracker: { type: "http", url: "https://tracker.example.com/mcp/secret-path?key=live-secret", headers: { Authorization: "Bearer live-secret" } } } },
    soulJson: soulData,
    definition,
  };
}

beforeEach(() => __resetPersonaRegistry());
afterEach(() => __resetPersonaRegistry());

describe("every reader sees a compiled soul", () => {
  test("mandate text, classes and access come from the structure, not the prose", () => {
    setPersonaRegistry(managed(compiledPersona()));
    const compiled = compiledSoulFor("ana")!;
    expect(compiled.manager.userId).toBe("UBOSS");
    expect(soulDataFor("ana").approvers[0]!.userId).toBe("UBOB");
    const text = personaMandateText("ana");
    expect(text.global).toBe("Answer support questions.");
    expect(text.subMandates.map((s) => s.boundary)).toEqual(["channel:COPS", "trust:trusted"]);
    // The sub-mandates resolve through the one resolver, modes and classes included.
    expect(effectiveMandateIn(text, "COPS").applied?.mode).toBe("extend");
    expect(effectiveMandateIn(text, "CTEAM").applied?.boundary).toBe("trust:trusted");
    expect(effectiveMandateIn(text, "CTEAM").text).toContain("No production changes.");
  });

  test("compiledPromptSoul carries the channel lists that class a channel", () => {
    setPersonaRegistry(managed(compiledPersona()));
    expect(compiledPromptSoul("ana")?.trustedChannels).toEqual(["CTEAM"]);
    expect(compiledSoulFor("other")).toBeNull();
  });

  test("a persona without a definition keeps the text reading (compiledSoulFor is null)", () => {
    const p = { ...compiledPersona(), definition: null };
    setPersonaRegistry(managed(p));
    expect(compiledSoulFor("ana")).toBeNull();
  });

  test("definitions travel the registry; absent list means every skill", () => {
    const r = managed(compiledPersona(), { skills: ["x"] });
    expect(managedPersonaDefinition("ana", r)?.skills).toEqual(["triage"]);
    expect(managedPersonaDefinition(undefined, r)?.skills).toEqual(["x"]);
    expect(skillsAllowedFor("ana", r)).toEqual(["triage"]);
    expect(skillsAllowedFor("default", managed(compiledPersona(), {}))).toBeNull();
  });
});

describe("the prompt of a compiled soul", () => {
  const prompt = (channelId: string) => new AgentManager().__systemPromptForTests("s", "ana", { channelId });

  test("carries the global mandate in its own block and the soul stays prose", async () => {
    setPersonaRegistry(managed(compiledPersona()));
    const text = await prompt("CELSE");
    expect(text).toContain("<persona>\nYou are Ana.\n</persona>");
    expect(text).toContain("<mandate>\nAnswer support questions.\n</mandate>");
    expect(text).not.toContain("<channel-mandate>");
  });

  test("a scoped mandate reads through the one resolver: extend in a channel, reduce in a trust class", async () => {
    setPersonaRegistry(managed(compiledPersona()));
    expect(await prompt("COPS")).toContain("Additional mandate for this channel (in addition to the mandate above):\nAlso watch deploys.");
    expect(await prompt("CTEAM")).toContain("Limit for trusted channels");
  });

  test("a node takes the structure from its bundle; no definition adds no mandate block", async () => {
    const agent = new AgentManager();
    agent.setPersonaSoulResolver(async () => ({ soulMd: "Prose.", soulJson: { mandate: "M." }, definition: {} }));
    expect(await agent.__systemPromptForTests("s", "ana", { channelId: "C" })).toContain("<mandate>\nM.\n</mandate>");
    agent.setPersonaSoulResolver(async () => ({ soulMd: "Prose.", soulJson: { mandate: "M." } }));
    expect(await agent.__systemPromptForTests("s", "ana", { channelId: "C" })).not.toContain("<mandate>");
  });
});

describe("the skill list", () => {
  const home = homeSkillNamespace();
  const allowed = new Set(["triage"]);

  test("names outside the list are refused; built-ins and plugin skills are not limited", () => {
    expect(isSkillAllowed("triage", allowed)).toBe(true);
    expect(isSkillAllowed(`${home}:triage`, allowed)).toBe(true);
    expect(isSkillAllowed("other", allowed)).toBe(false);
    expect(isSkillAllowed(`${home}:other`, allowed)).toBe(false);
    expect(isSkillAllowed("slaude:memory", allowed)).toBe(true);
    expect(isSkillAllowed("some-plugin:pdf", allowed)).toBe(true);
    // A name in the built-in namespace that is not a built-in has no free pass.
    expect(isSkillAllowed("slaude:not-a-builtin", allowed)).toBe(false);
  });

  test("the gate denies the Skill tool outside the list and leaves other tools alone", async () => {
    const gate = new SkillGate();
    gate.reset("s");
    gate.markMounted("s", false);
    gate.setAllowedSkills("s", ["triage"]);
    const call = (tool_name: string, tool_input: unknown) =>
      gate.pre("s")({ hook_event_name: "PreToolUse", tool_name, tool_input } as never, undefined, { signal: new AbortController().signal });
    const denied = await call("Skill", { skill: "/other" }) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(denied.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(await call("Skill", { skill: "triage" })).toEqual({});
    expect(await call("Bash", { command: "ls" })).toEqual({});
    // A reboot clears the list: the boot sets it again.
    gate.reset("s");
    expect(await call("Skill", { skill: "other" })).toEqual({});
  });

  test("no list set: the gate does not look at Skill calls", async () => {
    const gate = new SkillGate();
    gate.reset("s");
    gate.markMounted("s", false);
    gate.setAllowedSkills("s", null);
    const r = await gate.pre("s")({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "anything" } } as never, undefined, { signal: new AbortController().signal });
    expect(r).toEqual({});
  });

  describe("with skills on disk", () => {
    const mk = (slug: string, name = slug) => {
      const dir = join(paths.skills, slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody of ${slug}\n`);
    };
    beforeEach(() => {
      rmSync(paths.skills, { recursive: true, force: true });
      mk("triage", "Triage Notes");
      mk("other");
    });
    afterEach(() => rmSync(paths.skills, { recursive: true, force: true }));

    test("the Skill tool also accepts a listed skill's frontmatter name", () => {
      expect(allowedSkillNames(["triage"], undefined).sort()).toEqual(["Triage-Notes", "triage"]);
    });

    test("the SDK listing names listed skills, built-ins and installed plugins' skills", () => {
      const plugin = join(paths.home, "plugin-a");
      mkdirSync(join(plugin, "skills", "pdf"), { recursive: true });
      writeFileSync(join(plugin, "skills", "pdf", "SKILL.md"), "---\nname: pdf\n---\nx");
      mkdirSync(join(plugin, "commands"), { recursive: true });
      writeFileSync(join(plugin, "commands", "go.md"), "x");
      const opt = sdkSkillsOption(["triage"], [plugin]);
      expect(opt).toContain("triage");
      expect(opt).toContain(`${homeSkillNamespace()}:triage`);
      expect(opt).toContain("slaude:memory");
      expect(opt).toContain("plugin-a:pdf");
      expect(opt).toContain("plugin-a:go");
      expect(opt).not.toContain("other");
      rmSync(plugin, { recursive: true, force: true });
    });

    test("the index filter: allowedSkillsOf and the skill tools honour the list", async () => {
      expect(allowedSkillsOf(discoverSkills(), ["triage"]).map((s) => s.slug)).toEqual(["triage"]);
      expect(allowedSkillsOf(discoverSkills(), null).length).toBe(2);
      setPersonaRegistry(managed(compiledPersona()));
      const h = makeSkillHandlers("ana");
      const list = await h.list_skills();
      expect(JSON.stringify(list)).toContain("/triage");
      expect(JSON.stringify(list)).not.toContain("/other");
      expect((await h.read_skill({ slug: "triage" })).isError).toBeFalsy();
      for (const r of [await h.read_skill({ slug: "other" }), await h.delete_skill({ slug: "other" }), await h.write_skill({ slug: "other", name: "o", description: "d", body: "b" })]) {
        expect(r.isError).toBe(true);
        expect(JSON.stringify(r)).toContain("not in this agent's skill list");
      }
      // Without a list every skill is served, as before.
      setPersonaRegistry(managed({ ...compiledPersona(), definition: {} }));
      expect(JSON.stringify(await makeSkillHandlers("ana").list_skills())).toContain("/other");
    });
  });
});

describe("attached guardrails are additive", () => {
  const doc = (slug: string, fm: string, enabled = true): GuardrailDoc => ({ slug, md: `---\nname: ${slug}\n${fm}\n---\n\`\`\`rules\n- id: r1\n  on: tool\n  match: { tool: WebFetch }\n  action: deny\n\`\`\`\nProse for ${slug}.`, source: "git", override: false, behindSource: false, enabled });
  const docs = [doc("only-scout", "scope: agents\nagents: [scout]"), doc("everyone", "scope: shared"), doc("off", "scope: agents\nagents: [scout]", false)];
  const resolved = resolveDocs(docs);

  test("adds the agent to a scoped guardrail and leaves the document and the others alone", () => {
    const out = withAgentAttachments(resolved, new Map([["only-scout", ["ana"]]]));
    expect(appliesToAgent(out[0]!, "ana")).toBe(true);
    expect(appliesToAgent(out[0]!, "scout")).toBe(true);
    expect(out[0]!.doc).toBe(resolved[0]!.doc);
    expect(out[0]!.doc.md).toBe(docs[0]!.md);
    expect(appliesToAgent(out[1]!, "ana")).toBe(true);
  });

  test("attachment never re-enables a disabled guardrail, nor narrows one", () => {
    const out = withAgentAttachments(resolved, new Map([["off", ["ana"]], ["everyone", ["ana"]]]));
    expect(appliesToAgent(out[2]!, "ana")).toBe(false);
    expect(appliesToAgent(out[1]!, "someone-else")).toBe(true);
  });

  test("attachedResolved reads every persona's list from the registry", () => {
    setPersonaRegistry(managed(compiledPersona(), { guardrails: ["only-scout"] }));
    expect(attachmentsOf().get("only-scout")?.sort()).toEqual(["ana", "default"]);
    const out = attachedResolved(resolved);
    expect(appliesToAgent(out[0]!, "ana")).toBe(true);
    expect(appliesToAgent(resolved[0]!, "ana")).toBe(false); // the snapshot's objects are untouched
  });

  test("a node applies the attached slugs from its bundle", () => {
    const withAttach = bundleSessionGuardrails({ version: 3, enforced: true, proseMax: 4000, docs: [docs[0]!], attached: ["only-scout"] }, "ana", null);
    expect(withAttach?.toolRules.map((h) => h.slug)).toEqual(["only-scout"]);
    const without = bundleSessionGuardrails({ version: 3, enforced: true, proseMax: 4000, docs: [docs[0]!] }, "ana", null);
    expect(without?.toolRules).toEqual([]);
  });

  test("a node needs the capability for any agent.yaml persona, and only those", () => {
    expect(definitionNeedsNode({ skills: [] })).toBe(true);
    expect(definitionNeedsNode({ guardrails: ["x"] })).toBe(true);
    // Its compiled mandate still needs a node that puts it in the prompt.
    expect(definitionNeedsNode({})).toBe(true);
    expect(definitionNeedsNode(null)).toBe(false);
    expect(hasCapability(`guardrails/1,${AGENT_DEFINITION_CAPABILITY}`, AGENT_DEFINITION_CAPABILITY)).toBe(true);
    expect(hasCapability("guardrails/1", AGENT_DEFINITION_CAPABILITY)).toBe(false);
  });
});

describe("the Definition view", () => {
  test("is the agent as one YAML document with no secret value in it", () => {
    setPersonaRegistry(managed(compiledPersona()));
    const v = agentDefinitionView("ana");
    expect(v.source).toBe("agent.yaml");
    const doc = parseYaml(v.yaml) as Record<string, any>;
    expect(doc.name).toBe("ana");
    expect(doc.mandate.global).toBe("Answer support questions.");
    expect(doc.access.manager).toBe("UBOSS");
    expect(doc.skills).toEqual(["triage"]);
    expect(doc.guardrails).toEqual(["only-scout"]);
    expect(doc.memory.kbSources).toEqual(["kb-handbook"]);
    expect(doc.userToken).toBe("<redacted>");
    expect(doc.mcp.mcpServers.tracker).toEqual({ type: "http", url: "https://tracker.example.com", headers: { Authorization: "<redacted>" } });
    expect(v.yaml).not.toContain("live-secret");
    expect(v.yaml).not.toContain("secret-path");
    expect(v.yaml).not.toContain("user-token-live-secret");
    expect(doc.provider.apiKey).toBe("env://PERSONA_ANA_KEY");
  });

  test("a stdio server's command and arguments are placeholders", () => {
    const out = redactedMcp({ mcpServers: { s: { command: "/bin/run --token=abc", args: ["--key", "abc"], env: { TOKEN: "abc" } } } }) as any;
    expect(JSON.stringify(out)).not.toContain("abc");
    expect(out.mcpServers.s).toEqual({ command: "<redacted>", args: "<redacted>", env: { TOKEN: "<redacted>" } });
  });
});
