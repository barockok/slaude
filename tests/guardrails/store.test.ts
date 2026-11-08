import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/client";
import {
  __clearGuardrailsForTests, __setOverrideForTests, applyGuardrailChange, manifestVersion, readGuardrails, sha256, UnknownGuardrailError,
} from "../../src/db/guardrails";
import { GuardrailIntegrityError, verifySet, guardrailKey, __resetGuardrailKeyForTests, HMAC_KEY_FILE } from "../../src/guardrails/integrity";
import {
  __resetGuardrailSnapshotsForTests, cachedGuardrails, currentGuardrails, docsFromStored, guardrailsFailure, GuardrailsUnavailableError,
  loadTenantSnapshot, onGuardrailsChanged, refreshGuardrails,
} from "../../src/guardrails/snapshot";
import { flushAudits } from "../../src/audit/emit";
import { existsSync, statSync } from "node:fs";
import { __resetMasterKeyCache } from "../../src/db/crypto";

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

  test("the key comes from the master key, else a 0600 key file", () => {
    const saved = process.env.SLAUDE_MASTER_KEY;
    try {
      delete process.env.SLAUDE_MASTER_KEY;
      __resetGuardrailKeyForTests();
      __resetMasterKeyCache();
      const k = guardrailKey();
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

// The database is shared by every test file of the run: leave no guardrail behind.
afterAll(async () => {
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
});
