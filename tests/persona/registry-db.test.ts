// tests/persona/registry-db.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { paths } from "../../src/config/home";
import * as P from "../../src/db/personas";
import {
  __resetPersonaRegistry,
  buildPersonaRegistry,
  getPersonaRegistry,
  invalidatePersonaRegistry,
  setPersonaRegistry,
  startRegistryRevalidation,
  whenPersonaRegistrySettled,
} from "../../src/persona/registry";
import { personaSoulText, setManagedDefaultSoul } from "../../src/persona/soul-source";
import { __resetSoulDataMemo, soulDataBase } from "../../src/soul/extract";

const isPg = process.env.SLAUDE_DB === "pg";

const row = (name: string) => ({ name, slackUserId: `U${name.toUpperCase()}`, userToken: null, model: null,
  soulMd: `${name} soul`, soulJson: null, mcp: null, origin: "git" as const, tombstonedAt: null });
const meta = (rev: string, iso: string) => ({ revision: rev, committedAt: Date.parse(iso), by: "ci" });

/** A filesystem persona under the test home, removed in afterEach. */
function writeFsPersona(name: string, slackUserId: string, soul: string) {
  const dir = join(paths.personas, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ slackUserId, name }));
  writeFileSync(join(dir, "SOUL.md"), soul);
}

const savedKey = process.env.SLAUDE_MASTER_KEY;

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  if (isPg) for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
});

afterEach(async () => {
  await whenPersonaRegistrySettled();
  __resetPersonaRegistry();
  setManagedDefaultSoul(null);
  __resetSoulDataMemo();
  rmSync(paths.personas, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
  else process.env.SLAUDE_MASTER_KEY = savedKey;
  __resetMasterKeyCache();
});

describe("a filesystem registry (any dialect)", () => {
  test("a never-synced tenant reads the filesystem", async () => {
    const r = await buildPersonaRegistry("default");
    // the test home has no personas directory: the filesystem registry is empty
    expect(r.list()).toEqual([]);
  });

  test("a filesystem persona is listed, and its soul is read from its file", async () => {
    writeFsPersona("fsbot", "UFSBOT", "fs soul");
    const r = await buildPersonaRegistry("default");
    expect(r.list().map((p) => p.name)).toEqual(["fsbot"]);
    expect(r.lookupByName("fsbot")!.soulMd).toBeUndefined();
    setPersonaRegistry(r);
    expect(personaSoulText("fsbot")).toBe("fs soul");
  });
});

describe.skipIf(!isPg)("a database-backed registry", () => {
  test("a managed tenant reads effective state, and tombstoned personas are gone", async () => {
    await P.applySync("default", [row("ana"), row("bea")], meta("r1", "2026-10-01T10:00:00Z"));
    await P.applySync("default", [row("ana")], meta("r2", "2026-10-01T11:00:00Z"));
    const r = await buildPersonaRegistry("default");
    expect(r.list().map((p) => p.name)).toEqual(["ana"]);
    expect(r.lookupByName("ana")!.soulMd).toBe("ana soul");
    expect(r.lookupByUserId("UBEA")).toBeNull();
  });

  test("a managed tenant never merges in filesystem personas", async () => {
    writeFsPersona("fsbot", "UFSBOT", "fs soul");
    await P.applySync("default", [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    const r = await buildPersonaRegistry("default");
    expect(r.list().map((p) => p.name)).toEqual(["ana"]);
    expect(r.lookupByName("fsbot")).toBeNull();
  });

  test("the default persona is not in the snapshot", async () => {
    await P.applySync("default", [row("default"), row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    const r = await buildPersonaRegistry("default");
    expect(r.list().map((p) => p.name)).toEqual(["ana"]);
  });

  // Acceptance 13: a replica that misses the signal still converges.
  test("the poll converges a replica that never received a reload signal", async () => {
    await P.applySync("default", [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    setPersonaRegistry(await buildPersonaRegistry("default"));
    const stop = startRegistryRevalidation("default", 20);
    try {
      await P.setOverride("default", "ana", "soul", { soulMd: "live soul", soulJson: null }, "ops");
      // No publishConfigReload: only the poll can notice.
      const deadline = Date.now() + 2000;
      while (getPersonaRegistry().lookupByName("ana")!.soulMd !== "live soul" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(getPersonaRegistry().lookupByName("ana")!.soulMd).toBe("live soul");
    } finally {
      stop();
    }
  });

  // R21: an invalidation must never flip a managed tenant back to the filesystem.
  test("invalidation keeps serving the database snapshot, then rebuilds from the database", async () => {
    writeFsPersona("fsbot", "UFSBOT", "fs soul");
    await P.applySync("default", [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    setPersonaRegistry(await buildPersonaRegistry("default"));

    invalidatePersonaRegistry();
    expect(getPersonaRegistry().lookupByName("ana")!.soulMd).toBe("ana soul");
    expect(getPersonaRegistry().lookupByName("fsbot")).toBeNull();

    await whenPersonaRegistrySettled();
    expect(getPersonaRegistry().lookupByName("ana")!.soulMd).toBe("ana soul");
    expect(getPersonaRegistry().lookupByName("fsbot")).toBeNull();

    await P.setOverride("default", "ana", "soul", { soulMd: "live soul", soulJson: null }, "ops");
    invalidatePersonaRegistry();
    await whenPersonaRegistrySettled();
    expect(getPersonaRegistry().lookupByName("ana")!.soulMd).toBe("live soul");
    expect(personaSoulText("ana")).toBe("live soul");
  });

  test("a rebuild installs the managed default soul and its structured data", async () => {
    const def = { ...row("default"), soulMd: "managed default soul",
      soulJson: { approvers: [{ userId: "UAPPROVER", scope: "everything", catchall: true }] } };
    await P.applySync("default", [def, row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    invalidatePersonaRegistry();
    await whenPersonaRegistrySettled();
    expect(personaSoulText()).toBe("managed default soul");
    expect(personaSoulText("default")).toBe("managed default soul");
    expect(personaSoulText("ana")).toBe("ana soul");
    expect(soulDataBase().approvers.map((a) => a.userId)).toContain("UAPPROVER");
  });

  test("a failed rebuild keeps the current snapshot", async () => {
    await P.applySync("default", [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    setPersonaRegistry(await buildPersonaRegistry("default"));
    // A broken master key makes reading the overrides layer fail.
    await P.setOverride("default", "ana", "model", "m", "ops");
    process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
    __resetMasterKeyCache();
    invalidatePersonaRegistry();
    await whenPersonaRegistrySettled();
    expect(getPersonaRegistry().lookupByName("ana")!.soulMd).toBe("ana soul");
  });
});
