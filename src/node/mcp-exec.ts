/**
 * Exec wrapper for a node manifest stdio MCP server (node labels spec §4.10).
 *
 *   bun mcp-exec.ts <NAME,NAME,...> -- <command> [args...]
 *
 * The CLI starts a stdio server with its own environment merged under the
 * server's configured `env`, so the server would inherit everything the agent
 * child holds (provider keys included). This wrapper starts the real command
 * with ONLY the variables named in its first argument, taken from its own
 * environment: the node manifest puts the minimal node set and the server's
 * expanded `env` there. Names travel in the wrapper's argv, values in its
 * environment. (The SDK still passes the whole MCP config, values included,
 * on the agent child's command line: node labels spec §4.12, one trust domain.)
 */
import { spawn } from "node:child_process";

/** `source` reduced to the named variables (absent ones are skipped). */
export function pickEnv(names: readonly string[], source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) if (n && source[n] !== undefined) out[n] = source[n]!;
  return out;
}

/** Parse `<names> -- <command> [args...]`, or null when malformed. */
export function parseExecArgv(argv: readonly string[]): { names: string[]; command: string; args: string[] } | null {
  const [names, sep, command, ...args] = argv;
  if (names === undefined || sep !== "--" || !command) return null;
  return { names: names.split(",").filter(Boolean), command, args };
}

/** Run the server with stdio passed through; resolves with its exit code. */
export function runMcpExec(argv: readonly string[], source: Record<string, string | undefined>): Promise<number> {
  const parsed = parseExecArgv(argv);
  if (!parsed) {
    process.stderr.write("mcp-exec: usage: mcp-exec <NAME,...> -- <command> [args...]\n");
    return Promise.resolve(2);
  }
  const env = pickEnv(parsed.names, source);
  return new Promise((resolve) => {
    // A bare command resolves on the server's own PATH (spawn looks it up in env.PATH).
    const child = spawn(parsed.command, parsed.args, { stdio: "inherit", env });
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    process.on("SIGTERM", forward("SIGTERM"));
    process.on("SIGINT", forward("SIGINT"));
    child.on("error", (e) => {
      process.stderr.write(`mcp-exec: cannot start ${parsed.command}: ${(e as NodeJS.ErrnoException).code ?? e.message}\n`);
      resolve(127);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 + 15 : 1)));
  });
}

if (import.meta.main) {
  runMcpExec(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
