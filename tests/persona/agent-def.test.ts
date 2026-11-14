import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDir } from "../../src/cli/personas";
import { channelSettings, compiledChannelSections, parseAgentYaml } from "../../src/persona/agent-def";
import { PayloadError, payloadVersionFor } from "../../src/persona/sync/payload";
import { SoulDataSchema } from "../../src/soul/data";
import { subMandatesOf } from "../../src/soul/mandate-scope";
import { __setProactiveSoulSource, channelSessionOn, channelSessionWakes, endsInOpenFence, parseProactive } from "../../src/soul/proactive";
import { sameDesired, type DesiredPersona } from "../../src/persona/effective";

const FULL = `
name: ana
description: Handles support questions
model: provider/model-name
slackUserId: UANA1
userToken: "\${PERSONA_ANA_XOXP}"
runsOn: finance
provider:
  apiKey: env://PERSONA_ANA_KEY
soul: |
  You are Ana. Plain, kind, brief.
mandate:
  global: Answer support questions.
  scoped:
    - { boundary: "channel:COPS", mode: extend, text: "Also watch the deploy queue." }
    - { boundary: "trust:public", mode: reduce, text: "Share nothing internal." }
    - { boundary: dm, text: "Handle account requests." }
access:
  manager: UBOSS
  backupManager: UDEP
  approvers:
    - { user: UBOB, scope: "budget changes", catchall: false }
    - { user: UEVE, channel: COPS }
  channels:
    public: [CPUB]
    trusted: [CTEAM]
  dm: [UFRIEND]
  blocked: [UNOISY]
  redact: ["sk-[a-z]+"]
  approvalTimeoutSeconds: 120
mcp:
  mcpServers:
    tracker:
      type: http
      url: https://tracker.example.com/mcp
      headers:
        Authorization: "\${PERSONA_ANA_TRACKER}"
skills: [release-notes, triage]
guardrails: [no-outbound-email]
memory:
  kbSources: [kb-handbook]
  background:
    budgetUsd: 2
    timezone: UTC
`;

const meta = { revision: "r1", committedAt: "2026-10-01T10:00:00Z" };
const tmp = () => mkdtempSync(join(tmpdir(), "slaude-agent-"));

function repo(personas: Record<string, Record<string, string>>): string {
  const dir = tmp();
  for (const [name, files] of Object.entries(personas)) {
    mkdirSync(join(dir, "personas", name), { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, "personas", name, f), body);
  }
  return dir;
}
const def = (extra = "") => `name: default\nsoul: You are the default agent.\n${extra}`;

function err(f: () => unknown): PayloadError {
  try {
    f();
  } catch (e) {
    return e as PayloadError;
  }
  throw new Error("expected a throw");
}

describe("parseAgentYaml", () => {
  test("a full file compiles to the payload's fields", () => {
    const c = parseAgentYaml("ana", FULL);
    expect(c.spec).toMatchObject({
      name: "ana", slackUserId: "UANA1", userToken: "${PERSONA_ANA_XOXP}", model: "provider/model-name",
      runsOn: "finance", provider: { apiKey: "env://PERSONA_ANA_KEY" }, kbSources: ["kb-handbook"], background: { budgetUsd: 2, timezone: "UTC" },
    });
    expect(c.spec.soul).toBe("You are Ana. Plain, kind, brief.\n");
    expect(c.spec.definition.skills).toEqual(["release-notes", "triage"]);
    expect(c.spec.definition.guardrails).toEqual(["no-outbound-email"]);
  });

  test("the structured parts build SoulData the runtime reads, with no extraction", () => {
    const s = parseAgentYaml("ana", FULL).spec.definition.soulData;
    expect(SoulDataSchema.parse(s)).toEqual(s);
    expect(s.manager.userId).toBe("UBOSS");
    expect(s.backupManager.userId).toBe("UDEP");
    expect(s.approvers).toEqual([{ userId: "UBOB", scope: "budget changes", catchall: false }]);
    expect(s.allowedChannels).toEqual(["CPUB"]);
    expect(s.trustedChannels).toEqual(["CTEAM"]);
    expect(s.dmAllowedUsers).toEqual(["UFRIEND"]);
    expect(s.blockedUsers).toEqual(["UNOISY"]);
    expect(s.redactPatterns).toEqual(["sk-[a-z]+"]);
    expect(s.approvalTimeoutSeconds).toBe(120);
    expect(s.mandate).toBe("Answer support questions.");
    expect(s.identity).toEqual({ name: "ana", role: "Handles support questions" });
    // A channel's sub-mandate and an approver limited to that channel share its block.
    expect(s.channelOverrides).toEqual([{ channel: "COPS", mandate: "Also watch the deploy queue.", mandateMode: "extend", approvers: [{ userId: "UEVE", scope: "anything", catchall: true }] }]);
    expect(subMandatesOf(s).map((m) => [m.boundary, m.mode])).toEqual([["channel:COPS", "extend"], ["trust:public", "reduce"], ["dm", "override"]]);
  });

  test("compiles the same file to the same structure every time", () => {
    expect(parseAgentYaml("ana", FULL).spec.definition.soulData).toEqual(parseAgentYaml("ana", FULL).spec.definition.soulData);
  });

  test("a minimal file: name and soul only; skills absent means no list", () => {
    const c = parseAgentYaml("default", def());
    expect(c.spec.definition.skills).toBeUndefined();
    expect(c.spec.definition.guardrails).toBeUndefined();
    expect(c.spec.definition.soulData.mandate).toBeUndefined();
  });

  test("an empty skills list is a list of nothing, kept distinct from absent", () => {
    expect(parseAgentYaml("default", def("skills: []\n")).spec.definition.skills).toEqual([]);
  });

  test("an unknown key fails the sync, naming the persona and key", () => {
    for (const [extra, key] of [["plugins: [a]\n", "plugins"], ["access:\n  foo: 1\n", "access.foo"], ["mandate:\n  bar: 2\n", "mandate.bar"], ["access:\n  channels:\n    privat: [CA]\n", "access.channels.privat"], ["memory:\n  kb: []\n", "memory.kb"], ["access:\n  approvers:\n    - { user: UBOB, sope: x }\n", "access.approvers[0].sope"], ["mandate:\n  scoped:\n    - { boundary: dm, text: t, x: 1 }\n", "mandate.scoped[0].x"]] as const) {
      const e = err(() => parseAgentYaml("default", def(extra)));
      expect(e).toBeInstanceOf(PayloadError);
      expect(e.message).toBe(`persona 'default': agent.yaml ${key} is not a known key`);
    }
  });

  test("a duplicate key is refused, with no source text in the message", () => {
    const e = err(() => parseAgentYaml("default", "name: default\nsoul: x\nmodel: first-secret\nmodel: second-secret\n"));
    expect(e).toBeInstanceOf(PayloadError);
    expect(e.message).toContain("DUPLICATE_KEY");
    expect(e.message).toContain("line 4");
    expect(e.message).not.toContain("secret");
  });

  test("a bare skills: or memory.kbSources: fails rather than widen; absent and [] stay distinct", () => {
    expect(err(() => parseAgentYaml("default", def("skills:\n"))).message).toContain("agent.yaml skills has no value");
    expect(err(() => parseAgentYaml("default", def("memory:\n  kbSources:\n"))).message).toContain("agent.yaml memory.kbSources has no value");
    expect(parseAgentYaml("default", def()).spec.definition.skills).toBeUndefined();
    expect(parseAgentYaml("default", def()).spec.kbSources).toBeUndefined();
    expect(parseAgentYaml("default", def("skills: []\nmemory:\n  kbSources: []\n")).spec.kbSources).toEqual([]);
  });

  test("a soul that still carries a structured section gets a warning", () => {
    const c = parseAgentYaml("default", `name: default\nsoul: |\n  ## Identity\n  x\n  ## Manager\n  y\n`);
    expect(c.warnings).toEqual([expect.stringContaining("'## Manager'")]);
    expect(parseAgentYaml("default", def()).warnings).toEqual([]);
  });

  test("an unknown mode reads as extend and warns, as a soul's Mode line does; case is ignored", () => {
    const mandateOf = (mode: string) => `name: default\nsoul: x\nmandate:\n  scoped:\n    - { boundary: dm, mode: ${mode}, text: t }\n`;
    const typo = parseAgentYaml("default", mandateOf("maybe"));
    expect(subMandatesOf(typo.spec.definition.soulData)[0]!.mode).toBe("extend");
    expect(typo.warnings).toEqual([expect.stringContaining("mandate.scoped[0].mode")]);
    expect(typo.warnings[0]).not.toContain("maybe");
    const upper = parseAgentYaml("default", mandateOf("Reduce"));
    expect(subMandatesOf(upper.spec.definition.soulData)[0]!.mode).toBe("reduce");
    expect(upper.warnings).toEqual([]);
  });

  // One row per error case: the message names the persona and the key.
  const BAD: Array<[string, string, RegExp]> = [
    ["invalid YAML", "name: [", /persona 'ana': agent\.yaml is not valid YAML/],
    ["not a mapping", "- a\n- b\n", /persona 'ana': agent\.yaml  must be a mapping/],
    ["name differs from the directory", "name: bob\nsoul: x\n", /agent\.yaml name must equal the directory name 'ana'/],
    ["no soul", "name: ana\n", /agent\.yaml soul must be/],
    ["description not a string", "name: ana\nsoul: x\ndescription: [a]\n", /agent\.yaml description must be a string/],
    ["bad mandate boundary", "name: ana\nsoul: x\nmandate:\n  scoped:\n    - { boundary: nope, text: t }\n", /mandate\.scoped\[0\]\.boundary/],
    ["missing mandate text", "name: ana\nsoul: x\nmandate:\n  scoped:\n    - { boundary: dm }\n", /mandate\.scoped\[0\]\.text/],
    ["repeated boundary", "name: ana\nsoul: x\nmandate:\n  scoped:\n    - { boundary: dm, text: a }\n    - { boundary: dm, text: b }\n", /repeats an earlier boundary/],
    ["bad manager id", "name: ana\nsoul: x\naccess:\n  manager: alice\n", /access\.manager must be a user reference/],
    ["bad approver user", "name: ana\nsoul: x\naccess:\n  approvers:\n    - { user: bob }\n", /access\.approvers\[0\]\.user/],
    ["missing approver user", "name: ana\nsoul: x\naccess:\n  approvers:\n    - { scope: x }\n", /access\.approvers\[0\]\.user is required/],
    ["bad catchall", "name: ana\nsoul: x\naccess:\n  approvers:\n    - { user: UBOB, catchall: maybe }\n", /access\.approvers\[0\]\.catchall/],
    ["bad channel id", "name: ana\nsoul: x\naccess:\n  channels:\n    public: [general]\n", /access\.channels\.public\[0\]/],
    ["dm is not a list", "name: ana\nsoul: x\naccess:\n  dm: UBOB\n", /access\.dm must be a list/],
    ["bad redact regex", "name: ana\nsoul: x\naccess:\n  redact: ['(']\n", /access\.redact\[0\] is not a valid regular expression/],
    ["skills not a list", "name: ana\nsoul: x\nskills: triage\n", /skills must be a list/],
    ["bad skill slug", "name: ana\nsoul: x\nskills: ['Not A Slug']\n", /skills\[0\] must be a slug/],
    ["repeated skill", "name: ana\nsoul: x\nskills: [a, a]\n", /skills\[1\] repeats/],
    ["bad guardrail slug", "name: ana\nsoul: x\nguardrails: ['Bad Slug']\n", /guardrails\[0\] must be a slug/],
    ["memory.kbSources not a list", "name: ana\nsoul: x\nmemory:\n  kbSources: kb-a\n", /memory\.kbSources must be a list/],
    ["mcp not a mapping", "name: ana\nsoul: x\nmcp: [a]\n", /agent\.yaml mcp must be a mapping/],
  ];
  for (const [label, text, re] of BAD) {
    test(`refused: ${label}`, () => {
      const e = err(() => parseAgentYaml("ana", text));
      expect(e).toBeInstanceOf(PayloadError);
      expect(e.message).toMatch(re);
    });
  }

  test("an error never echoes a value", () => {
    const e = err(() => parseAgentYaml("ana", "name: ana\nsoul: x\nmodel: [secret-looking-value]\n"));
    expect(e.message).not.toContain("secret-looking-value");
  });
});

describe("parseAgentYaml channels", () => {
  const compile = (extra: string) => parseAgentYaml("default", def(extra));

  test("channels compile to the soul block the parser reads", () => {
    const { spec } = compile("channels:\n  C0EXAMPLE:\n    session: channel\n    proactive: true\n");
    const c = parseProactive(spec.soul);
    expect(c.sessions).toEqual({ C0EXAMPLE: "channel" });
    expect(c.channels).toEqual({ C0EXAMPLE: true });
    expect(spec.soul.startsWith("You are the default agent.")).toBe(true);
  });

  test("proactive: true alone is a channel session, and the keys round trip as written", () => {
    const { spec } = compile("channels:\n  C0EXAMPLE:\n    proactive: true\n");
    const c = parseProactive(spec.soul);
    expect(c.sessions).toEqual({});
    expect(c.channels).toEqual({ C0EXAMPLE: true });
    __setProactiveSoulSource(() => spec.soul);
    expect(channelSessionOn("a", "C0EXAMPLE")).toBe(true);
    expect(channelSessionWakes("a")).toEqual(["C0EXAMPLE"]);
    expect(channelSettings(spec.soul)).toEqual({ C0EXAMPLE: { proactive: true } });
    __setProactiveSoulSource(null);
  });

  test("an invalid Mode exports as off, so importing it cannot turn the channel on", () => {
    const soul = "Prose.\n\n## Channel <#CBAD>\n### Session\n- Mode: thread\n### Proactive\n- Enabled: yes\n";
    expect(channelSettings(soul)).toEqual({ CBAD: { proactive: false } });
    const { spec } = compile(`channels:\n  CBAD:\n    proactive: false\n`);
    expect(parseProactive(spec.soul).channels).toEqual({ CBAD: false });
  });

  test("proactive: false compiles to Enabled: no", () => {
    const { spec } = compile("channels:\n  C0EXAMPLE:\n    proactive: false\n");
    expect(spec.soul).toContain("- Enabled: no");
    expect(parseProactive(spec.soul).channels).toEqual({ C0EXAMPLE: false });
  });

  test.each([["session: thread"], ["proactive: maybe"], ["other: 1"]])("refuses %s", (line) => {
    expect(err(() => compile(`channels:\n  C0EXAMPLE:\n    ${line}\n`)).message).toContain("channels.C0EXAMPLE");
  });

  test("refuses a key that is not a channel id", () => {
    expect(err(() => compile("channels:\n  general:\n    session: channel\n")).message).toContain("must be a channel reference");
  });

  test("a channels block does not warn about a structured soul section", () => {
    expect(compile("channels:\n  slack:channel:C0EXAMPLE:\n    session: channel\n").warnings).toEqual([]);
  });

  test("a persona with no channels key keeps its soul unchanged", () => {
    expect(compile("").spec.soul).toBe("You are the default agent.");
  });

  test("an entry with no settings emits no heading", () => {
    expect(compile("channels:\n  C0EXAMPLE: {}\n").spec.soul).toBe("You are the default agent.");
    expect(compile("channels:\n  C0EXAMPLE:\n").spec.soul).toBe("You are the default agent.");
  });

  test.each([["session"], ["proactive"]])("refuses a bare %s", (key) => {
    expect(err(() => compile(`channels:\n  C0EXAMPLE:\n    ${key}:\n`)).message).toContain(`channels.C0EXAMPLE.${key} has no value`);
  });

  test("errors name the key and omit the bad value", () => {
    for (const line of ["session: not-a-mode-value", "proactive: not-a-mode-value"]) {
      expect(err(() => compile(`channels:\n  C0EXAMPLE:\n    ${line}\n`)).message).not.toContain("not-a-mode-value");
    }
    const badKey = err(() => compile(`channels:\n  "not a channel secretvalue":\n    session: channel\n`)).message;
    expect(badKey).not.toContain("secretvalue");
    expect(badKey).toContain("must be a channel reference");
  });

  test("a soul ending in an open code fence fails when channels has settings", () => {
    const open = "name: default\nsoul: |\n  Prose.\n  \`\`\`\n  sample\n";
    expect(err(() => parseAgentYaml("default", `${open}channels:\n  C0EXAMPLE:\n    session: channel\n`)).message).toContain("soul");
    expect(parseAgentYaml("default", `${open}channels:\n  C0EXAMPLE: {}\n`).spec.soul).toContain("sample");
    expect(parseAgentYaml("default", open).spec.soul).toContain("sample");
  });

  test("a soul with its own section for a listed channel fails, naming only the channel id", () => {
    const yaml = "name: default\nsoul: |\n  Prose.\n\n  ## Channel <#C0EXAMPLE|private-name>\n  ### Mandate\n  Watch.\nchannels:\n  C0EXAMPLE:\n    session: channel\n";
    const message = err(() => parseAgentYaml("default", yaml)).message;
    expect(message).toContain("channels.C0EXAMPLE");
    expect(message).not.toContain("private-name");
    expect(message).not.toContain("Watch");
  });

  test("a fenced section, or a section for another channel, is not a clash", () => {
    const fenced = "name: default\nsoul: |\n  \`\`\`\n  ## Channel <#C0EXAMPLE>\n  \`\`\`\n  ## Channel <#COTHER>\n  ### Mandate\n  Watch.\nchannels:\n  C0EXAMPLE:\n    session: channel\n";
    expect(parseProactive(parseAgentYaml("default", fenced).spec.soul).sessions).toEqual({ C0EXAMPLE: "channel" });
  });

  test("compiling the same file twice leaves the stored persona unchanged", () => {
    const row = (text: string): DesiredPersona => {
      const { spec } = parseAgentYaml("default", text);
      const { soulData, ...definition } = spec.definition;
      return { name: "default", slackUserId: null, userToken: null, model: null, soulMd: spec.soul, soulJson: soulData, mcp: null, origin: "git", tombstonedAt: null, definition } as DesiredPersona;
    };
    const on = def("channels:\n  C0EXAMPLE:\n    session: channel\n    proactive: true\n");
    expect(sameDesired(row(on), JSON.parse(JSON.stringify(row(on))))).toBe(true);
    expect(sameDesired(row(on), row(def("channels:\n  C0EXAMPLE:\n    session: channel\n    proactive: false\n")))).toBe(false);
  });
});

describe("channelSettings", () => {
  test("reads only the keys a channel sets", () => {
    const soul = "Prose.\n\n## Channel <#CONE>\n### Session\n- Mode: channel\n\n## Channel <#CTWO|two>\n### Proactive\n- Enabled: no\n";
    expect(channelSettings(soul)).toEqual({ CONE: { session: "channel" }, CTWO: { proactive: false } });
  });

  test("a soul with no channel settings has none, and a block with only a mandate adds none", () => {
    expect(channelSettings("Prose.\n\n## Channel <#CONE>\n### Mandate\nWatch.\n")).toEqual({});
  });
});

describe("compiledChannelSections", () => {
  const compiled = "Prose.\n\n## Channel <#CONE>\n### Session\n- Mode: channel\n\n## Channel <#CTWO>\n### Proactive\n- Enabled: yes";

  test("returns the sections the edited text lacks, without the prose", () => {
    const kept = compiledChannelSections(compiled, "New prose.");
    expect(kept).toBe("\n\n## Channel <#CONE>\n### Session\n- Mode: channel\n\n## Channel <#CTWO>\n### Proactive\n- Enabled: yes");
    expect(parseProactive(`New prose.${kept}`).sessions).toEqual({ CONE: "channel" });
  });

  test("leaves a channel the edited text already has to that text", () => {
    const edited = "New prose.\n\n## Channel <#CTWO|two>\n### Proactive\n- Enabled: no";
    expect(compiledChannelSections(compiled, edited)).toBe("\n\n## Channel <#CONE>\n### Session\n- Mode: channel");
  });

  test("an authored section is not kept, so an edit can remove it", () => {
    const authored = [
      "## Channel <#CONE>\n### Mandate\nWatch.",
      "## Channel <#CONE|one>\n### Session\n- Mode: channel",
      "## Channel <#CONE>\n### Session\n- Mode: channel\nand a note",
      "## Channel <#CONE>\n### Proactive\n- Enabled: yes\n- Highest: ask",
      "## Channel <#CONE>",
    ];
    for (const section of authored) expect(compiledChannelSections(`Prose.\n\n${section}`, "New prose.")).toBe("");
  });

  test("re-saving the kept text does not grow it", () => {
    const once = `New prose.${compiledChannelSections(compiled, "New prose.")}`;
    expect(compiledChannelSections(compiled, once)).toBe("");
  });

  test("is empty when the soul has no channel sections, and ignores a fenced heading", () => {
    expect(compiledChannelSections("Prose.\n```\n## Channel <#CONE>\n```\n", "New prose.")).toBe("");
  });

  test("a section ends at the next heading of its level or above", () => {
    const soul = "## Channel <#CONE>\n### Session\n- Mode: channel\n\n## Values\n- be honest\n";
    expect(compiledChannelSections(soul, "New prose.")).toBe("\n\n## Channel <#CONE>\n### Session\n- Mode: channel");
  });
});

describe("endsInOpenFence", () => {
  test.each([
    ["no fence", "Prose.\n", false],
    ["a closed fence", "\`\`\`\ncode\n\`\`\`\n", false],
    ["an open fence", "Prose.\n\`\`\`\ncode\n", true],
    ["an open tilde fence", "~~~\ncode", true],
    ["an indented open fence", "  \`\`\`\r\ncode\r\n", true],
  ])("%s", (_name, text, open) => {
    expect(endsInOpenFence(text)).toBe(open);
  });
});

describe("renderDir with agent.yaml", () => {
  test("renders the compiled persona; the payload needs version 6", () => {
    const p = renderDir(repo({ default: { "agent.yaml": def() }, ana: { "agent.yaml": FULL } }), meta);
    expect(p.version).toBe(6);
    const ana = p.personas.find((x) => x.name === "ana")!;
    expect(ana.definition?.soulData.manager.userId).toBe("UBOSS");
    expect(payloadVersionFor([ana])).toBe(6);
  });

  test("an agent.yaml beside the older files is a sync error", () => {
    for (const f of ["persona.yaml", "SOUL.md", "mcp.json"]) {
      const dir = repo({ default: { "agent.yaml": def(), [f]: f === "mcp.json" ? "{}" : "x" } });
      const e = err(() => renderDir(dir, meta));
      expect(e).toBeInstanceOf(PayloadError);
      expect(e.message).toContain(f);
      expect(e.message).toContain("agent.yaml cannot sit beside");
    }
  });

  test("an unknown key or a malformed value fails the render", () => {
    expect(() => renderDir(repo({ default: { "agent.yaml": def("nope: 1\n") } }), meta)).toThrow(/persona 'default': agent\.yaml nope is not a known key/);
    expect(() => renderDir(repo({ default: { "agent.yaml": def("skills: 1\n") } }), meta)).toThrow(/persona 'default': agent\.yaml skills/);
  });

  test("an unknown guardrail slug is a warning when the repository carries guardrails", () => {
    const dir = repo({ default: { "agent.yaml": def("guardrails: [ghost]\n") } });
    mkdirSync(join(dir, "guardrails"));
    const warned: string[][] = [];
    renderDir(dir, meta, undefined, (w) => warned.push(w));
    expect(warned.flat().join(" ")).toContain("guardrail 'ghost'");
  });

  test("directories without an agent.yaml render as before, untouched", () => {
    const p = renderDir(repo({ default: { "SOUL.md": "default soul" } }), meta);
    expect(p.version).toBe(1);
    expect(p.personas[0]).toEqual({ name: "default", soul: "default soul" });
  });
});

describe("typed references compile down to the Slack ids the runtime reads", () => {
  const typed = [
    "name: ana", "soul: x", "slackUserId: slack:user:T0EXAMPLE/UANA1",
    "mandate:", "  scoped:", "    - { boundary: slack:channel:T0EXAMPLE/COPS, text: Watch. }", "    - { boundary: trust:public, text: Quiet. }",
    "access:", "  manager: slack:user:UBOSS", "  backupManager: slack:user:T0EXAMPLE/UDEP",
    "  approvers: [{ user: slack:user:UBOB, channel: slack:channel:COPS }]",
    "  channels: { public: [slack:channel:CPUB], trusted: [slack:channel:T0EXAMPLE/CTEAM] }",
    "  dm: [slack:user:UFRIEND]", "  blocked: [slack:user:UNOISY]",
    "channels:", "  slack:channel:COPS: { proactive: true }", "",
  ].join("\n");
  const bare = typed
    .replace("slack:user:T0EXAMPLE/UANA1", "UANA1").replace("slack:channel:T0EXAMPLE/COPS", "channel:COPS").replace(/slack:user:T0EXAMPLE\//g, "")
    .replace(/slack:(?:user|channel):(?:T0EXAMPLE\/)?/g, "").replace("  COPS: { proactive", "  COPS: { proactive");

  test("typed and bare forms compile to identical data, the bare one with warnings", () => {
    const a = parseAgentYaml("ana", typed);
    const b = parseAgentYaml("ana", bare);
    expect(a.warnings).toEqual([]);
    expect(b.warnings.length).toBeGreaterThan(8);
    // The typed form also keeps the workspace it names in accessEntries; everything else is identical.
    const noWorkspace = (spec: typeof a.spec) => ({
      ...spec,
      definition: { ...spec.definition, soulData: { ...spec.definition.soulData, accessEntries: spec.definition.soulData.accessEntries.map(({ workspace: _w, ...e }) => e) } },
    });
    expect(noWorkspace(a.spec)).toEqual(noWorkspace(b.spec));
    expect(a.spec.definition.soulData.accessEntries.find((e) => e.field === "backupManager")?.workspace).toBe("T0EXAMPLE");
    expect(a.spec.slackUserId).toBe("UANA1");
    const d = a.spec.definition.soulData;
    expect(d.manager.userId).toBe("UBOSS");
    expect(d.backupManager.userId).toBe("UDEP");
    expect(d.trustedChannels).toEqual(["CTEAM"]);
    expect(d.channelOverrides.find((c) => c.channel === "COPS")?.mandate).toBe("Watch.");
    expect(a.spec.soul).toContain("## Channel <#COPS>");
  });

  test("each bare field gets one warning that names the field and not the value", () => {
    const w = parseAgentYaml("ana", bare).warnings;
    expect(new Set(w).size).toBe(w.length);
    for (const path of ["slackUserId", "mandate.scoped[0].boundary", "access.manager", "access.backupManager", "access.approvers[0].user", "access.approvers[0].channel", "access.channels.public[0]", "access.channels.trusted[0]", "access.dm[0]", "access.blocked[0]"]) {
      expect(w.filter((x) => x.includes(` ${path} `))).toHaveLength(1);
    }
    for (const x of w) if (!x.includes(" channels.")) expect(x).not.toMatch(/UANA1|UBOSS|UBOB|COPS|CPUB|CTEAM|UFRIEND|UNOISY/);
  });

  test("an unresolvable scheme is refused naming the path and the scheme, with no value", () => {
    const e = err(() => parseAgentYaml("ana", "name: ana\nsoul: x\naccess:\n  dm: [slack:user:UOK, email:person@example.com]\n"));
    expect(e).toBeInstanceOf(PayloadError);
    expect(e.message).toContain("access.dm[1]");
    expect(e.message).toContain("'email'");
    expect(e.message).toContain("cannot be resolved yet");
    expect(e.message).not.toContain("person@example.com");
  });
});

describe("parseAgentYaml proactive", () => {
  const compile = (extra: string) => parseAgentYaml("default", def(extra));

  test("the global key compiles to the section the parser reads", () => {
    const { spec } = compile(
      "proactive:\n  enabled: true\n  read: [slack:channel:C0EXAMPLE, slack:channel:C0OTHER]\n  watch: [mail, tracker]\n  quietHours: 21:00-08:00\n  maxPerDay: 6\n",
    );
    const c = parseProactive(spec.soul);
    expect(c.enabled).toBe(true);
    expect(c.read).toEqual(["C0EXAMPLE", "C0OTHER"]);
    expect(c.watch).toEqual(["mail", "tracker"]);
    expect(c.quietHours).toEqual({ start: 21 * 60, end: 8 * 60 });
    expect(c.maxPerPersonPerDay).toBe(6);
  });

  test("a key left out writes nothing, and the soul text is unchanged", () => {
    expect(compile("proactive: {}\n").spec.soul).toBe(compile("").spec.soul);
  });

  test("a ## Proactive section in the soul is refused when the key is also used", () => {
    const e = (() => { try { parseAgentYaml("default", "name: default\nsoul: |\n  Hi.\n\n  ## Proactive\n  - Read: <#C0EXAMPLE>\nproactive:\n  maxPerDay: 3\n"); } catch (x) { return x as Error; } })();
    expect(e).toBeInstanceOf(PayloadError);
    expect(e!.message).toContain("proactive");
  });

  test("an impossible window is refused without echoing it", () => {
    const e = (() => { try { compile("proactive:\n  quietHours: 25:00-08:00\n"); } catch (x) { return x as Error; } })();
    expect(e).toBeInstanceOf(PayloadError);
    expect(e!.message).toContain("proactive.quietHours");
    expect(e!.message).not.toContain("25:00");
  });

  test("a watch name the section parser would cut or lose is refused", () => {
    for (const bad of ["ops #alerts", "a\u2028b", "a\rb"]) {
      const e = (() => { try { compile(`proactive:\n  watch: [${JSON.stringify(bad)}]\n`); } catch (x) { return x as Error; } })();
      expect(e).toBeInstanceOf(PayloadError);
    }
  });

  test("an unknown key under it is refused", () => {
    const e = (() => { try { compile("proactive:\n  wake: true\n"); } catch (x) { return x as Error; } })();
    expect(e!.message).toContain("proactive.wake");
  });
});
