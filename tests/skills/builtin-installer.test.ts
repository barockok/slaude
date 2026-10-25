import { describe, expect, test } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("installer refuses built-in skill names", () => {
  test("a manifest entry named like a built-in is skipped; others install", () => {
    const root = mkdtempSync(join(tmpdir(), "inst-"));
    try {
      const repo = join(root, "repo");
      for (const slug of ["skill-authoring", "ordinary-one"]) {
        mkdirSync(join(repo, slug), { recursive: true });
        writeFileSync(join(repo, slug, "SKILL.md"), "---\nname: x\n---\nbody\n");
      }
      execSync(
        "git init -q -b main && git add -A && git -c user.email=a@b.c -c user.name=t commit -q -m init",
        { cwd: repo },
      );
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "slaude.json"),
        JSON.stringify({
          skills: ["skill-authoring", "ordinary-one"].map((s) => ({ git: repo, ref: "main", path: s, slug: s })),
        }),
      );
      const r = spawnSync("bun", ["src/cli/install.ts"], {
        cwd: join(import.meta.dir, "..", ".."),
        env: { ...process.env, SLAUDE_HOME: home },
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stderr + r.stdout).toContain(
        "`skill-authoring` is a built-in skill and cannot be changed at runtime",
      );
      expect(existsSync(join(home, "skills", "skill-authoring"))).toBe(false);
      expect(existsSync(join(home, "skills", "ordinary-one", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
