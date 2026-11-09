import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDir } from "../../src/cli/personas";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { PayloadError, payloadVersionFor } from "../../src/persona/sync/payload";
import { SoulDataSchema } from "../../src/soul/data";
import { subMandatesOf } from "../../src/soul/mandate-scope";

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
    ["bad manager id", "name: ana\nsoul: x\naccess:\n  manager: alice\n", /access\.manager must be a Slack user id/],
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
