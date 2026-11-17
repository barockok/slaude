import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/client";
import {
  __clearGuardrailsForTests, __setOverrideForTests, applyGuardrailChange, guardrailRevision, manifestVersion, readGuardrails, sha256, StaleGuardrailError, UnknownGuardrailError,
} from "../../src/db/guardrails";
import { GuardrailIntegrityError, GuardrailKeyError, verifySet, guardrailKey, peekKeySource, __resetGuardrailKeyForTests, HMAC_KEY_FILE, GUARDRAILS_DIR } from "../../src/guardrails/integrity";
import { HIGH_WATER_FILE, highWater, raiseHighWater, setHighWaterRedis, __resetHighWaterForTests } from "../../src/guardrails/high-water";
import {
  __resetGuardrailSnapshotsForTests, cachedGuardrails, currentGuardrails, docsFromStored, guardrailsFailure, GuardrailsUnavailableError,
  loadTenantSnapshot, onGuardrailsChanged, refreshGuardrails,
} from "../../src/guardrails/snapshot";
import { flushAudits } from "../../src/audit/emit";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { paths } from "../../src/config/home";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { ensureGuardrailKeyForPg } from "./helpers";

ensureGuardrailKeyForPg();

const gmd = (slug: string, extra = "", body = "Be kind.") => `---\nname: ${slug}\ndescription: d\n${extra}---\n${body}\n`;
const pgOnly = db.dialect === "pg";
const tenantSql = pgOnly ? " AND tenant_id = 'default'" : "";

beforeEach(async () => {
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
});

describe("storage", () => {
  test("writes are one signed set; an unchanged write moves nothing", async () => {
    const r1 = await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a"), source: "file" }, { slug: "b", md: gmd("b"), source: "file" }], by: "cli:test" });
    expect(r1).toMatchObject({ version: 1, created: ["a", "b"], updated: [], unchanged: [] });
    const r2 = await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a"), source: "file" }], by: "cli:test" });
    expect(r2).toMatchObject({ version: 1, unchanged: ["a"] });
    const r3 = await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a", "", "Changed."), source: "file" }], by: "cli:test" });
    expect(r3).toMatchObject({ version: 2, updated: ["a"] });
    const s = await readGuardrails();
    expect(s.rows.map((r) => [r.slug, r.version, r.enabled, r.sha === sha256(r.md)])).toEqual([["a", 2, true, true], ["b", 1, true, true]]);
    expect(verifySet("default", s)).toBe(2);
    expect(await manifestVersion()).toBe(2);
  });

  test("the kill switch is kept across a text change; removing drops overrides too", async () => {
    await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a"), source: "git" }], by: "pipeline" });
    expect((await applyGuardrailChange("default", { setEnabled: [{ slug: "a", enabled: false }], by: "op" })).toggled).toEqual(["a"]);
    expect((await applyGuardrailChange("default", { setEnabled: [{ slug: "a", enabled: false }], by: "op" })).toggled).toEqual([]);
    await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a", "", "v2"), source: "git" }], by: "pipeline" });
    expect((await readGuardrails()).rows[0]!.enabled).toBe(false);
    await expect(applyGuardrailChange("default", { setEnabled: [{ slug: "zz", enabled: true }], by: "op" })).rejects.toBeInstanceOf(UnknownGuardrailError);
    await __setOverrideForTests("default", { slug: "a", md: gmd("a", "", "mine"), baseSha: "old", author: "op" });
    expect(verifySet("default", await readGuardrails())).toBeGreaterThan(0);
    const rm = await applyGuardrailChange("default", { remove: ["a", "missing"], by: "pipeline" });
    expect(rm.removed).toEqual(["a"]);
    const s = await readGuardrails();
    expect(s.rows).toEqual([]);
    expect(s.overrides).toEqual([]);
    expect(verifySet("default", s)).toBe(rm.version);
  });

  test("an empty store verifies as the empty set", async () => {
    expect(verifySet("default", await readGuardrails())).toBe(0);
    expect((await loadTenantSnapshot("default")).resolved).toEqual([]);
  });
});

describe("integrity: the set, not only the rows", () => {
  beforeEach(async () => {
    await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a"), source: "file" }, { slug: "b", md: gmd("b"), source: "file" }], by: "cli" });
  });

  test("a deleted row fails closed", async () => {
    await db.run(`DELETE FROM guardrails WHERE slug = 'b'${tenantSql}`);
    await expect(loadTenantSnapshot("default")).rejects.toThrow(/'b' is in the manifest but missing/);
  });

  test("a replayed older row fails closed", async () => {
    const old = (await readGuardrails()).rows.find((r) => r.slug === "a")!;
    await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a", "", "Stricter now."), source: "file" }], by: "cli" });
    // Put the old row back exactly as it was signed then.
    await db.run(`UPDATE guardrails SET md = ?, sha = ?, version = ?, hmac = ? WHERE slug = 'a'${tenantSql}`, [old.md, old.sha, old.version, old.hmac]);
    await expect(loadTenantSnapshot("default")).rejects.toThrow(/'a' does not match the manifest's version/);
  });

  test("an unlisted row fails closed", async () => {
    const a = (await readGuardrails()).rows[0]!;
    const cols = pgOnly ? "tenant_id, " : "";
    await db.run(
      `INSERT INTO guardrails (${cols}slug, md, sha, source, version, enabled, hmac, updated_at, updated_by) VALUES (${pgOnly ? "'default', " : ""}'c', ?, ?, 'file', ?, ?, ?, 0, 'x')`,
      [a.md, a.sha, a.version, pgOnly ? true : 1, a.hmac],
    );
    await expect(loadTenantSnapshot("default")).rejects.toThrow(/'c' is not in the manifest/);
  });

  test("an edited row, a flipped kill switch, a forged or missing manifest fail closed", async () => {
    await db.run(`UPDATE guardrails SET md = 'tampered' WHERE slug = 'a'${tenantSql}`);
    await expect(loadTenantSnapshot("default")).rejects.toThrow(/'a' signature does not verify/);
    await db.run(`UPDATE guardrails SET md = ? WHERE slug = 'a'${tenantSql}`, [gmd("a")]);
    await db.run(`UPDATE guardrails SET enabled = ? WHERE slug = 'a'${tenantSql}`, [pgOnly ? false : 0]);
    await expect(loadTenantSnapshot("default")).rejects.toThrow(/does not match the manifest/);
    await db.run(`UPDATE guardrails SET enabled = ? WHERE slug = 'a'${tenantSql}`, [pgOnly ? true : 1]);
    await db.run(`UPDATE guardrails_manifest SET entries = ?`, [JSON.stringify({ rows: [], overrides: [] })]);
    await expect(loadTenantSnapshot("default")).rejects.toThrow(/manifest signature/);
    await db.run(`UPDATE guardrails_manifest SET entries = 'not json'`);
    await expect(loadTenantSnapshot("default")).rejects.toThrow(/not readable/);
    await db.run(`DELETE FROM guardrails_manifest`);
    await expect(loadTenantSnapshot("default")).rejects.toThrow(/manifest is missing/);
  });

  test("an override: listed and signed, or it fails closed", async () => {
    await __setOverrideForTests("default", { slug: "a", md: gmd("a", "", "Override."), baseSha: sha256(gmd("a")), author: "op" });
    const ok = await loadTenantSnapshot("default");
    expect(ok.resolved.find((g) => g.slug === "a")!.prose).toBe("Override.");
    await db.run(`UPDATE guardrail_overrides SET md = 'x'`);
    await expect(loadTenantSnapshot("default")).rejects.toThrow(/override 'a' signature/);
    await db.run(`UPDATE guardrail_overrides SET version = 1`);
    await expect(loadTenantSnapshot("default")).rejects.toThrow(/override 'a' does not match/);
    await db.run(`DELETE FROM guardrail_overrides`);
    await expect(loadTenantSnapshot("default")).rejects.toThrow(/override 'a' is in the manifest but missing/);
  });

  test("an override row the manifest does not list fails closed", async () => {
    const s = await readGuardrails();
    const forged = { ...s, overrides: [{ slug: "a", md: "x", baseSha: "y", version: 1, author: "z", hmac: "h", updatedAt: 0 }] };
    expect(() => verifySet("default", forged)).toThrow(/override 'a' is not in the manifest/);
    expect(() => verifySet("other-tenant", s)).toThrow(GuardrailIntegrityError);
  });
});

describe("overrides and the behind-source flag", () => {
  test("an override wins; behind source when the source text moved since it was written", async () => {
    await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a"), source: "git" }], by: "pipeline" });
    await __setOverrideForTests("default", { slug: "a", md: gmd("a", "", "Mine."), baseSha: sha256(gmd("a")), author: "op" });
    let docs = docsFromStored(await readGuardrails());
    expect(docs[0]).toMatchObject({ override: true, behindSource: false });
    // A sync keeps the override and flags it.
    await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a", "", "Source moved."), source: "git" }], by: "pipeline" });
    docs = docsFromStored(await readGuardrails());
    expect(docs[0]).toMatchObject({ override: true, behindSource: true });
    expect(docs[0]!.md).toContain("Mine.");
    expect(verifySet("default", await readGuardrails())).toBeGreaterThan(0);
  });

  test("a console override through applyGuardrailChange: signed, in the manifest, base_sha the source's; clear drops it", async () => {
    await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a"), source: "git" }], by: "pipeline" });
    const set = await applyGuardrailChange("default", { setOverride: [{ slug: "a", md: gmd("a", "", "Mine.") }], by: "lead@example.com" });
    expect(set).toMatchObject({ version: 2, overrideSet: ["a"], overrideCleared: [] });
    let s = await readGuardrails();
    expect(s.overrides).toMatchObject([{ slug: "a", baseSha: sha256(gmd("a")), version: 2, author: "lead@example.com" }]);
    expect(verifySet("default", s)).toBe(2);
    expect(guardrailRevision(s.rows[0], s.overrides[0])).toBe(2);
    // The same text again changes nothing; a new text replaces it.
    expect((await applyGuardrailChange("default", { setOverride: [{ slug: "a", md: gmd("a", "", "Mine.") }], by: "op" })).version).toBe(2);
    expect((await applyGuardrailChange("default", { setOverride: [{ slug: "a", md: gmd("a", "", "Mine 2.") }], by: "op" })).version).toBe(3);
    const cleared = await applyGuardrailChange("default", { clearOverride: ["a"], by: "op" });
    expect(cleared).toMatchObject({ version: 4, overrideCleared: ["a"] });
    s = await readGuardrails();
    expect(s.overrides).toEqual([]);
    expect(verifySet("default", s)).toBe(4);
    // The source row is re-signed at the clearing version: the revision only goes up.
    expect(s.rows[0]).toMatchObject({ version: 4, md: gmd("a") });
    expect(guardrailRevision(s.rows[0], undefined)).toBe(4);
    // Clearing nothing writes nothing; an unknown guardrail is refused.
    expect((await applyGuardrailChange("default", { clearOverride: ["a"], by: "op" })).version).toBe(4);
    await expect(applyGuardrailChange("default", { setOverride: [{ slug: "zz", md: gmd("zz") }], by: "op" })).rejects.toBeInstanceOf(UnknownGuardrailError);
    await expect(applyGuardrailChange("default", { clearOverride: ["zz"], by: "op" })).rejects.toBeInstanceOf(UnknownGuardrailError);
  });

  test("a write against a stale revision is refused inside the transaction and writes nothing", async () => {
    await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a"), source: "console" }], by: "op" });
    await expect(applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a", "", "x"), source: "console" }], expect: [{ slug: "a", revision: 0 }], by: "op" }))
      .rejects.toBeInstanceOf(StaleGuardrailError);
    await expect(applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a"), source: "console" }], expect: [{ slug: "a", revision: null }], by: "op" }))
      .rejects.toThrow(/already exists/);
    await expect(applyGuardrailChange("default", { remove: ["b"], expect: [{ slug: "b", revision: 1 }], by: "op" })).rejects.toThrow(/no longer exists/);
    expect(await manifestVersion()).toBe(1);
    const ok = await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a", "", "x"), source: "console" }], expect: [{ slug: "a", revision: 1 }], by: "op" });
    expect(ok.version).toBe(2);
  });
});

describe("the snapshot", () => {
  test("loads, caches, refreshes on a version change and tells listeners", async () => {
    const seen: Array<number | null> = [];
    onGuardrailsChanged((_t, s) => seen.push(s ? s.version : null));
    expect(cachedGuardrails()).toBeNull();
    expect((await currentGuardrails()).version).toBe(0);
    await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a"), source: "file" }], by: "cli" });
    expect(cachedGuardrails()!.version).toBe(0);
    expect((await currentGuardrails()).version).toBe(1);
    expect(seen).toEqual([1]);
    await refreshGuardrails();
    expect(seen).toEqual([1]);
  });

  test("a failed verification is held, audited, and refuses every session boot", async () => {
    await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a"), source: "file" }], by: "cli" });
    await db.run(`DELETE FROM guardrails`);
    const audits: string[] = [];
    await expect(currentGuardrails("default", { persona: "default", sessionId: "s1" })).rejects.toBeInstanceOf(GuardrailsUnavailableError);
    await flushAudits();
    const rows = await db.query<{ action: string; persona: string | null; session_id: string | null }>(`SELECT action, persona, session_id FROM audit_events WHERE action = 'guardrail.integrity.failed' ORDER BY id`);
    for (const r of rows) audits.push(`${r.persona}:${r.session_id}`);
    expect(audits).toContain("default:s1");
    expect(audits).toContain("null:null");
    expect(guardrailsFailure()).toMatch(/manifest but missing/);
    expect(cachedGuardrails()).toBeNull();
  });

  test("the key comes from the master key, else a 0600 key file (sqlite only; Postgres refuses without the master key)", () => {
    const saved = process.env.SLAUDE_MASTER_KEY;
    try {
      delete process.env.SLAUDE_MASTER_KEY;
      __resetGuardrailKeyForTests();
      __resetMasterKeyCache();
      if (pgOnly) {
        expect(() => guardrailKey()).toThrow(GuardrailKeyError);
        expect(() => guardrailKey()).toThrow(/need SLAUDE_MASTER_KEY/);
        return;
      }
      rmSync(HMAC_KEY_FILE, { force: true });
      expect(peekKeySource()).toBeNull();
      const k = guardrailKey();
      expect(peekKeySource()).toBe("key-file");
      expect(k.source).toBe("key-file");
      expect(existsSync(HMAC_KEY_FILE)).toBe(true);
      expect(statSync(HMAC_KEY_FILE).mode & 0o777).toBe(0o600);
      __resetGuardrailKeyForTests();
      expect(guardrailKey().key.equals(k.key)).toBe(true);
      process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
      __resetMasterKeyCache();
      __resetGuardrailKeyForTests();
      expect(guardrailKey().source).toBe("master-key");
    } finally {
      if (saved !== undefined) process.env.SLAUDE_MASTER_KEY = saved;
      else delete process.env.SLAUDE_MASTER_KEY;
      __resetMasterKeyCache();
      __resetGuardrailKeyForTests();
    }
  });
});

describe("writes never launder tampering; the owner's repair", () => {
  test("a write over a set that does not verify is refused; a repair re-signs it above every version seen", async () => {
    await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a"), source: "file" }, { slug: "b", md: gmd("b"), source: "git" }], by: "cli" });
    await db.run(`UPDATE guardrails SET md = ? WHERE slug = 'b'${tenantSql}`, [gmd("b", "", "Tampered.")]);
    await expect(applyGuardrailChange("default", { upsert: [{ slug: "c", md: gmd("c"), source: "file" }], by: "cli" })).rejects.toThrow(/'b' signature does not verify/);
    await expect(applyGuardrailChange("default", { setEnabled: [{ slug: "a", enabled: false }], by: "op" })).rejects.toBeInstanceOf(GuardrailIntegrityError);
    expect((await readGuardrails()).rows.map((r) => r.slug)).toEqual(["a", "b"]);
    const r = await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a", "", "Fresh."), source: "file" }], by: "cli", repair: true });
    expect(r.updated).toEqual(["a"]);
    expect(r.resigned).toEqual(["b"]);
    expect(r.version).toBe(2);
    const snap = await loadTenantSnapshot("default");
    expect(snap.resolved.find((g) => g.slug === "b")!.prose).toBe("Tampered.");
    expect(await highWater("default")).toBe(2);
  });

  test("a repair after a rollback lands above the high-water mark, overrides included", async () => {
    await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a"), source: "file" }], by: "cli" });
    await __setOverrideForTests("default", { slug: "a", md: gmd("a", "", "Mine."), baseSha: "x", author: "op" });
    await raiseHighWater("default", 9);
    await expect(loadTenantSnapshot("default")).rejects.toThrow(/older than version 9/);
    const r = await applyGuardrailChange("default", { by: "cli", repair: true });
    expect(r.version).toBe(10);
    expect(r.resigned).toEqual(["a", "a (override)"]);
    expect((await loadTenantSnapshot("default")).version).toBe(10);
  });
});

describe("the high-water mark: deleted and rolled-back sets fail closed", () => {
  test("deleting the whole set after one existed fails closed, in this process and after a cold start (the file)", async () => {
    await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a"), source: "file" }], by: "cli" });
    expect((await loadTenantSnapshot("default")).version).toBe(1);
    for (const t of ["guardrails", "guardrails_manifest"]) await db.run(`DELETE FROM ${t}`);
    await expect(loadTenantSnapshot("default")).rejects.toThrow(/gone, but version 1 was seen before/);
    // A version-0 placeholder is the same as no manifest.
    await expect(currentGuardrails("default")).rejects.toBeInstanceOf(GuardrailsUnavailableError);
    // Cold start: memory forgotten, the file beside the key remembers.
    const file = await Bun.file(HIGH_WATER_FILE).text();
    await __resetHighWaterForTests();
    writeFileSync(HIGH_WATER_FILE, file);
    await expect(loadTenantSnapshot("default")).rejects.toThrow(/deleted/);
  });

  test("replaying an older signed set (rows and manifest together) is refused", async () => {
    await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a", "", "v1"), source: "file" }], by: "cli" });
    const old = await readGuardrails();
    await applyGuardrailChange("default", { upsert: [{ slug: "a", md: gmd("a", "", "v2 stricter"), source: "file" }], by: "cli" });
    const r = old.rows[0]!;
    await db.run(`UPDATE guardrails SET md = ?, sha = ?, version = ?, hmac = ? WHERE slug = 'a'${tenantSql}`, [r.md, r.sha, r.version, r.hmac]);
    await db.run(`UPDATE guardrails_manifest SET version = ?, entries = ?, hmac = ?`, [old.manifest!.version, old.manifest!.entries, old.manifest!.hmac]);
    // The older set verifies on its own; only the mark refuses it.
    expect(verifySet("default", await readGuardrails())).toBe(1);
    await expect(loadTenantSnapshot("default")).rejects.toThrow(/version 1, older than version 2/);
    await expect(applyGuardrailChange("default", { upsert: [{ slug: "b", md: gmd("b"), source: "file" }], by: "cli" })).rejects.toThrow(/rolled back/);
  });

  test("Redis keeps the mark for every replica and restart; it only ever rises", async () => {
    const store = new Map<string, string>();
    const fake = {
      get: async (k: string) => store.get(k) ?? null,
      del: async (k: string) => void store.delete(k),
      eval: async (_s: string, _n: number, k: string, v: string) => {
        if (Number(store.get(k) ?? "0") < Number(v)) store.set(k, v);
        return 1;
      },
    };
    setHighWaterRedis(fake as never, "test");
    try {
      await raiseHighWater("default", 5);
      await raiseHighWater("default", 3);
      expect(store.get("test:guardrails:high-water:default")).toBe("5");
      await __resetHighWaterForTests();
      store.set("test:guardrails:high-water:default", "7");
      expect(await highWater("default")).toBe(7);
      const broken = { get: async () => { throw new Error("down"); }, eval: async () => { throw new Error("down"); }, del: async () => {} };
      setHighWaterRedis(broken as never);
      await raiseHighWater("default", 8);
      expect(await highWater("default")).toBe(8);
    } finally {
      setHighWaterRedis(null);
      await __resetHighWaterForTests();
    }
  });
});

describe.skipIf(pgOnly || process.getuid?.() === 0)("a deployment with no guardrails", () => {
  test("never reads or creates the key, and works on a read-only home", async () => {
    const saved = process.env.SLAUDE_MASTER_KEY;
    delete process.env.SLAUDE_MASTER_KEY;
    __resetMasterKeyCache();
    __resetGuardrailKeyForTests();
    rmSync(GUARDRAILS_DIR, { recursive: true, force: true });
    chmodSync(paths.home, 0o555);
    try {
      const snap = await currentGuardrails("default");
      expect(snap).toMatchObject({ version: 0, resolved: [], keySource: null });
      const { threatModel } = await import("../../src/gateway/panel/guardrails-api");
      expect(threatModel("this-process").keySource).toBeNull();
      const { bundleGuardrailsFor } = await import("../../src/guardrails/node");
      expect(await bundleGuardrailsFor("default", "default")).toBeNull();
      expect(existsSync(HMAC_KEY_FILE)).toBe(false);
      expect(existsSync(GUARDRAILS_DIR)).toBe(false);
    } finally {
      chmodSync(paths.home, 0o755);
      if (saved !== undefined) process.env.SLAUDE_MASTER_KEY = saved;
      __resetMasterKeyCache();
      __resetGuardrailKeyForTests();
    }
  });

  test("an empty key file is retried, then refused rather than used", () => {
    const saved = process.env.SLAUDE_MASTER_KEY;
    delete process.env.SLAUDE_MASTER_KEY;
    __resetMasterKeyCache();
    __resetGuardrailKeyForTests();
    mkdirSync(GUARDRAILS_DIR, { recursive: true });
    writeFileSync(HMAC_KEY_FILE, "");
    try {
      expect(() => guardrailKey()).toThrow(GuardrailKeyError);
      writeFileSync(HMAC_KEY_FILE, "c2hvcnQ=\n");
      expect(() => guardrailKey()).toThrow(/32-byte key/);
    } finally {
      rmSync(HMAC_KEY_FILE, { force: true });
      if (saved !== undefined) process.env.SLAUDE_MASTER_KEY = saved;
      __resetMasterKeyCache();
      __resetGuardrailKeyForTests();
    }
  });
});

// The database is shared by every test file of the run: leave no guardrail behind.
afterAll(async () => {
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
});
