/**
 * The node manifest's stdio config under the REAL Claude CLI (the binary the
 * Agent SDK ships). The CLI expands `${VAR}` and `${VAR:-default}` in a stdio
 * server's command, args and env values against its own environment — the
 * agent child's, which holds the persona's provider credentials. The control
 * case proves that; the manifest case proves the config slaude builds leaves
 * the CLI nothing to expand, and the server sees only its own variables.
 *
 * No model is called: the CLI starts its MCP servers before its first API
 * request, which goes to a closed local port. Skipped when the platform's CLI
 * binary is not installed.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNodeManifest, stdioServersFor } from "../../src/node/manifest";

function findCli(): string | null {
  const root = join(import.meta.dir, "../../node_modules/@anthropic-ai");
  if (!existsSync(root)) return null;
  // A glibc host may have the musl variant installed too; it cannot run there.
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith("claude-agent-sdk-"))
    .sort((a, b) => Number(a.includes("musl")) - Number(b.includes("musl")));
  for (const d of dirs) {
    const bin = join(root, d, "claude");
    if (existsSync(bin)) return bin;
  }
  return null;
}
const CLI = findCli();

const dir = mkdtempSync(join(tmpdir(), "slaude-real-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// Records what it was started with, then idles as a (silent) stdio server.
const recorder = join(dir, "recorder.js");
writeFileSync(
  recorder,
  `require("node:fs").writeFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), env: process.env }));
process.stdin.resume();
`,
);

/** The agent child's environment, as far as this test needs it. */
const CHILD_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", ANTHROPIC_API_KEY: "provider-fake" };

let n = 0;
/** Run the CLI with this MCP config until the recorder reports, then stop it. */
async function runCli(mcpServers: Record<string, unknown>, outFile: string): Promise<{ argv: string[]; env: Record<string, string> }> {
  const home = join(dir, `home-${++n}`);
  const ws = join(dir, `ws-${n}`);
  mkdirSync(home);
  mkdirSync(ws);
  const child = spawn(
    CLI!,
    ["-p", "hi", "--mcp-config", JSON.stringify({ mcpServers }), "--strict-mcp-config", "--max-turns", "1", "--output-format", "json"],
    {
      cwd: ws,
      stdio: "ignore",
      env: {
        ...CHILD_ENV,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
      },
    },
  );
  try {
    const deadline = Date.now() + 25_000;
    while (!existsSync(outFile)) {
      if (Date.now() > deadline) throw new Error("the CLI never started the MCP server");
      await Bun.sleep(100);
    }
    await Bun.sleep(50); // the write is one call; let it land
    return JSON.parse(readFileSync(outFile, "utf8"));
  } finally {
    child.kill("SIGKILL");
  }
}

describe.skipIf(!CLI)("node manifest under the real CLI", () => {
  it("control: the CLI expands ${VAR:-} in args and env against the agent child's environment", async () => {
    const out = join(dir, "control.json");
    const seen = await runCli(
      {
        rec: {
          type: "stdio",
          command: process.execPath,
          args: [recorder, out, "${ANTHROPIC_API_KEY:-}"],
          env: { LEAK: "${ANTHROPIC_API_KEY}" },
        },
      },
      out,
    );
    expect(seen.argv).toEqual(["provider-fake"]);
    expect(seen.env.LEAK).toBe("provider-fake");
  }, 40_000);

  it("a manifest server under the real CLI sees its own env and the minimal set, never the child's credentials", async () => {
    const out = join(dir, "manifest.json");
    const nodeEnv = { PATH: CHILD_ENV.PATH, HOME: "/home/node-fake", NODE_GH_TOKEN: "gh-fake-value" };
    const m = parseNodeManifest(
      JSON.stringify({
        version: 1,
        mcpServers: { rec: { command: process.execPath, args: [recorder, out], env: { GH_TOKEN: "${NODE_GH_TOKEN}" } } },
        allow: { p: ["rec"] },
      }),
      nodeEnv,
      "node.json",
    );
    const seen = await runCli(stdioServersFor(m, "p", nodeEnv), out);
    expect(JSON.stringify(seen)).not.toContain("provider-fake");
    expect(seen.argv).toEqual([]);
    expect(seen.env.GH_TOKEN).toBe("gh-fake-value");
    expect(Object.keys(seen.env).filter((k) => !k.startsWith("BUN_")).sort()).toEqual(["GH_TOKEN", "HOME", "PATH"]);
  }, 40_000);

  it("a default-form reference in a manifest is refused at boot, or never expanded by the real CLI", async () => {
    const out = join(dir, "hostile.json");
    const nodeEnv = { PATH: CHILD_ENV.PATH };
    let cfg: Record<string, unknown>;
    try {
      const m = parseNodeManifest(
        JSON.stringify({
          version: 1,
          mcpServers: { rec: { command: process.execPath, args: [recorder, out], env: { K: "${ANTHROPIC_API_KEY:-}" } } },
          allow: { p: ["rec"] },
        }),
        nodeEnv,
        "node.json",
      );
      cfg = stdioServersFor(m, "p", nodeEnv);
    } catch {
      return; // refused: nothing reaches the CLI
    }
    expect(JSON.stringify(await runCli(cfg, out))).not.toContain("provider-fake");
  }, 40_000);
});
