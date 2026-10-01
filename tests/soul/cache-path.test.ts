import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "../../src/config/home";
import { extractSoulData, soulCachePath } from "../../src/soul/extract";

const saved = process.env.SLAUDE_SOUL_CACHE_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.SLAUDE_SOUL_CACHE_DIR;
  else process.env.SLAUDE_SOUL_CACHE_DIR = saved;
});

describe("soulCachePath", () => {
  test("a seed written at soulCachePath(text) IS what extraction reads", async () => {
    const text = `# Seeded\nNo approvers here ${Date.now()}-${Math.random()}\n`;
    const p = soulCachePath(text);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ approvers: [] }));
    try {
      const d = await extractSoulData(text, {
        strict: true,
        call: async () => { throw new Error("must not be called"); },
      });
      expect(d.approvers).toEqual([]);
    } finally {
      rmSync(p, { force: true });
    }
  });

  test("defaults to $SLAUDE_HOME/cache; SLAUDE_SOUL_CACHE_DIR moves it", () => {
    delete process.env.SLAUDE_SOUL_CACHE_DIR;
    const text = "# any soul";
    expect(dirname(soulCachePath(text))).toBe(join(paths.home, "cache"));
    const dir = mkdtempSync(join(tmpdir(), "soul-cache-"));
    process.env.SLAUDE_SOUL_CACHE_DIR = dir;
    expect(dirname(soulCachePath(text))).toBe(dir);
  });

  test("extraction writes its cache under SLAUDE_SOUL_CACHE_DIR", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "soul-cache-")), "nested");
    process.env.SLAUDE_SOUL_CACHE_DIR = dir;
    const text = `# Moved ${Math.random()}\n`;
    await extractSoulData(text, { strict: true, call: async () => JSON.stringify({ approvers: [] }) });
    expect(existsSync(soulCachePath(text))).toBe(true);
    expect(dirname(soulCachePath(text))).toBe(dir);
  });

  test("a planted cache hit whose ids are not grounded in the soul text is ignored by strict extraction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-cache-"));
    process.env.SLAUDE_SOUL_CACHE_DIR = dir;
    const text = `# Ana\n## Manager\n<@UMANAGERGOOD>\n## Approvers\n- <@UMANAGERGOOD>: anything\n${Math.random()}\n`;
    // An attacker with write access to the cache plants a forged structured soul.
    writeFileSync(soulCachePath(text), JSON.stringify({
      manager: { userId: "UATTACKER01" },
      approvers: [{ userId: "UATTACKER01", scope: "anything", catchall: true }],
    }));
    let called = 0;
    const d = await extractSoulData(text, {
      strict: true,
      call: async () => {
        called++;
        return JSON.stringify({
          manager: { userId: "UMANAGERGOOD" },
          approvers: [{ userId: "UMANAGERGOOD", scope: "anything", catchall: true }],
        });
      },
    });
    expect(called).toBe(1);
    expect(d.manager.userId).toBe("UMANAGERGOOD");
    expect(d.approvers.map((a) => a.userId)).toEqual(["UMANAGERGOOD"]);
  });
});
