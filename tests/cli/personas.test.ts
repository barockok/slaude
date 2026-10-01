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
  add("ana", "ana soul ${NOT_A_VAR}", "UTESTUSER1");
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
    expect(ana.soul).toBe("ana soul ${NOT_A_VAR}");
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
