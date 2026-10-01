import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as P from "../../src/db/personas";
import type { DesiredPersona } from "../../src/persona/effective";

// Postgres-only tables: run this file with SLAUDE_DB=pg (PGLite).
const T = "default";
const row = (name: string, over: Partial<DesiredPersona> = {}): DesiredPersona => ({
  name, slackUserId: `U${name.toUpperCase()}`, userToken: null, model: null,
  soulMd: `${name} soul`, soulJson: { approvers: [] }, mcp: null, origin: "git", tombstonedAt: null, ...over,
});
const meta = (revision: string, iso: string) => ({ revision, committedAt: Date.parse(iso), by: "ci" });

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  if (process.env.SLAUDE_DB !== "pg") return;
  for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
});

// The persona tables are shared state: leftover rows make every later file in
// the run see a populated personas table (and fail closed on a missing default).
afterAll(async () => {
  if (process.env.SLAUDE_DB !== "pg") return;
  for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
});

describe.skipIf(process.env.SLAUDE_DB !== "pg")("persona repository", () => {
  test("an override on an unknown or tombstoned persona is refused", async () => {
    await P.applySync(T, [row("ana"), row("bea")], meta("r1", "2026-10-01T10:00:00Z"));
    await P.applySync(T, [row("ana")], meta("r2", "2026-10-01T11:00:00Z"));
    await expect(P.setOverride(T, "ghost", "model", "m", "ops")).rejects.toBeInstanceOf(P.PersonaNotFoundError);
    await expect(P.setOverride(T, "bea", "model", "m", "ops")).rejects.toBeInstanceOf(P.PersonaNotFoundError);
  });

  test("a tenant is unmanaged until its first sync", async () => {
    expect(await P.isManaged(T)).toBe(false);
    expect(await P.stateVersion(T)).toBe("unmanaged");
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    expect(await P.isManaged(T)).toBe(true);
  });

  test("a sync wipes every override", async () => {
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    await P.setOverride(T, "ana", "model", "m-live", "ops");
    const r = await P.applySync(T, [row("ana")], meta("r2", "2026-10-01T11:00:00Z"));
    expect(r.overridesWiped).toBe(1);
    expect((await P.effectivePersonas(T))[0]!.overridden).toEqual([]);
  });

  test("an omitted persona is tombstoned, keeps its row, and returns intact when re-added", async () => {
    await P.applySync(T, [row("ana"), row("bea")], meta("r1", "2026-10-01T10:00:00Z"));
    const r = await P.applySync(T, [row("ana")], meta("r2", "2026-10-01T11:00:00Z"));
    expect(r.tombstoned).toEqual(["bea"]);
    expect((await P.effectivePersonas(T)).map((p) => p.name)).toEqual(["ana"]);
    expect((await P.effectivePersonas(T, { includeTombstoned: true })).map((p) => p.name).sort()).toEqual(["ana", "bea"]);
    const r3 = await P.applySync(T, [row("ana"), row("bea")], meta("r3", "2026-10-01T12:00:00Z"));
    expect(r3.updated).toEqual(["bea"]);
    expect(r3.unchanged).toEqual(["ana"]);
    expect((await P.effectivePersonas(T)).map((p) => p.name).sort()).toEqual(["ana", "bea"]);
  });

  test("a runtime-onboarded persona is tombstoned by the next sync", async () => {
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    await P.createRuntimePersona(T, row("quick", { origin: "runtime" }), "ops");
    const r = await P.applySync(T, [row("ana")], meta("r2", "2026-10-01T11:00:00Z"));
    expect(r.tombstoned).toEqual(["quick"]);
  });

  test("an older committedAt is refused", async () => {
    await P.applySync(T, [row("ana")], meta("r2", "2026-10-01T11:00:00Z"));
    await expect(P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"))).rejects.toBeInstanceOf(P.StaleRevisionError);
  });

  // Review Focus 4: instants, not strings.
  test("committedAt is compared as an instant across UTC offsets", async () => {
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T05:00:00Z"));
    // 10:00 at +07:00 is 03:00 UTC, which is earlier, despite sorting later as a string.
    await expect(P.applySync(T, [row("ana")], meta("r0", "2026-10-01T10:00:00+07:00"))).rejects.toBeInstanceOf(P.StaleRevisionError);
  });

  // The race the compare-and-set exists for: a slow older run must never land
  // after a newer one. Whatever order the two commit in, r3 ends up live.
  test("concurrent older and newer syncs: the newer always ends up live", async () => {
    for (let i = 0; i < 20; i++) {
      const t = `race-${i}`;
      await P.applySync(t, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
      await Promise.allSettled([
        P.applySync(t, [row("ana", { model: "older" })], meta("r2", "2026-10-01T11:00:00Z")),
        P.applySync(t, [row("ana", { model: "newer" })], meta("r3", "2026-10-01T12:00:00Z")),
      ]);
      expect((await P.syncState(t))!.revision).toBe("r3");
      expect((await P.effectivePersonas(t))[0]!.model).toBe("newer");
    }
  });

  test("runtime writes are refused on an unmanaged tenant", async () => {
    await expect(P.setOverride(T, "ana", "model", "m", "ops")).rejects.toBeInstanceOf(P.NotManagedError);
    await expect(P.createRuntimePersona(T, row("quick", { origin: "runtime" }), "ops")).rejects.toBeInstanceOf(P.NotManagedError);
  });

  test("a runtime onboard may not take a name git already uses", async () => {
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    await expect(P.createRuntimePersona(T, row("ana", { origin: "runtime" }), "ops")).rejects.toBeInstanceOf(P.NameTakenError);
  });

  test("an override write changes the state version", async () => {
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    const before = await P.stateVersion(T);
    await P.setOverride(T, "ana", "model", "m", "ops");
    expect(await P.stateVersion(T)).not.toBe(before);
  });

  test("the user token and mcp are encrypted at rest", async () => {
    await P.applySync(T, [row("ana", { userToken: "user-token-secret-value", mcp: { k: "mcp-secret-value" } })], meta("r1", "2026-10-01T10:00:00Z"));
    const raw = await db.one<{ user_token: string; mcp_json: string }>(`SELECT user_token, mcp_json::text AS mcp_json FROM personas WHERE name='ana'`);
    expect(raw!.user_token).not.toContain("user-token-secret-value");
    expect(raw!.mcp_json).not.toContain("mcp-secret-value");
    expect((await P.effectivePersonas(T))[0]!.userToken).toBe("user-token-secret-value");
  });

  // Claim 5: every write site, not only the sync's.
  test("a runtime onboard stores the user token and mcp encrypted", async () => {
    await P.applySync(T, [row("default")], meta("r1", "2026-10-01T10:00:00Z"));
    await P.createRuntimePersona(T, row("cat", { origin: "runtime", userToken: "runtime-token-secret-value", mcp: { k: "runtime-mcp-secret-value" } }), "ops");
    const raw = await db.one<{ user_token: string; mcp_json: string }>(`SELECT user_token, mcp_json::text AS mcp_json FROM personas WHERE name='cat'`);
    expect(raw!.user_token).not.toContain("runtime-token-secret-value");
    expect(raw!.mcp_json).not.toContain("runtime-mcp-secret-value");
    const cat = (await P.effectivePersonas(T)).find((p) => p.name === "cat")!;
    expect(cat.userToken).toBe("runtime-token-secret-value");
    expect(cat.mcp).toEqual({ k: "runtime-mcp-secret-value" });
  });

  test("override values (mcp, soul) are stored encrypted", async () => {
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    await P.setOverride(T, "ana", "mcp", { k: "override-mcp-secret-value" }, "ops");
    await P.setOverride(T, "ana", "soul", { soulMd: "override-soul-text-value", soulJson: null }, "ops");
    const raws = await db.query<{ value: string }>(`SELECT value FROM persona_overrides WHERE persona_name='ana'`);
    expect(raws).toHaveLength(2);
    for (const r of raws) {
      expect(r.value).not.toContain("override-mcp-secret-value");
      expect(r.value).not.toContain("override-soul-text-value");
    }
    const ana = (await P.effectivePersonas(T))[0]!;
    expect(ana.mcp).toEqual({ k: "override-mcp-secret-value" });
    expect(ana.soulMd).toBe("override-soul-text-value");
  });

  test("desiredPersonas ignores overrides while effectivePersonas applies them", async () => {
    await P.applySync(T, [row("ana", { model: "git-model" })], meta("r1", "2026-10-01T10:00:00Z"));
    await P.setOverride(T, "ana", "model", "live-model", "ops");
    expect((await P.desiredPersonas(T))[0]!.model).toBe("git-model");
    expect((await P.effectivePersonas(T))[0]!.model).toBe("live-model");
  });

  test("stateVersion never repeats: every write, syncs included, moves it", async () => {
    const seen: string[] = [];
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    seen.push(await P.stateVersion(T));
    await P.setOverride(T, "ana", "model", "A", "ops");
    seen.push(await P.stateVersion(T));
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z")); // same revision, equal committedAt: accepted
    seen.push(await P.stateVersion(T));
    await P.setOverride(T, "ana", "model", "B", "ops");
    seen.push(await P.stateVersion(T));
    expect(new Set(seen).size).toBe(4);
  });

  test("createRuntimePersona never overwrites a git row, even past the read check", async () => {
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    await expect(P.createRuntimePersona(T, row("ana", { origin: "runtime", soulMd: "evil" }), "ops")).rejects.toBeInstanceOf(P.NameTakenError);
    const r = await db.one<{ soul_md: string; origin: string }>(`SELECT soul_md, origin FROM personas WHERE name='ana'`);
    expect(r).toEqual({ soul_md: "ana soul", origin: "git" });
  });

  test("a runtime onboard may not take another persona's Slack identity", async () => {
    await P.applySync(T, [row("ana")], meta("r1", "2026-10-01T10:00:00Z"));
    await expect(P.createRuntimePersona(T, row("quick", { origin: "runtime", slackUserId: "UANA" }), "ops")).rejects.toBeInstanceOf(P.IdentityTakenError);
  });
});
