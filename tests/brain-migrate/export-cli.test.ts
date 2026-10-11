import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const run = async (args: string[]) => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "../../src/cli/brain-export.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

describe("brain-export CLI", () => {
  test("no args prints usage and exits 2", async () => {
    const r = await run([]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage: brain-export");
    expect(r.out).toBe("");
  });
  test("an unknown flag prints the error and usage and exits 2", async () => {
    const r = await run(["--bogus"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage: brain-export");
  });
  test("a failing export prints one line and exits 1, no stack", async () => {
    const r = await run(["--home", "/nonexistent-brain-home", "--out", "/tmp/never-written-bundle"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("export failed:");
    expect(r.err).not.toContain("    at ");
  });
});
