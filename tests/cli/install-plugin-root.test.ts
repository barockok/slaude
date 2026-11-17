import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let work: string;
let home: string;
let marketplace: string;

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bun", ["src/cli/install.ts", ...args], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, SLAUDE_HOME: home, ...env },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`install failed: ${r.stderr}`);
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "install-root-"));
  home = join(work, "home");
  marketplace = join(work, "market");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(marketplace, ".claude-plugin"), { recursive: true });
  mkdirSync(join(marketplace, "toolkit"), { recursive: true });
  writeFileSync(join(marketplace, "toolkit", ".mcp.json"), JSON.stringify({ mcpServers: { web: { type: "http", url: "https://x.example.com/mcp" } } }));
  writeFileSync(join(marketplace, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "market", plugins: [{ name: "toolkit", source: "./toolkit", version: "1.0.0" }] }));
  execSync("git init -q -b main && git add -A && git -c user.email=a@a.test -c user.name=a commit -q -m init", { cwd: marketplace });
  writeFileSync(join(home, "slaude.json"), JSON.stringify({ version: 1, plugins: [{ marketplace: `file://${marketplace}`, plugin: "toolkit", ref: "main" }], skills: [], knowledge: [] }));
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("install --plugin-root", () => {
  test("installs plugins and metadata under the root, nothing under $SLAUDE_HOME/.claude", () => {
    const root = join(work, "image-root");
    run(["--plugin-root", root]);
    expect(existsSync(join(root, "plugins", "cache", "market", "toolkit", "1.0.0", ".mcp.json"))).toBe(true);
    const listed = JSON.parse(readFileSync(join(root, "plugins", "installed_plugins.json"), "utf8"));
    expect(listed.plugins["toolkit@market"][0].installPath).toBe(join(root, "plugins", "cache", "market", "toolkit", "1.0.0"));
    expect(listed.plugins["toolkit@market"][0].gitCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(home, ".claude", "plugins"))).toBe(false);
    expect(existsSync(join(home, "slaude.lock"))).toBe(true);
  });

  test("SLAUDE_PLUGIN_ROOT targets the root when the flag is absent", () => {
    const root = join(work, "env-root");
    run([], { SLAUDE_PLUGIN_ROOT: root });
    expect(existsSync(join(root, "plugins", "installed_plugins.json"))).toBe(true);
    expect(existsSync(join(home, ".claude", "plugins"))).toBe(false);
  });

  test("without either, plugins install under $SLAUDE_HOME/.claude as before", () => {
    run([]);
    expect(existsSync(join(home, ".claude", "plugins", "installed_plugins.json"))).toBe(true);
  });
});
