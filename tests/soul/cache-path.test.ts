import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "../../src/config/home";
import { extractSoulData, soulCachePath, writeSoulCacheEntry } from "../../src/soul/extract";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { SoulDataSchema } from "../../src/soul/data";

const saved = process.env.SLAUDE_SOUL_CACHE_DIR;
const savedKey = process.env.SLAUDE_MASTER_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.SLAUDE_SOUL_CACHE_DIR;
  else process.env.SLAUDE_SOUL_CACHE_DIR = saved;
  if (savedKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
  else process.env.SLAUDE_MASTER_KEY = savedKey;
  __resetMasterKeyCache();
});
const withKey = (fill = 7) => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, fill).toString("base64");
  __resetMasterKeyCache();
};
const noKey = () => {
  delete process.env.SLAUDE_MASTER_KEY;
  __resetMasterKeyCache();
};

describe("soulCachePath", () => {
  test("without a master key, a plain seed written at soulCachePath(text) IS what extraction reads", async () => {
    noKey();
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

  // R41 (I1 residual): grounding alone lets a planted file swap roles between ids
  // the soul merely mentions. With a master key, an entry must carry a MAC only
  // the gateway (key holder) can make.
  const SOUL = () => `# Ana\nManager: <@UMGRGOOD01>\nBlocked: <@UMENTIONED1>\n${Math.random()}\n`;
  const extracted = { manager: { userId: "UMGRGOOD01" }, blockedUsers: ["UMENTIONED1"], approvers: [{ userId: "UMGRGOOD01", scope: "anything", catchall: true }] };

  test("with a master key, a grounded-but-unsigned planted entry is a miss (role swap refused)", async () => {
    withKey();
    const dir = mkdtempSync(join(tmpdir(), "soul-cache-"));
    process.env.SLAUDE_SOUL_CACHE_DIR = dir;
    const text = SOUL();
    // Every id is grounded, but the blocked user became manager and approver.
    writeFileSync(soulCachePath(text), JSON.stringify({
      manager: { userId: "UMENTIONED1" }, blockedUsers: [],
      approvers: [{ userId: "UMENTIONED1", scope: "anything", catchall: true }],
    }));
    let called = 0;
    const d = await extractSoulData(text, { strict: true, call: async () => { called++; return JSON.stringify(extracted); } });
    expect(called).toBe(1);
    expect(d.manager.userId).toBe("UMGRGOOD01");
  });

  test("with a master key, an entry written through writeSoulCacheEntry is a hit; a tampered one is a miss", async () => {
    withKey();
    const dir = mkdtempSync(join(tmpdir(), "soul-cache-"));
    process.env.SLAUDE_SOUL_CACHE_DIR = dir;
    const text = SOUL();
    writeSoulCacheEntry(text, SoulDataSchema.parse(extracted));
    const refuse = async () => { throw new Error("must not be called"); };
    expect((await extractSoulData(text, { strict: true, call: refuse })).manager.userId).toBe("UMGRGOOD01");

    const env = JSON.parse(readFileSync(soulCachePath(text), "utf8"));
    env.data.manager.userId = "UMENTIONED1";
    writeFileSync(soulCachePath(text), JSON.stringify(env));
    let called = 0;
    const d = await extractSoulData(text, { strict: true, call: async () => { called++; return JSON.stringify(extracted); } });
    expect(called).toBe(1);
    expect(d.manager.userId).toBe("UMGRGOOD01");
  });

  test("an entry signed under another master key is a miss", async () => {
    withKey(7);
    const dir = mkdtempSync(join(tmpdir(), "soul-cache-"));
    process.env.SLAUDE_SOUL_CACHE_DIR = dir;
    const text = SOUL();
    writeSoulCacheEntry(text, SoulDataSchema.parse(extracted));
    withKey(9);
    let called = 0;
    await extractSoulData(text, { strict: true, call: async () => { called++; return JSON.stringify(extracted); } });
    expect(called).toBe(1);
  });

  test("a fresh extraction under a master key writes a signed entry the next call hits", async () => {
    withKey();
    const dir = mkdtempSync(join(tmpdir(), "soul-cache-"));
    process.env.SLAUDE_SOUL_CACHE_DIR = dir;
    const text = SOUL();
    let called = 0;
    const call = async () => { called++; return JSON.stringify(extracted); };
    await extractSoulData(text, { strict: true, call });
    await extractSoulData(text, { strict: true, call });
    expect(called).toBe(1);
    expect(JSON.parse(readFileSync(soulCachePath(text), "utf8")).mac).toMatch(/^[0-9a-f]{64}$/);
  });
});
