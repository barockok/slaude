import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TOOLS_SURVIVING_EMPTY_SET } from "../../src/agent/child-env";

/**
 * WS-D D5.2: the gateway's own model children read untrusted content (KB pages,
 * raw ingest files), so they must not be handed Bash. These assertions run on
 * the argv the REAL SDK builds for the CLI (see the fixture), not on our option
 * objects: `allowedTools: []` looked like "no tools" in an options object while
 * the SDK passed no tool restriction at all and `--permission-mode
 * bypassPermissions`, and a live run executed Bash.
 */
async function captureArgv(): Promise<{ think: string[]; ingest: string[] }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "model-child-argv.fixture.ts")],
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`fixture exited ${code}: ${err}`);
  return JSON.parse(out.trim().split("\n").pop()!);
}

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};

describe("gateway model children: tool lockdown (argv the SDK passes the CLI)", async () => {
  const argv = await captureArgv();

  test("kb_think synthesis disables every built-in tool", () => {
    expect(argv.think).toContain("--tools");
    expect(flag(argv.think, "--tools")).toBe("");
  });

  test("tools the CLI keeps under an explicit set are disallowed too", () => {
    for (const a of [argv.think, argv.ingest]) {
      expect((flag(a, "--disallowedTools") ?? "").split(",")).toEqual([...TOOLS_SURVIVING_EMPTY_SET]);
    }
  });

  test("kb_think synthesis runs in a non-bypass permission mode that denies anything unapproved", () => {
    expect(argv.think).not.toContain("bypassPermissions");
    expect(argv.think).not.toContain("--allow-dangerously-skip-permissions");
    expect(flag(argv.think, "--permission-mode")).toBe("dontAsk");
  });

  test("kb_think synthesis loads no MCP servers or settings-borne tools", () => {
    expect(argv.think).toContain("--strict-mcp-config");
    expect(argv.think).not.toContain("--mcp-config");
    expect(argv.think).toContain("--setting-sources=");
  });

  test("ingest gets file tools only: no shell, no web, no subagents", () => {
    const tools = (flag(argv.ingest, "--tools") ?? "default").split(",");
    expect(tools).not.toContain("default");
    for (const t of ["Bash", "WebFetch", "WebSearch", "Task", "Agent"]) expect(tools).not.toContain(t);
    expect(tools).toEqual(expect.arrayContaining(["Read", "Write", "Edit"]));
  });

  test("ingest runs in a non-bypass permission mode with no MCP servers", () => {
    expect(argv.ingest).not.toContain("bypassPermissions");
    expect(argv.ingest).not.toContain("--allow-dangerously-skip-permissions");
    expect(flag(argv.ingest, "--permission-mode")).toBe("acceptEdits");
    expect(argv.ingest).toContain("--strict-mcp-config");
    expect(argv.ingest).toContain("--setting-sources=");
  });
});
