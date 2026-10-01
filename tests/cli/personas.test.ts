import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportHome, renderDir } from "../../src/cli/personas";
import { PayloadError, resolvePlaceholders } from "../../src/persona/sync/payload";

function home(extra?: string): string {
  const h = mkdtempSync(join(tmpdir(), "slaude-export-"));
  writeFileSync(join(h, "SOUL.md"), "default soul");
  const add = (name: string, soul: string, uid: string) => {
    mkdirSync(join(h, "personas", name), { recursive: true });
    writeFileSync(join(h, "personas", name, "SOUL.md"), soul);
    writeFileSync(join(h, "personas", name, "config.json"),
      JSON.stringify({ name, slackUserId: uid, userToken: "user-token-live-secret" }));
    writeFileSync(join(h, "personas", name, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  };
  add("ana", "ana soul ${NOT_A_VAR}\n", "UTESTUSER1");
  if (extra) add(extra, "other", "UTESTUSER2");
  return h;
}
const meta = { revision: "r1", committedAt: "2026-10-01T10:00:00Z" };
const tmp = () => mkdtempSync(join(tmpdir(), "slaude-repo-"));

describe("personas export and render", () => {
  test("export writes repository layout and puts no secret in it", () => {
    const out = tmp();
    const { variables } = exportHome(home(), out);
    expect(variables).toEqual(["ANA_XOXP"]);
    const all = readdirSync(join(out, "personas"), { recursive: true }).map(String)
      .map((f) => { try { return readFileSync(join(out, "personas", f), "utf8"); } catch { return ""; } }).join("\n");
    expect(all).not.toContain("user-token-live-secret");
    expect(all).toContain("${ANA_XOXP}");
  });

  // Acceptance 16.
  test("export then render reproduces the deployment, soul text byte-for-byte", () => {
    const out = tmp();
    exportHome(home(), out);
    const p = renderDir(out, meta);
    expect(p.personas.map((x) => x.name).sort()).toEqual(["ana", "default"]);
    const ana = p.personas.find((x) => x.name === "ana")!;
    expect(ana.soul).toBe("ana soul ${NOT_A_VAR}\n");
    expect(ana.userToken).toBe("${ANA_XOXP}");
    expect(ana.slackUserId).toBe("UTESTUSER1");
  });

  test("a hyphenated or digit persona name yields a variable the gateway accepts", () => {
    const out = tmp();
    const { variables } = exportHome(home("quick-1"), out);
    expect(variables).toContain("QUICK_1_XOXP");
    const p = renderDir(out, meta);
    const q = p.personas.find((x) => x.name === "quick-1")!;
    const r = resolvePlaceholders(q, { QUICK_1_XOXP: "v" });
    expect(r.userToken).toBe("v");
  });

  test("render rejects a directory whose name is not a valid persona name", () => {
    const out = tmp();
    mkdirSync(join(out, "personas", "default"), { recursive: true });
    writeFileSync(join(out, "personas", "default", "SOUL.md"), "x");
    mkdirSync(join(out, "personas", "Bad_Name"), { recursive: true });
    writeFileSync(join(out, "personas", "Bad_Name", "SOUL.md"), "x");
    expect(() => renderDir(out, meta)).toThrow(PayloadError);
  });

  test("render fails when personas exist but there is no default", () => {
    const out = tmp();
    mkdirSync(join(out, "personas", "ana"), { recursive: true });
    writeFileSync(join(out, "personas", "ana", "SOUL.md"), "x");
    writeFileSync(join(out, "personas", "ana", "persona.yaml"), "slackUserId: UTESTUSER1\n");
    expect(() => renderDir(out, meta)).toThrow(/default/);
    expect(() => renderDir(out, meta)).toThrow(PayloadError);
  });
});

describe("personas export hardening", () => {
  const withMcp = (mcp: unknown, name = "ana") => {
    const h = home();
    writeFileSync(join(h, "personas", name, "mcp.json"), JSON.stringify(mcp));
    return h;
  };
  const dump = (out: string) => readdirSync(join(out, "personas"), { recursive: true }).map(String)
    .map((f) => { try { return readFileSync(join(out, "personas", f), "utf8"); } catch { return ""; } }).join("\n");

  test("literal header and env values become placeholders; existing placeholders stay", () => {
    const out = tmp();
    const h = withMcp({ mcpServers: { "my-srv": {
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer literal-bearer-value", "X-Ok": "${GOOD_VAR}" },
      env: { API_KEY: "literal-env-value" } } } });
    const { variables } = exportHome(h, out);
    const all = dump(out);
    expect(all).not.toContain("literal-bearer-value");
    expect(all).not.toContain("literal-env-value");
    expect(all).toContain("${GOOD_VAR}");
    expect(variables).toContain("ANA_MY_SRV_AUTHORIZATION");
    expect(variables).toContain("ANA_MY_SRV_API_KEY");
    expect(variables).not.toContain("GOOD_VAR");
    const p = renderDir(out, meta);
    const ana = p.personas.find((x) => x.name === "ana")!;
    const env = new Proxy({}, { get: () => "v" }) as Record<string, string>;
    expect(() => resolvePlaceholders(ana, env)).not.toThrow();
  });

  test("a url with a query string or userinfo fails export, naming persona and server", () => {
    expect(() => exportHome(withMcp({ mcpServers: { s1: { url: "https://x.test/mcp?token=abc" } } }), tmp()))
      .toThrow(/persona 'ana'.*server 's1'/);
    expect(() => exportHome(withMcp({ mcpServers: { s2: { url: "https://u:p@x.test/mcp" } } }), tmp()))
      .toThrow(PayloadError);
  });

  test("the default persona's .mcp.json is scrubbed too", () => {
    const h = home();
    writeFileSync(join(h, ".mcp.json"), JSON.stringify({ mcpServers: { d: { headers: { A: "literal-default-value" } } } }));
    const out = tmp();
    const { variables } = exportHome(h, out);
    expect(dump(out)).not.toContain("literal-default-value");
    expect(variables).toContain("DEFAULT_D_A");
  });

  test("invalid directory name fails export", () => {
    const h = home("Bad_Name");
    expect(() => exportHome(h, tmp())).toThrow(/Bad_Name/);
  });

  test("malformed or null config.json fails with the persona named", () => {
    for (const body of ["{nope", "null"]) {
      const h = home();
      writeFileSync(join(h, "personas", "ana", "config.json"), body);
      expect(() => exportHome(h, tmp())).toThrow(/persona 'ana'/);
    }
  });

  test("render rejects invalid placeholders the gateway would reject", () => {
    const out = tmp();
    mkdirSync(join(out, "personas", "default"), { recursive: true });
    writeFileSync(join(out, "personas", "default", "SOUL.md"), "x");
    mkdirSync(join(out, "personas", "ana"), { recursive: true });
    writeFileSync(join(out, "personas", "ana", "SOUL.md"), "x");
    writeFileSync(join(out, "personas", "ana", "persona.yaml"), 'slackUserId: UTESTUSER1\nuserToken: "${lower_case}"\n');
    expect(() => renderDir(out, meta)).toThrow(PayloadError);
  });
});

describe("personas CLI entry", () => {
  const run = (...a: string[]) => Bun.spawnSync(["bun", "src/cli/personas.ts", ...a], { cwd: join(import.meta.dir, "../..") });
  test("--check is position independent, silent and exits 0 on a valid repo", () => {
    const out = tmp();
    exportHome(home(), out);
    for (const args of [["render", "--check", out], ["render", out, "--check"]]) {
      const r = run(...args);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toBe("");
    }
  });
  test("an invalid repo exits 1 with [personas] on stderr", () => {
    const out = tmp();
    mkdirSync(join(out, "personas", "Bad_Name"), { recursive: true });
    const r = run("render", out, "--check");
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("[personas] ");
  });
  test("an unknown command exits 2", () => {
    expect(run("bogus").exitCode).toBe(2);
  });
});
