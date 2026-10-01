// tests/persona/registry-db.test.ts
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { paths } from "../../src/config/home";
import * as P from "../../src/db/personas";
import {
  __resetPersonaRegistry,
  __setDiskSoulDataLoader,
  __setPersonaStateLoader,
  buildPersonaRegistry,
  getPersonaRegistry,
  invalidatePersonaRegistry,
  managedPersonaModel,
  setPersonaRegistry,
  startRegistryRevalidation,
  whenPersonaRegistrySettled,
} from "../../src/persona/registry";
import { personaSoulText } from "../../src/persona/soul-source";
import { soulDataBase } from "../../src/soul/extract";
import { SoulDataSchema } from "../../src/soul/data";
import { loadSoul } from "../../src/soul/loader";

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

  test("a filesystem registry is unmanaged and knows no retired identity", async () => {
    writeFsPersona("fsbot", "UFSBOT", "fs soul");
    const r = await buildPersonaRegistry("default");
    expect(r.isManaged()).toBe(false);
    expect(r.tombstonedPersonaFor("UFSBOT")).toBeNull();
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
  // R42 (I2, I3): the managed snapshot carries each persona's effective model
  // and mcp, the default persona's included, overrides applied.
  test("the snapshot carries effective model and mcp; a filesystem registry carries neither", async () => {
    const mcp = { mcpServers: { s: { type: "http", url: "https://s.test/mcp" } } };
    await P.applySync("default", [
      { ...row("default"), model: "m-default", mcp },
      { ...row("ana"), model: "m-ana" },
    ], meta("r1", "2026-10-01T10:00:00Z"));
    await P.setOverride("default", "ana", "model", "m-ana-live", "ops");
    const r = await buildPersonaRegistry("default");
    expect(r.lookupByName("ana")!.model).toBe("m-ana-live");
    expect(r.lookupByName("ana")!.mcp).toBeNull();
    expect(r.defaultPersona!()).toEqual({ model: "m-default", mcp });
    expect(managedPersonaModel("ana", r)).toBe("m-ana-live");
    expect(managedPersonaModel(undefined, r)).toBe("m-default");
    writeFsPersona("fsbot", "UFSBOT", "fs soul");
    await db.run(`DELETE FROM persona_sync_state`);
    await db.run(`DELETE FROM personas`);
    const fsr = await buildPersonaRegistry("default");
    expect(fsr.defaultPersona).toBeUndefined();
    expect(managedPersonaModel("fsbot", fsr)).toBeUndefined();
  });

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

  test("a failed rebuild keeps the current snapshot, and says so", async () => {
    await P.applySync("default", [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    setPersonaRegistry(await buildPersonaRegistry("default"));
    // A soul override that a successful rebuild would visibly install...
    await P.setOverride("default", "ana", "soul", { soulMd: "live soul", soulJson: null }, "ops");
    // ...but a broken master key makes reading the overrides layer fail.
    process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
    __resetMasterKeyCache();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      invalidatePersonaRegistry();
      await whenPersonaRegistrySettled();
      expect(warn.mock.calls.some((c) => String(c[0]).includes("registry rebuild failed"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect(getPersonaRegistry().lookupByName("ana")!.soulMd).toBe("ana soul");
  });

  // R24: a superseded rebuild installs nothing, so the poll must not record its version.
  test("the poll retries when its rebuild was superseded by one that failed", async () => {
    await P.applySync("default", [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    setPersonaRegistry(await buildPersonaRegistry("default"));
    const one = (soul: string) => ({
      registry: { lookupByUserId: () => null, list: () => [],  isMultiPersonaMode: () => true,
        isManaged: () => false, tombstonedPersonaFor: () => null,
        lookupByName: (n: string) => (n === "ana" ? { name: "ana", slackUserId: "UANA", soulMd: soul,
          config: { slackUserId: "UANA", name: "ana" }, outClient: null } : null) },
      managed: null,
    });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    __setPersonaStateLoader(async () => {
      calls++;
      if (calls === 1) { await gate; return one("superseded"); } // the poll's first rebuild
      if (calls === 2) throw new Error("newer rebuild failed"); // the reload signal's
      return one("converged");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const stop = startRegistryRevalidation("default", 20);
    try {
      while (calls < 1) await new Promise((r) => setTimeout(r, 5));
      invalidatePersonaRegistry();
      await whenPersonaRegistrySettled();
      release();
      const deadline = Date.now() + 2000;
      while (getPersonaRegistry().lookupByName("ana")!.soulMd !== "converged" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(getPersonaRegistry().lookupByName("ana")!.soulMd).toBe("converged");
    } finally {
      stop();
      warn.mockRestore();
    }
  });
});

// R25: the default persona's soul text and structure are one pair from one source.
describe.skipIf(!isPg)("the default persona's soul pair", () => {
  const approvers = (id: string) => ({ approvers: [{ userId: id, scope: "everything", catchall: true }] });
  const defRow = (soulMd: string, soulJson: unknown) => ({ ...row("default"), soulMd, soulJson });
  const refresh = async () => { invalidatePersonaRegistry(); await whenPersonaRegistrySettled(); };

  test("a managed default row supplies both text and structure", async () => {
    await P.applySync("default", [defRow("db default", approvers("UDBAPPROVER")), row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    await refresh();
    expect(personaSoulText()).toBe("db default");
    expect(soulDataBase().approvers.map((a) => a.userId)).toEqual(["UDBAPPROVER"]);
  });

  test("with no managed default row, both come from disk", async () => {
    __setDiskSoulDataLoader(async () => SoulDataSchema.parse(approvers("UDISKAPPROVER")));
    await P.applySync("default", [defRow("db default", approvers("UDBAPPROVER")), row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    await refresh();
    expect(personaSoulText()).toBe("db default");
    // The default row is tombstoned by a sync that omits it.
    await P.applySync("default", [row("ana")], meta("r2", "2026-10-01T11:00:00Z"));
    await refresh();
    expect(personaSoulText()).toBe(loadSoul());
    expect(soulDataBase().approvers.map((a) => a.userId)).toEqual(["UDISKAPPROVER"]);
  });

  test("a default row whose structure is invalid keeps the previous pair, and the rest installs", async () => {
    await P.applySync("default", [defRow("db default", approvers("UDBAPPROVER")), row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    await refresh();
    await P.setOverride("default", "default", "soul", { soulMd: "broken default", soulJson: { approvers: "nope" } }, "ops");
    await P.setOverride("default", "ana", "soul", { soulMd: "live ana", soulJson: null }, "ops");
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      await refresh();
      expect(err.mock.calls.some((c) => String(c[0]).includes("tenant=default"))).toBe(true);
      expect(err.mock.calls.flat().join(" ")).not.toContain("broken default");
    } finally {
      err.mockRestore();
    }
    expect(personaSoulText()).toBe("db default");
    expect(soulDataBase().approvers.map((a) => a.userId)).toEqual(["UDBAPPROVER"]);
    expect(personaSoulText("ana")).toBe("live ana");
  });
});

// R40-I4: a retired persona's Slack identity must be recognisable, so the
// gateway can drop what is addressed to it instead of treating it as a stranger.
describe.skipIf(!isPg)("a managed registry's retired identities", () => {
  test("a tombstoned persona's Slack id maps to its name; a live one does not", async () => {
    await P.applySync("default", [row("default"), row("ana"), row("bea")], meta("r1", "2026-10-01T10:00:00Z"));
    await P.applySync("default", [row("default"), row("ana")], meta("r2", "2026-10-01T11:00:00Z"));
    const r = await buildPersonaRegistry("default");
    expect(r.isManaged()).toBe(true);
    expect(r.lookupByUserId("UBEA")).toBeNull();
    expect(r.tombstonedPersonaFor("UBEA")).toBe("bea");
    expect(r.tombstonedPersonaFor("UANA")).toBeNull();
    expect(r.tombstonedPersonaFor("UNOBODY")).toBeNull();
  });

  test("an identity re-used by a live persona is live, not retired", async () => {
    await P.applySync("default", [row("default"), row("bea")], meta("r1", "2026-10-01T10:00:00Z"));
    await P.applySync("default", [row("default"), { ...row("cat"), slackUserId: "UBEA" }], meta("r2", "2026-10-01T11:00:00Z"));
    const r = await buildPersonaRegistry("default");
    expect(r.lookupByUserId("UBEA")!.name).toBe("cat");
    expect(r.tombstonedPersonaFor("UBEA")).toBeNull();
  });
});
