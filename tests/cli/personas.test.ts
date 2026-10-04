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
    expect(variables).toEqual(["PERSONA_ANA_XOXP"]);
    const all = readdirSync(join(out, "personas"), { recursive: true }).map(String)
      .map((f) => { try { return readFileSync(join(out, "personas", f), "utf8"); } catch { return ""; } }).join("\n");
    expect(all).not.toContain("user-token-live-secret");
    expect(all).toContain("${PERSONA_ANA_XOXP}");
  });

  // Acceptance 16.
  test("export then render reproduces the deployment, soul text byte-for-byte", () => {
    const out = tmp();
    exportHome(home(), out);
    const p = renderDir(out, meta);
    expect(p.personas.map((x) => x.name).sort()).toEqual(["ana", "default"]);
    const ana = p.personas.find((x) => x.name === "ana")!;
    expect(ana.soul).toBe("ana soul ${NOT_A_VAR}\n");
    expect(ana.userToken).toBe("${PERSONA_ANA_XOXP}");
    expect(ana.slackUserId).toBe("UTESTUSER1");
  });

  test("a hyphenated or digit persona name yields a variable the gateway accepts", () => {
    const out = tmp();
    const { variables } = exportHome(home("quick-1"), out);
    expect(variables).toContain("PERSONA_QUICK_1_XOXP");
    const p = renderDir(out, meta);
    const q = p.personas.find((x) => x.name === "quick-1")!;
    const r = resolvePlaceholders(q, { PERSONA_QUICK_1_XOXP: "v" });
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

  test("render --check refuses a placeholder outside PERSONA_*, naming it", () => {
    const out = tmp();
    mkdirSync(join(out, "personas", "default"), { recursive: true });
    writeFileSync(join(out, "personas", "default", "SOUL.md"), "x");
    writeFileSync(join(out, "personas", "default", "mcp.json"),
      JSON.stringify({ mcpServers: { x: { type: "http", url: "https://x.test", headers: { a: "${SLAUDE_MASTER_KEY}" } } } }));
    expect(() => renderDir(out, meta)).toThrow(/SLAUDE_MASTER_KEY/);
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

  test("literal header and env values become placeholders; existing PERSONA_ placeholders stay", () => {
    const out = tmp();
    const h = withMcp({ mcpServers: { "my-srv": {
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer literal-bearer-value", "X-Ok": "${PERSONA_GOOD_VAR}", "X-Other": "${OTHER_VAR}" },
      env: { API_KEY: "literal-env-value" } } } });
    const { variables } = exportHome(h, out);
    const all = dump(out);
    expect(all).not.toContain("literal-bearer-value");
    expect(all).not.toContain("literal-env-value");
    expect(all).toContain("${PERSONA_GOOD_VAR}");
    expect(variables).toContain("PERSONA_ANA_MY_SRV_AUTHORIZATION");
    expect(variables).toContain("PERSONA_ANA_MY_SRV_API_KEY");
    expect(variables).not.toContain("PERSONA_GOOD_VAR");
    // A placeholder the gateway would refuse is replaced by a PERSONA_ one.
    expect(all).not.toContain("${OTHER_VAR}");
    expect(variables).toContain("PERSONA_ANA_MY_SRV_X_OTHER");
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
    expect(variables).toContain("PERSONA_DEFAULT_D_A");
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

describe("personas export, round 2", () => {
  const withMcp = (mcp: unknown) => {
    const h = home();
    writeFileSync(join(h, "personas", "ana", "mcp.json"), JSON.stringify(mcp));
    return h;
  };
  const srv = (def: unknown) => withMcp({ mcpServers: { s: def } });

  test("non-string header/env values fail, naming persona, server and key", () => {
    expect(() => exportHome(srv({ env: { PORT: 8080 } }), tmp())).toThrow(/persona 'ana'.*server 's'.*PORT/);
    expect(() => exportHome(srv({ headers: { X: { nested: "v" } } }), tmp())).toThrow(PayloadError);
  });

  test("colliding generated variable names fail, naming both origins", () => {
    const h = withMcp({ mcpServers: { "a-b": { env: { x: "one" } }, a: { env: { b_x: "two" } } } });
    expect(() => exportHome(h, tmp())).toThrow(/ana\/a-b\/x.*ana\/a\/b_x|ana\/a\/b_x.*ana\/a-b\/x/);
    const h2 = srv({ headers: { "X-Key": "one", X_Key: "two" } });
    expect(() => exportHome(h2, tmp())).toThrow(/collision/);
  });

  test("parse errors do not echo file content", () => {
    for (const [file, where] of [["config.json", "personas/ana"], ["mcp.json", "personas/ana"], [".mcp.json", ""]] as const) {
      const h = home();
      writeFileSync(join(h, where, file), "{ DISTINCTIVE_MARKER_77 nope");
      let msg = "";
      try { exportHome(h, tmp()); } catch (e) { msg = (e as Error).message; }
      expect(msg).toContain(file);
      expect(msg).not.toContain("DISTINCTIVE_MARKER_77");
    }
  });

  test("secret-looking stdio args fail without echoing the arg", () => {
    for (const args of [["--token=abc-secret-val"], ["--api-key", "abc-secret-val"], ["x", "Bearer abc-secret-val"]]) {
      let msg = "";
      try { exportHome(srv({ command: "x", args }), tmp()); } catch (e) { msg = (e as Error).message; }
      expect(msg).toContain("persona 'ana'");
      expect(msg).toContain("server 's'");
      expect(msg).not.toContain("abc-secret-val");
    }
  });

  test("benign stdio args export with a names-only stderr warning", () => {
    const orig = console.error;
    const seen: string[] = [];
    console.error = (...a: unknown[]) => { seen.push(a.join(" ")); };
    try { exportHome(srv({ command: "x", args: ["--port", "8080"] }), tmp()); } finally { console.error = orig; }
    const w = seen.join("\n");
    expect(w).toContain("ana/s");
    expect(w).not.toContain("8080");
    expect(w).not.toContain("--port");
  });

  test("a url fragment is refused", () => {
    expect(() => exportHome(srv({ url: "https://x.test/mcp#frag" }), tmp())).toThrow(/persona 'ana'.*server 's'/);
  });
});

// The final review's probe: six shapes that export wrote to git verbatim.
// Fixture tokens are built by concatenation so the repo's leak scan does not
// match them literally.
describe("personas export, allowlist shape (fails closed)", () => {
  const withMcp = (mcp: unknown) => {
    const h = home();
    writeFileSync(join(h, "personas", "ana", "mcp.json"), JSON.stringify(mcp));
    return h;
  };
  const srv = (def: unknown) => withMcp({ mcpServers: { s: def } });
  const SECRET = "Q7xLm2" + "Vb9Rt4Kp8Wz1Ny6Hc3Jd5Fs0Ga";
  const expectRefused = (h: string, re: RegExp) => {
    let msg = "";
    const out = tmp();
    try { exportHome(h, out); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(re);
    expect(msg).not.toContain(SECRET);
  };

  test("shape 1: a string headers value fails", () => {
    expectRefused(srv({ url: "https://x.test/mcp", headers: "Authorization: Bearer " + SECRET }),
      /persona 'ana'.*server 's'.*headers/);
  });

  test("a string env value fails", () => {
    expectRefused(srv({ command: "x", env: "API_KEY=" + SECRET }), /persona 'ana'.*server 's'.*env/);
  });

  test("shape 2: a string args value fails", () => {
    expectRefused(srv({ command: "x", args: "--token " + SECRET }), /persona 'ana'.*server 's'.*args/);
  });

  test("shape 3: an unknown server key (apiKey) fails, naming it", () => {
    expectRefused(srv({ url: "https://x.test/mcp", apiKey: SECRET }), /persona 'ana'.*server 's'.*apiKey/);
  });

  test("shape 4: an unknown nested server key (oauth.clientSecret) fails, naming it", () => {
    expectRefused(srv({ url: "https://x.test/mcp", oauth: { clientId: "id", clientSecret: SECRET } }),
      /persona 'ana'.*server 's'.*oauth/);
  });

  test("shape 5: a command string with an inline TOKEN= fails", () => {
    expectRefused(srv({ command: "TOKEN=" + SECRET + " mcp-server" }), /persona 'ana'.*server 's'.*command/);
  });

  test("shape 6: a token in the url path fails", () => {
    expectRefused(srv({ type: "http", url: "https://mcp.example.test/api/s/" + SECRET + "/mcp" }),
      /persona 'ana'.*server 's'.*url/);
  });

  test("known token shapes in the url path, command or args fail", () => {
    const shapes = [
      "xox" + "b-12345-abcdef",
      "gh" + "p_abcdef123456",
      "gh" + "o_abcdef123456",
      "github" + "_pat_abc123",
      "s" + "k-abcdefghij",
      "AK" + "IAABCDEFGHIJKLMNOP",
      "ey" + "JhbGciOi.eyJzdWIi.sig",
    ];
    for (const t of shapes) {
      expect(() => exportHome(srv({ url: `https://x.test/${t}/mcp` }), tmp())).toThrow(/server 's'.*url/);
      expect(() => exportHome(srv({ command: `run-${t}` }), tmp())).toThrow(/server 's'.*command/);
      expect(() => exportHome(srv({ command: "x", args: [t] }), tmp())).toThrow(/server 's'.*args/);
    }
    expect(() => exportHome(srv({ command: "bearer abc" }), tmp())).toThrow(/server 's'.*command/);
  });

  test("a non-object server definition or mcpServers fails", () => {
    expectRefused(srv("https://u:" + SECRET + "@x.test"), /persona 'ana'.*server 's'/);
    expectRefused(withMcp({ mcpServers: "nope" }), /persona 'ana'.*mcpServers/);
  });

  test("an unknown top-level key fails, naming it", () => {
    expectRefused(withMcp({ mcpServers: {}, token: SECRET }), /persona 'ana'.*token/);
  });

  test("ordinary stdio and http configs still export", () => {
    const out = tmp();
    const h = withMcp({
      privateServices: ["fs"],
      mcpServers: {
        fs: { type: "stdio", command: "bunx", args: ["@modelcontextprotocol/server-filesystem", "/srv/data"], env: { LOG: "info" } },
        web: { type: "http", url: "https://mcp.example.test/v1/mcp", headers: { Authorization: "Bearer x" } },
      },
    });
    const orig = console.error;
    console.error = () => {};
    try { expect(() => exportHome(h, out)).not.toThrow(); } finally { console.error = orig; }
    expect(() => renderDir(out, meta)).not.toThrow();
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
  test("render emits the payload version", () => {
    const out = tmp();
    exportHome(home(), out);
    expect(JSON.parse(run("render", out).stdout.toString()).version).toBe(1);
    expect(renderDir(out, meta).version).toBe(1);
  });
  // Node labels spec §4.5: runsOn round-trips export → render, and render
  // writes version 2 only when a persona uses it.
  test("runsOn: export carries it only when present; render reads it and writes version 2", () => {
    const h = home("bea");
    const cfgFile = join(h, "personas", "ana", "config.json");
    writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, "utf8")), runsOn: "engineering" }));
    const out = tmp();
    exportHome(h, out);
    expect(readFileSync(join(out, "personas", "ana", "persona.yaml"), "utf8")).toContain('runsOn: "engineering"');
    expect(readFileSync(join(out, "personas", "bea", "persona.yaml"), "utf8")).not.toContain("runsOn");
    const p = renderDir(out, meta);
    expect(p.version).toBe(2);
    expect(p.personas.find((x) => x.name === "ana")!.runsOn).toBe("engineering");
    expect(p.personas.find((x) => x.name === "bea")!.runsOn).toBeUndefined();
    const f = join(out, "personas", "ana", "persona.yaml");
    writeFileSync(f, readFileSync(f, "utf8").replace('runsOn: "engineering"', 'runsOn: "Not A Label"'));
    expect(() => renderDir(out, meta)).toThrow(PayloadError);
  });
  test("export refuses a malformed runsOn in config.json, naming the persona", () => {
    const h = home();
    const cfgFile = join(h, "personas", "ana", "config.json");
    writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, "utf8")), runsOn: "Bad Label" }));
    expect(() => exportHome(h, tmp())).toThrow(/persona 'ana'.*runsOn/);
  });
  test("--check reports unknown persona.yaml keys by name on stderr and still exits 0", () => {
    const out = tmp();
    exportHome(home(), out);
    const f = join(out, "personas", "ana", "persona.yaml");
    writeFileSync(f, readFileSync(f, "utf8") + 'visibility: "leaky-value"\n');
    const r = run("render", out, "--check");
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toContain("persona.ana.visibility");
    expect(r.stderr.toString()).not.toContain("leaky-value");
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
