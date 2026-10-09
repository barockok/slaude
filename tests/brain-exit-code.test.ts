/**
 * Opening an embedded PGLite must not change the host's exit code.
 *
 * PGLite is an Emscripten build: when its initdb program exits, the runtime's
 * quit handler writes the program's status into process.exitCode. A fresh
 * file-backed brain (gbrain's PGLite) leaves 99 there, so a process that
 * opened a brain exited 99 even when nothing failed — the "bun exits 99/100
 * with zero failures" the CI workflow had been tolerating.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeBrain, getBrain } from "../src/knowledge/brain";
import { openDb } from "../src/db/client";

const brainDir = mkdtempSync(join(tmpdir(), "slaude-brain-exitcode-"));
const savedHome = process.env.SLAUDE_BRAIN_HOME;
const savedCode = process.exitCode;

afterAll(async () => {
  await closeBrain();
  if (savedHome === undefined) delete process.env.SLAUDE_BRAIN_HOME;
  else process.env.SLAUDE_BRAIN_HOME = savedHome;
  rmSync(brainDir, { recursive: true, force: true });
  process.exitCode = savedCode ?? 0; // Bun ignores an undefined assignment
});

describe("embedded PGLite and process.exitCode", () => {
  test("booting a fresh file-backed brain leaves the exit code alone", async () => {
    await closeBrain();
    process.env.SLAUDE_BRAIN_HOME = brainDir;
    process.exitCode = 7;
    await getBrain();
    expect(process.exitCode).toBe(7);
    await closeBrain();
    expect(process.exitCode).toBe(7);
  }, 60_000);

  test("a process that boots a brain and sets no exit code exits 0", async () => {
    const home = mkdtempSync(join(tmpdir(), "slaude-brain-exitcode-proc-"));
    try {
      const brain = join(import.meta.dir, "../src/knowledge/brain.ts");
      const proc = Bun.spawn(
        ["bun", "-e", `const b = await import(${JSON.stringify(brain)}); await b.getBrain(); console.log("booted");`],
        { env: { ...process.env, SLAUDE_HOME: home, SLAUDE_BRAIN_HOME: join(home, "brain") }, stdout: "pipe", stderr: "pipe" },
      );
      const code = await proc.exited;
      expect(await new Response(proc.stdout).text()).toContain("booted");
      expect(code).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("opening and closing the slaude PGLite driver leaves the exit code alone", async () => {
    process.exitCode = 7;
    const c = await openDb({ dialect: "pg", driver: "pglite" });
    expect(process.exitCode).toBe(7);
    await c.close();
    expect(process.exitCode).toBe(7);
  }, 60_000);
});
