/**
 * Box storage and its signed set (migrations 0055 to 0058), on a PGLite
 * database of its own: versions, the manifest, the integrity checks (a deleted
 * row, a replayed row, an edited row), the registry's fail-closed read, and
 * the session pin.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, openDb } from "../../src/db/client";
import { MIGRATIONS_DIR, loadMigrations, runMigrations } from "../../src/db/migrate";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { __resetGuardrailKeyForTests } from "../../src/guardrails/integrity";
import { parseBoxPayload } from "../../src/box/definition";
import { BoxIntegrityError, verifyBoxSet } from "../../src/box/integrity";
import { boxHighWater, boxHighWaterKey, checkBoxHighWater, raiseBoxHighWater } from "../../src/box/high-water";
import { highWater } from "../../src/guardrails/high-water";
import { __clearBoxesForTests, applyBoxes, boxSetVersion, boxTablesPresent, boxesChanged, pinSessionBoxOn, planBoxes, readBoxes, sessionBoxOn } from "../../src/db/boxes";
import { __resetBoxRegistryForTests, boxSnapshot, currentBox, loadBoxes, pinnedBox } from "../../src/gateway/core/box-registry";

const T = "default";
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const image = (c: string, repo = "ghcr.io/example/boxes/ruby-dev") => `${repo}@${digest(c)}`;
const box = (over: Record<string, unknown> = {}) => parseBoxPayload({ name: "ruby-dev", image: image("a"), ...over });

let db: DbClient;
let savedKey: string | undefined;

beforeAll(async () => {
  savedKey = process.env.SLAUDE_MASTER_KEY;
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  __resetGuardrailKeyForTests();
  db = await openDb({ dialect: "pg", driver: "pglite" });
  await runMigrations(db, { log: () => {} });
});
afterAll(async () => {
  await db.close();
  if (savedKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
  else process.env.SLAUDE_MASTER_KEY = savedKey;
  __resetMasterKeyCache();
  __resetGuardrailKeyForTests();
});
beforeEach(async () => {
  await __clearBoxesForTests(db);
  __resetBoxRegistryForTests();
});

const sync = (list: ReturnType<typeof box>[], now = 1000, tenant = T) => db.transaction((tx) => applyBoxes(tx, tenant, list, { by: "ci", now }));

describe("migration files 0055 to 0058", () => {
  test("one table per file, and the session columns follow the 0050 pattern", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((n) => /^005[5-8]_/.test(n)).sort();
    expect(files).toEqual(["0055_boxes.sql", "0056_box_versions.sql", "0057_boxes_manifest.sql", "0058_session_box.sql"]);
    const sql = readFileSync(join(MIGRATIONS_DIR, "0058_session_box.sql"), "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("--"));
    expect(sql).toEqual([
      "SET LOCAL lock_timeout = '2s';",
      "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS box_name TEXT;",
      "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS box_digest TEXT;",
    ]);
    for (const f of files.slice(0, 3)) {
      expect(readFileSync(join(MIGRATIONS_DIR, f), "utf8").match(/CREATE TABLE/g)).toHaveLength(1);
    }
  });

  test("they apply on top of 0054 and rerun as a no-op", async () => {
    const fresh = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      const all = loadMigrations();
      await runMigrations(fresh, { log: () => {}, migrations: all.filter((m) => m.version < "0055") });
      expect(await boxTablesPresent(fresh)).toBe(false);
      const r = await runMigrations(fresh, { log: () => {} });
      expect(r.applied).toEqual(expect.arrayContaining(["0055", "0056", "0057", "0058"]));
      expect(await boxTablesPresent(fresh)).toBe(true);
      expect((await runMigrations(fresh, { log: () => {} })).applied).toEqual([]);
    } finally {
      await fresh.close();
    }
  });

  test("sqlite has the two session columns and answers 'no boxes' without a table", async () => {
    const lite = await openDb({ dialect: "sqlite", path: ":memory:" });
    try {
      const cols = (await lite.query<{ name: string }>(`PRAGMA table_info(sessions)`)).map((r) => r.name);
      expect(cols).toEqual(expect.arrayContaining(["box_name", "box_digest"]));
      expect(await readBoxes(T, lite)).toEqual({ boxes: [], versions: [], manifest: null });
      expect(await boxSetVersion(T, lite)).toBe(0);
      expect(await boxTablesPresent(lite)).toBe(false);
      await __clearBoxesForTests(lite);
      expect((await loadBoxes(T, lite)).boxes.size).toBe(0);
    } finally {
      await lite.close();
    }
  });
});

describe("applyBoxes", () => {
  test("an empty set stays empty and unsigned", async () => {
    expect(await boxSetVersion(T, db)).toBe(0);
    const r = await sync([]);
    expect(boxesChanged(r)).toBe(false);
    expect(await boxSetVersion(T, db)).toBe(0);
    expect((await loadBoxes(T, db)).setVersion).toBe(0);
  });

  test("create, then an unchanged sync writes nothing", async () => {
    const r = await sync([box()]);
    expect(r.created).toEqual([{ name: "ruby-dev", version: 1, diff: ["new box"] }]);
    expect(await boxSetVersion(T, db)).toBe(1);
    const again = await sync([box()], 2000);
    expect(again).toEqual({ created: [], updated: [], unchanged: ["ruby-dev"], removed: [] });
    expect(await boxSetVersion(T, db)).toBe(1);
    const stored = await readBoxes(T, db);
    expect(stored.versions).toHaveLength(1);
    expect(stored.boxes[0]!.updatedAt).toBe(1000);
  });

  test("a new digest is a new version; the old version row stays", async () => {
    await sync([box()]);
    const r = await sync([box({ image: image("b") })], 2000);
    expect(r.updated).toEqual([{ name: "ruby-dev", version: 2, diff: ["image: new digest"] }]);
    const snap = await loadBoxes(T, db);
    const e = snap.boxes.get("ruby-dev")!;
    expect(e.versions.map((v) => [v.version, v.digest])).toEqual([[1, digest("a")], [2, digest("b")]]);
    expect(e.current.version).toBe(2);
    expect(snap.setVersion).toBe(2);
  });

  test("a policy-only change is a new version with the same digest", async () => {
    await sync([box()]);
    const r = await sync([box({ egress: { allow: ["pypi.org"] } })], 2000);
    expect(r.updated).toEqual([{ name: "ruby-dev", version: 2, diff: ["egress.allow: +pypi.org"] }]);
    const e = (await loadBoxes(T, db)).boxes.get("ruby-dev")!;
    expect(e.versions.map((v) => v.digest)).toEqual([digest("a"), digest("a")]);
    expect(e.current.policy.egress.allow).toEqual(["pypi.org"]);
  });

  test("a description-only change keeps the version; a moved repository is a new one", async () => {
    await sync([box()]);
    const d = await sync([box({ description: "Ruby toolchain" })], 2000);
    expect(d.updated).toEqual([{ name: "ruby-dev", version: 1, diff: ["description: changed"] }]);
    expect((await readBoxes(T, db)).versions).toHaveLength(1);
    expect((await loadBoxes(T, db)).boxes.get("ruby-dev")!.description).toBe("Ruby toolchain");
    const m = await sync([box({ description: "Ruby toolchain", image: image("a", "registry.example.com/team/ruby-dev") })], 3000);
    expect(m.updated).toEqual([{ name: "ruby-dev", version: 2, diff: ["image: new repository"] }]);
  });

  test("a forced version is recorded as forced", async () => {
    await sync([box()]);
    await sync([box({ image: image("b"), refresh: { force: true, note: "moved" } })], 2000);
    const e = (await loadBoxes(T, db)).boxes.get("ruby-dev")!;
    expect(e.versions.map((v) => v.forced)).toEqual([false, true]);
  });

  test("a box the set no longer lists is removed with its versions; re-creating it starts at 1 in a new set", async () => {
    await sync([box(), box({ name: "py-dev" })]);
    await sync([box({ image: image("b") }), box({ name: "py-dev" })], 2000);
    const r = await sync([box({ name: "py-dev" })], 3000);
    expect(r.removed).toEqual(["ruby-dev"]);
    const stored = await readBoxes(T, db);
    expect(stored.boxes.map((b) => b.name)).toEqual(["py-dev"]);
    expect(stored.versions.map((v) => v.name)).toEqual(["py-dev"]);
    const back = await sync([box(), box({ name: "py-dev" })], 4000);
    expect(back.created).toEqual([{ name: "ruby-dev", version: 1, diff: ["new box"] }]);
    expect(await boxSetVersion(T, db)).toBe(4);
  });

  test("tenants do not see each other's boxes", async () => {
    await sync([box()]);
    await sync([box({ name: "other" })], 1000, "t2");
    expect([...(await loadBoxes(T, db)).boxes.keys()]).toEqual(["ruby-dev"]);
    expect([...(await loadBoxes("t2", db)).boxes.keys()]).toEqual(["other"]);
  });

  test("planBoxes is what applyBoxes reports", async () => {
    await sync([box()]);
    const next = [box({ image: image("b") }), box({ name: "py-dev" })];
    const plan = planBoxes(await readBoxes(T, db), next);
    expect(await sync(next, 2000)).toEqual(plan);
  });
});

describe("integrity: the stored set fails closed", () => {
  const seed = async () => {
    await sync([box(), box({ name: "py-dev" })]);
    await sync([box({ image: image("b") }), box({ name: "py-dev" })], 2000);
  };
  const reason = async () => {
    try {
      verifyBoxSet(T, await readBoxes(T, db));
    } catch (e) {
      expect(e).toBeInstanceOf(BoxIntegrityError);
      return (e as BoxIntegrityError).reason;
    }
    return null;
  };

  test("an untouched set verifies", async () => {
    await seed();
    expect(await reason()).toBeNull();
  });

  test("a deleted box row", async () => {
    await seed();
    await db.run(`DELETE FROM boxes WHERE name = 'py-dev'`);
    expect(await reason()).toMatch(/box 'py-dev' is in the manifest but missing/);
  });

  test("a deleted version row", async () => {
    await seed();
    await db.run(`DELETE FROM box_versions WHERE name = 'ruby-dev' AND version = 1`);
    expect(await reason()).toMatch(/box 'ruby-dev' version 1 is in the manifest but missing/);
  });

  test("a deleted manifest, with rows left behind", async () => {
    await seed();
    await db.run(`DELETE FROM boxes_manifest`);
    expect(await reason()).toMatch(/box rows exist but the manifest is missing/);
  });

  test("an edited digest", async () => {
    await seed();
    await db.run(`UPDATE box_versions SET digest = ?, image = ? WHERE name = 'ruby-dev' AND version = 2`, [digest("c"), image("c")]);
    expect(await reason()).toMatch(/box 'ruby-dev' version 2 signature does not verify/);
  });

  test("an edited policy (a widened allowlist)", async () => {
    await seed();
    const row = await db.one<{ policy: string }>(`SELECT policy FROM box_versions WHERE name = 'py-dev'`);
    const policy = JSON.parse(row!.policy);
    policy.egress.allow = ["attacker.example.com"];
    await db.run(`UPDATE box_versions SET policy = ? WHERE name = 'py-dev'`, [JSON.stringify(policy)]);
    expect(await reason()).toMatch(/box 'py-dev' version 1 signature does not verify/);
  });

  test("a box row pointed back at an older version (a replayed row)", async () => {
    await seed();
    const old = await (async () => {
      await __clearBoxesForTests(db);
      await sync([box(), box({ name: "py-dev" })]);
      const row = await db.one<Record<string, unknown>>(`SELECT * FROM boxes WHERE name = 'ruby-dev'`);
      await sync([box({ image: image("b") }), box({ name: "py-dev" })], 2000);
      return row!;
    })();
    // The version 1 box row, with its own valid signature, put back in place of version 2's.
    await db.run(`UPDATE boxes SET version = ?, set_version = ?, hmac = ? WHERE name = 'ruby-dev'`, [old.version, old.set_version, old.hmac]);
    expect(await reason()).toMatch(/box 'ruby-dev' does not match the manifest's version/);
  });

  test("a version row of a deleted box replayed into its re-created namesake", async () => {
    await sync([box()]);
    const old = await db.one<Record<string, unknown>>(`SELECT * FROM box_versions WHERE name = 'ruby-dev'`);
    await sync([]);
    await sync([box({ image: image("b") })], 3000);
    await db.run(`UPDATE box_versions SET image = ?, digest = ?, policy = ?, set_version = ?, hmac = ? WHERE name = 'ruby-dev'`, [
      old!.image, old!.digest, old!.policy, old!.set_version, old!.hmac,
    ]);
    expect(await reason()).toMatch(/box 'ruby-dev' version 1 does not match the manifest/);
  });

  test("an extra row the manifest does not list", async () => {
    await seed();
    await db.run(`INSERT INTO boxes (tenant_id, name, description, version, set_version, hmac, updated_at, updated_by) VALUES ('default', 'sneaky', '', 1, 2, 'x', 1, 'x')`);
    expect(await reason()).toMatch(/box 'sneaky' is not in the manifest/);
  });

  test("an extra version row, and a tampered manifest", async () => {
    await seed();
    await db.run(`INSERT INTO box_versions (tenant_id, name, version, image, digest, policy, forced, set_version, hmac, created_at, created_by) VALUES ('default', 'py-dev', 9, 'x', 'x', '{}', false, 2, 'x', 1, 'x')`);
    expect(await reason()).toMatch(/box 'py-dev' version 9 is not in the manifest/);
    await db.run(`DELETE FROM box_versions WHERE version = 9`);
    await db.run(`UPDATE boxes_manifest SET entries = '{"boxes":[],"versions":[]}'`);
    expect(await reason()).toMatch(/the manifest signature does not verify/);
    await db.run(`UPDATE boxes_manifest SET entries = 'not json'`);
    expect(await reason()).toMatch(/the manifest entries are not readable/);
  });

  test("a set signed for another tenant does not verify here", async () => {
    await seed();
    await db.run(`UPDATE boxes SET tenant_id = 't9'`);
    await db.run(`UPDATE box_versions SET tenant_id = 't9'`);
    await db.run(`UPDATE boxes_manifest SET tenant_id = 't9'`);
    await expect(loadBoxes("t9", db)).rejects.toBeInstanceOf(BoxIntegrityError);
  });

  test("a write refuses a set that does not verify, and changes nothing", async () => {
    await seed();
    await db.run(`UPDATE box_versions SET digest = ? WHERE name = 'ruby-dev' AND version = 2`, [digest("c")]);
    await expect(sync([box({ image: image("d") })], 3000)).rejects.toBeInstanceOf(BoxIntegrityError);
    expect(await boxSetVersion(T, db)).toBe(2);
    expect((await readBoxes(T, db)).versions).toHaveLength(3);
  });

  test("the registry serves nothing from a set that does not verify, cached or not", async () => {
    await seed();
    expect((await currentBox(T, "ruby-dev", db))!.digest).toBe(digest("b"));
    await db.run(`DELETE FROM box_versions WHERE name = 'ruby-dev' AND version = 1`);
    await db.run(`UPDATE boxes_manifest SET version = version + 1`);
    await expect(currentBox(T, "ruby-dev", db)).rejects.toBeInstanceOf(BoxIntegrityError);
    await expect(boxSnapshot(T, db)).rejects.toBeInstanceOf(BoxIntegrityError);
  });

  test("a stored policy that is not JSON is refused even when signed", async () => {
    await seed();
    __resetBoxRegistryForTests();
    const real = JSON.parse;
    // Only the registry's own parse of the policy text is made to fail.
    JSON.parse = ((s: string, ...rest: []) => {
      if (typeof s === "string" && s.startsWith('{"tier"')) throw new SyntaxError("bad");
      return real(s, ...rest);
    }) as typeof JSON.parse;
    try {
      await expect(loadBoxes(T, db)).rejects.toThrow(/holds a policy that is not readable/);
    } finally {
      JSON.parse = real;
    }
  });
});

describe("high-water mark: an older signed set does not replace a newer one", () => {
  const TABLES = ["boxes", "box_versions", "boxes_manifest"] as const;
  /** Every row of the three tables, as stored: a database backup of the box set. */
  const backup = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await db.query<Record<string, unknown>>(`SELECT * FROM ${t}`)] as const)));
  const restore = async (b: Awaited<ReturnType<typeof backup>>) => {
    for (const t of ["box_versions", "boxes", "boxes_manifest"]) await db.run(`DELETE FROM ${t}`);
    for (const t of TABLES) {
      for (const row of b[t]!) {
        const cols = Object.keys(row);
        await db.run(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => row[c]));
      }
    }
  };

  test("the mark is the box set's own: it never reads or moves the guardrail mark", async () => {
    await raiseBoxHighWater(T, 5);
    expect(await boxHighWater(T)).toBe(5);
    expect(await highWater(T)).toBe(0);
    expect(boxHighWaterKey(T)).not.toBe(T);
    await raiseBoxHighWater(T, 3);
    expect(await boxHighWater(T)).toBe(5);
    await expect(checkBoxHighWater(T, 5)).resolves.toBeUndefined();
    await expect(checkBoxHighWater(T, 4)).rejects.toThrow(/older than version 5 seen before \(rolled back\)/);
    await expect(checkBoxHighWater(T, 0)).rejects.toThrow(/gone, but version 5 was seen before \(deleted\)/);
  });

  test("a read raises the mark; the older set, restored whole, verifies on its own and is refused", async () => {
    await sync([box()]);
    const old = await backup();
    await sync([box({ image: image("b") })], 2000);
    expect((await currentBox(T, "ruby-dev", db))!.digest).toBe(digest("b"));
    expect(await boxHighWater(T)).toBe(2);

    await restore(old);
    // The signatures are all valid: only the mark knows this set is old.
    expect(verifyBoxSet(T, await readBoxes(T, db))).toBe(1);
    await expect(loadBoxes(T, db)).rejects.toThrow(/older than version 2 seen before/);
    await expect(boxSnapshot(T, db)).rejects.toBeInstanceOf(BoxIntegrityError);
    await expect(currentBox(T, "ruby-dev", db)).rejects.toBeInstanceOf(BoxIntegrityError);
    await expect(pinnedBox(T, "ruby-dev", digest("a"), db)).rejects.toBeInstanceOf(BoxIntegrityError);
  });

  test("a write does not re-sign a rolled back set", async () => {
    await sync([box()]);
    const old = await backup();
    await sync([box({ image: image("b") })], 2000);
    await loadBoxes(T, db);
    await restore(old);
    await expect(sync([box({ image: image("c") })], 3000)).rejects.toThrow(/rolled back/);
    expect(await boxSetVersion(T, db)).toBe(1);
    expect((await readBoxes(T, db)).versions).toHaveLength(1);
  });

  test("a deleted set is refused, not read as 'no boxes'", async () => {
    await sync([box()]);
    await loadBoxes(T, db);
    for (const t of ["box_versions", "boxes", "boxes_manifest"]) await db.run(`DELETE FROM ${t}`);
    await expect(loadBoxes(T, db)).rejects.toThrow(/gone, but version 1 was seen before/);
    await expect(sync([box()], 2000)).rejects.toBeInstanceOf(BoxIntegrityError);
  });

  test("a set at or above the mark is served, and removing every box is not a deletion", async () => {
    await sync([box()]);
    await loadBoxes(T, db);
    await sync([], 2000);
    const snap = await loadBoxes(T, db);
    expect(snap.setVersion).toBe(2);
    expect(snap.boxes.size).toBe(0);
  });
});

describe("registry", () => {
  test("the snapshot is cached until the set version moves", async () => {
    await sync([box()]);
    const a = await boxSnapshot(T, db);
    expect(await boxSnapshot(T, db)).toBe(a);
    await sync([box({ image: image("b") })], 2000);
    const b = await boxSnapshot(T, db);
    expect(b).not.toBe(a);
    expect(b.boxes.get("ruby-dev")!.current.digest).toBe(digest("b"));
    expect(await currentBox(T, "nope", db)).toBeNull();
  });

  test("a pinned session keeps its digest and gets the current policy", async () => {
    await sync([box()]);
    await sync([box({ image: image("b") })], 2000);
    await sync([box({ image: image("b"), egress: { allow: ["pypi.org"] } })], 3000);
    const p = await pinnedBox(T, "ruby-dev", digest("a"), db);
    expect(p!.digest).toBe(digest("a"));
    expect(p!.image).toBe(image("a"));
    expect(p!.version).toBe(1);
    expect(p!.policy.egress.allow).toEqual(["pypi.org"]);
    expect(p!.stale).toBe(false);
    expect(await pinnedBox(T, "ruby-dev", digest("z"), db)).toBeNull();
    expect(await pinnedBox(T, "gone", digest("a"), db)).toBeNull();
  });

  test("a forced newer version with another digest marks an older pin stale", async () => {
    await sync([box()]);
    await sync([box({ image: image("b"), refresh: { force: true } })], 2000);
    expect((await pinnedBox(T, "ruby-dev", digest("a"), db))!.stale).toBe(true);
    expect((await pinnedBox(T, "ruby-dev", digest("b"), db))!.stale).toBe(false);
  });
});

describe("session pin", () => {
  const session = (id: string) =>
    db.run(
      `INSERT INTO sessions (id, created_at, updated_at, model, working_dir, slack_team_id, slack_channel_id, slack_thread_ts) VALUES (?, 1, 1, 'm', '/w', 'T0EXAMPLE', 'C0EXAMPLE', ?)`,
      [id, `${id}.1`],
    );
  afterAll(async () => {
    await db.run(`DELETE FROM sessions WHERE id LIKE 'box-pin-%'`);
  });

  test("pinned once, and a second pin reads back the first", async () => {
    await session("box-pin-1");
    expect(await sessionBoxOn(db, "box-pin-1")).toBeNull();
    expect(await pinSessionBoxOn(db, "box-pin-1", { name: "ruby-dev", digest: digest("a") })).toEqual({ name: "ruby-dev", digest: digest("a"), pinned: true });
    expect(await pinSessionBoxOn(db, "box-pin-1", { name: "ruby-dev", digest: digest("b") })).toEqual({ name: "ruby-dev", digest: digest("a"), pinned: false });
    expect(await sessionBoxOn(db, "box-pin-1")).toEqual({ name: "ruby-dev", digest: digest("a") });
  });

  test("two pins at once agree on one digest", async () => {
    await session("box-pin-2");
    const [x, y] = await Promise.all([
      pinSessionBoxOn(db, "box-pin-2", { name: "ruby-dev", digest: digest("a") }),
      pinSessionBoxOn(db, "box-pin-2", { name: "ruby-dev", digest: digest("b") }),
    ]);
    expect(x!.digest).toBe(y!.digest);
    expect([x!.pinned, y!.pinned].filter(Boolean)).toHaveLength(1);
  });

  test("a session that does not exist pins nothing", async () => {
    expect(await pinSessionBoxOn(db, "box-pin-missing", { name: "ruby-dev", digest: digest("a") })).toBeNull();
  });
});
