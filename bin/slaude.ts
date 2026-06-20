#!/usr/bin/env bun
// slaude launcher — run from any cwd as a `slaude` command.
//
// SLAUDE_HOME (where SOUL.md / skills / mcp.json live) resolves as:
//   1. an explicit $SLAUDE_HOME, else
//   2. the current dir if it contains a SOUL.md (so `cd my-agent && slaude` just works), else
//   3. the built-in default (~/.slaude) — handled downstream in config/home.ts.
//
// import.meta.dir resolves through the symlink in ~/.bun/bin to the real file,
// so the repo root is found no matter where the command is invoked from.
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

const root = dirname(import.meta.dir); // bin/ -> repo root
const argv = process.argv.slice(2);

const env: Record<string, string> = { ...process.env } as Record<string, string>;
if (!env.SLAUDE_HOME && existsSync(join(process.cwd(), "SOUL.md"))) {
  env.SLAUDE_HOME = process.cwd();
}

// Subcommand → entrypoint. Bare `slaude` (or `slaude start`) boots the Slack runtime.
const sub = argv[0];
let entry: string;
let rest: string[];
switch (sub) {
  case "sim":
    entry = "src/gateway/sim/cli.ts";
    rest = argv.slice(1);
    break;
  case "start":
    entry = "src/server.ts";
    rest = argv.slice(1);
    break;
  case "brain-server":
    entry = "src/knowledge/server/brain-server.ts";
    rest = argv.slice(1);
    break;
  case "brain":
    if (argv[1] === "connect") {
      entry = "src/cli/brain-connect.ts";
      rest = argv.slice(2);
      break;
    }
    console.error("usage: slaude brain connect");
    process.exit(2);
    break;
  case "-h":
  case "--help":
    console.log(
      [
        "slaude — Slack-native Claude Code runtime",
        "",
        "Usage:",
        "  slaude [start]        boot the Slack runtime (uses $SLAUDE_HOME or ./SOUL.md dir)",
        "  slaude sim [args...]  run the simulation gateway / REPL",
        "  slaude brain-server   run the brain engine as a standalone OAuth'd MCP process",
        "  slaude brain connect  OAuth-bootstrap the remote brain link (SLAUDE_BRAIN_URL)",
        "",
        "SLAUDE_HOME resolves to $SLAUDE_HOME, else the cwd if it has SOUL.md, else ~/.slaude.",
      ].join("\n"),
    );
    process.exit(0);
  default:
    entry = "src/server.ts";
    rest = argv;
}

const r = spawnSync("bun", [join(root, entry), ...rest], { stdio: "inherit", env });
process.exit(r.status ?? 1);
