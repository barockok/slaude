// tests/scripts/package-release.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("package-release.sh emits a slim tarball + checksums", () => {
  const out = mkdtempSync(join(tmpdir(), "slrel-"));
  try {
    const version = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")).version;
    const r = spawnSync("bash", ["scripts/package-release.sh", out], { encoding: "utf8" });
    expect(r.status).toBe(0);

    const tar = join(out, `slaude-${version}.tar.gz`);
    expect(existsSync(tar)).toBe(true);
    expect(existsSync(join(out, "sha256sums.txt"))).toBe(true);

    // Lists members; assert curated subset present and tests/docs excluded.
    const list = spawnSync("tar", ["tzf", tar], { encoding: "utf8" }).stdout;
    expect(list).toContain(`slaude-${version}/package.json`);
    expect(list).toContain(`slaude-${version}/bun.lock`);
    expect(list).toContain(`slaude-${version}/bin/`);
    expect(list).toContain(`slaude-${version}/src/`);
    expect(list).toContain(`slaude-${version}/README.md`);
    expect(list).not.toContain(`${version}/tests/`);
    expect(list).not.toContain(`${version}/docs/`);
    expect(list).not.toContain("node_modules");

    const sums = readFileSync(join(out, "sha256sums.txt"), "utf8");
    expect(sums).toContain(`slaude-${version}.tar.gz`);
    expect(sums.trim().split(/\s+/)[0]).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
