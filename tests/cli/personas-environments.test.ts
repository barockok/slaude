import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAgentYaml, exportHome, renderDir } from "../../src/cli/personas";
import { PayloadError } from "../../src/persona/sync/payload";

const meta = { revision: "r1", committedAt: "2026-10-01T10:00:00Z" };
const FP = "SHA256:" + "A".repeat(43);
const envYaml = (name = "team-sandbox") => `name: ${name}\nkind: ssh\nshared: true\ntrust: unlocked\ndefaultDir: /srv/work\nssh:\n  host: build-box.example.com\n  user: dev\n  hostKey: "${FP}"\n`;
const agent = (name: string, extra = "") => `name: ${name}\n${name === "default" ? "" : "slackUserId: UANA1\n"}soul: You are ${name}.\n${extra}`;

function repo(o: { agents?: Record<string, string>; environments?: Record<string, string> | null }): string {
  const dir = mkdtempSync(join(tmpdir(), "slaude-envrepo-"));
  for (const [name, body] of Object.entries(o.agents ?? { default: agent("default") })) {
    mkdirSync(join(dir, "personas", name), { recursive: true });
    writeFileSync(join(dir, "personas", name, "agent.yaml"), body);
  }
  if (o.environments) {
    mkdirSync(join(dir, "environments"), { recursive: true });
    for (const [f, body] of Object.entries(o.environments)) writeFileSync(join(dir, "environments", f), body);
  }
  return dir;
}
const err = (f: () => unknown): PayloadError => {
  try {
    f();
  } catch (e) {
    return e as PayloadError;
  }
  throw new Error("expected a throw");
};
const allowA = "environment:\n  allow: [env:team-sandbox]\n";

describe("personas render with environments/", () => {
  test("no folder: payload version 6 and no environments key (a version 6 payload is unchanged)", () => {
    const p = renderDir(repo({}), meta);
    expect(p.version).toBe(6);
    expect("environments" in p).toBe(false);
    const withAgent = renderDir(repo({ agents: { default: agent("default"), ana: agent("ana") } }), meta);
    expect(withAgent.version).toBe(6);
  });

  test("a folder: the raw text is sent as {name, yaml}, version 7", () => {
    const p = renderDir(repo({ agents: { default: agent("default"), ana: agent("ana", allowA) }, environments: { "team-sandbox.yaml": envYaml() } }), meta);
    expect(p.version).toBe(7);
    expect(p.environments).toEqual([{ name: "team-sandbox", yaml: envYaml() }]);
  });

  test("an empty folder is the whole set (retire everything) and needs version 7", () => {
    const p = renderDir(repo({ environments: {} }), meta);
    expect(p.environments).toEqual([]);
    expect(p.version).toBe(7);
  });

  test("a bad file fails with the environment's name and no value", () => {
    const e = err(() => renderDir(repo({ environments: { "team-sandbox.yaml": envYaml().replace("trust: unlocked\n", "").replace("build-box.example.com", "10.1.2.3") } }), meta));
    expect(e.message).toContain("environment 'team-sandbox'");
    expect(e.message).not.toContain("10.1.2.3");
  });

  test("tailcat, a name that differs from the file, other extensions and subfolders are refused", () => {
    expect(err(() => renderDir(repo({ environments: { "a.yaml": "name: a\nkind: tailcat\naddr: 100.64.0.9\n" } }), meta)).message).toContain("tailcat is not supported");
    expect(err(() => renderDir(repo({ environments: { "other.yaml": envYaml() } }), meta)).message).toContain("must equal the file name");
    expect(err(() => renderDir(repo({ environments: { "team-sandbox.yml": envYaml() } }), meta)).message).toContain("only <name>.yaml");
    expect(err(() => renderDir(repo({ environments: { "Team_Sandbox.yaml": envYaml() } }), meta)).message).toContain("not a valid environment name");
  });

  test("an agent reference with no matching file fails offline when the folder exists", () => {
    const e = err(() => renderDir(repo({ agents: { default: agent("default"), ana: agent("ana", allowA) }, environments: {} }), meta));
    expect(e.message).toContain("persona 'ana'");
    expect(e.message).toContain("env:team-sandbox");
  });

  test("an agent reference with no folder is a warning, not an error", () => {
    const warnings: string[] = [];
    const p = renderDir(repo({ agents: { default: agent("default"), ana: agent("ana", allowA) } }), meta, undefined, (w) => warnings.push(...w));
    expect(p.version).toBe(7);
    expect(warnings.join("\n")).toContain("no environments/ folder");
  });
});

describe("export never invents or carries definitions", () => {
  function home(extra: { config?: object; agentYaml?: string } = {}): string {
    const h = mkdtempSync(join(tmpdir(), "slaude-envhome-"));
    writeFileSync(join(h, "SOUL.md"), "default soul\n");
    mkdirSync(join(h, "personas", "ana"), { recursive: true });
    writeFileSync(join(h, "personas", "ana", "SOUL.md"), "# Persona\n## Identity\n- Name: Ana\n");
    writeFileSync(join(h, "personas", "ana", "config.json"), JSON.stringify({ slackUserId: "UANA1", ...(extra.config ?? {}) }));
    if (extra.agentYaml) writeFileSync(join(h, "personas", "ana", "agent.yaml"), extra.agentYaml);
    return h;
  }

  test("a plain home exports no environments folder", async () => {
    const out = mkdtempSync(join(tmpdir(), "slaude-envout-"));
    exportHome(home(), out);
    expect(existsSync(join(out, "environments"))).toBe(false);
    const out2 = mkdtempSync(join(tmpdir(), "slaude-envout-"));
    await exportAgentYaml(home(), out2, { extract: async () => (await import("../../src/soul/data")).SoulDataSchema.parse({ identity: { name: "Ana" } }) });
    expect(existsSync(join(out2, "environments"))).toBe(false);
    expect(readFileSync(join(out2, "personas", "ana", "agent.yaml"), "utf8")).not.toContain("environment");
  });

  test("a persona that has an environment key is refused, not exported without it", async () => {
    for (const h of [home({ config: { environment: { allow: ["env:x"] } } }), home({ agentYaml: "name: ana\n" + allowA })]) {
      const out = mkdtempSync(join(tmpdir(), "slaude-envout-"));
      expect(err(() => exportHome(h, out)).message).toContain("environment key");
      const e = await exportAgentYaml(h, out, { extract: async () => (await import("../../src/soul/data")).SoulDataSchema.parse({}) }).catch((x) => x as Error);
      expect((e as Error).message).toContain("environment key");
    }
  });
});
