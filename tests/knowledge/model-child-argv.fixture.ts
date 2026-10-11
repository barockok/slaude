/**
 * Run in a separate process by model-child-lockdown.test.ts, so a
 * `mock.module("@anthropic-ai/claude-agent-sdk")` in another test file cannot
 * replace the real SDK here. Each gateway-side model child is driven through
 * the REAL `query()` with `pathToClaudeCodeExecutable` pointed at a stub that
 * records its argv; prints `{ think: string[], ingest: string[] }`.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";

const dir = mkdtempSync(join(tmpdir(), "slaude-argv-"));
process.env.SLAUDE_HOME ??= dir;
process.env.CLAUDE_CONFIG_DIR ??= join(dir, ".claude");

function stub(name: string): { path: string; argv: () => string[] } {
  const out = join(dir, `${name}.argv`);
  const path = join(dir, `${name}.sh`);
  // NUL-separated so an empty argument (`--tools ""`) survives intact.
  writeFileSync(path, `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > '${out}'\nexit 0\n`);
  chmodSync(path, 0o755);
  return { path, argv: () => readFileSync(out, "utf8").split("\0").slice(0, -1) };
}

function runnerFor(exe: string): typeof realQuery {
  return ((args: Parameters<typeof realQuery>[0]) =>
    realQuery({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: exe } })) as typeof realQuery;
}

async function swallow(p: Promise<unknown>): Promise<void> {
  // The stub exits without speaking the stream protocol; only argv matters.
  try { await p; } catch { /* expected */ }
}

const { sdkThinkClient } = await import("../../src/knowledge/brain-think");
const { defaultRunSubQuery } = await import("../../src/knowledge/ingest");

const think = stub("think");
await swallow(sdkThinkClient(runnerFor(think.path)).create({ system: "s", messages: [{ role: "user", content: "q" }] }));

const ingest = stub("ingest");
const kbDir = join(dir, "kb");
mkdirSync(kbDir, { recursive: true });
await swallow(defaultRunSubQuery({ kbDir, readme: "# schema", rawFiles: [] }, runnerFor(ingest.path)));

console.log(JSON.stringify({ think: think.argv(), ingest: ingest.argv() }));
process.exit(0);
