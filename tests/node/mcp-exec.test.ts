/**
 * The exec wrapper a node manifest stdio server runs through: the real server
 * process receives only the minimal node variables and its own `env`, not the
 * agent child's environment (node labels spec §4.10).
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNodeManifest, stdioServersFor } from "../../src/node/manifest";
import { parseExecArgv, pickEnv, runMcpExec } from "../../src/node/mcp-exec";

// A tiny stdio server: answers each line on stdin with its own environment.
const dir = mkdtempSync(join(tmpdir(), "slaude-mcp-exec-"));
const echoServer = join(dir, "echo-server.js");
writeFileSync(
  echoServer,
  `process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const req = JSON.parse(line);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { env: process.env } }) + "\\n");
  }
});
`,
);

/** Start a config the way the CLI does: its own environment under the server's `env`. */
function startLikeCli(cfg: { command: string; args: string[]; env: Record<string, string> }, inherited: Record<string, string>) {
  const child = spawn(cfg.command, cfg.args, { stdio: ["pipe", "pipe", "inherit"], env: { ...inherited, ...cfg.env } });
  return {
    async request(): Promise<Record<string, string>> {
      const out = new Promise<string>((resolve) => {
        let b = "";
        child.stdout!.on("data", (d) => {
          b += d;
          const i = b.indexOf("\n");
          if (i >= 0) resolve(b.slice(0, i));
        });
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "env" }) + "\n");
      return JSON.parse(await out).result.env;
    },
    stop: () => {
      child.stdin!.end();
      return new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    },
  };
}

describe("mcp-exec wrapper", () => {
  it("the server process receives only the minimal set and its own env, not the agent child's", async () => {
    const nodeEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: "/home/node-fake",
      LANG: "C.UTF-8",
      TMPDIR: tmpdir(),
      NODE_GH_TOKEN: "gh-fake-value",
    };
    const m = parseNodeManifest(
      JSON.stringify({
        version: 1,
        mcpServers: { echo: { command: process.execPath, args: [echoServer], env: { GH_TOKEN: "${NODE_GH_TOKEN}" } } },
        allow: { p: ["echo"] },
      }),
      nodeEnv,
      "node.json",
    );
    const cfg = stdioServersFor(m, "p", nodeEnv) as any;
    // What the agent child holds and the CLI would pass down.
    const inherited = { ANTHROPIC_API_KEY: "provider-fake", OPENAI_API_KEY: "other-fake", CLAUDE_CONFIG_DIR: "/cfg", SOME_VAR: "1" };
    const srv = startLikeCli(cfg.echo, inherited);
    const env = await srv.request();
    expect(await srv.stop()).toBe(0);
    // Bun may add its own runtime markers to a process it starts; nothing else.
    const keys = Object.keys(env).filter((k) => !k.startsWith("BUN_"));
    expect(keys.sort()).toEqual(["GH_TOKEN", "HOME", "LANG", "PATH", "TMPDIR"]);
    expect(env.GH_TOKEN).toBe("gh-fake-value");
    expect(env.HOME).toBe("/home/node-fake");
    expect(JSON.stringify(env)).not.toContain("provider-fake");
  });

  it("resolves a bare command on the server's own PATH and passes its exit code", async () => {
    const code = await runMcpExec(["PATH", "--", "sh", "-c", "exit 3"], { PATH: "/usr/bin:/bin" });
    expect(code).toBe(3);
  });

  it("a command that cannot start exits 127; malformed argv exits 2", async () => {
    expect(await runMcpExec(["PATH", "--", "/nonexistent/server-bin"], { PATH: "/bin" })).toBe(127);
    expect(await runMcpExec(["PATH", "server"], {})).toBe(2);
  });

  it("parses argv and picks only named variables", () => {
    expect(parseExecArgv(["A,B", "--", "cmd", "x"])).toEqual({ names: ["A", "B"], command: "cmd", args: ["x"] });
    expect(parseExecArgv(["", "--", "cmd"])).toEqual({ names: [], command: "cmd", args: [] });
    expect(parseExecArgv(["A", "--"])).toBeNull();
    expect(parseExecArgv([])).toBeNull();
    expect(pickEnv(["A", "C"], { A: "1", B: "2" })).toEqual({ A: "1" });
  });
});
