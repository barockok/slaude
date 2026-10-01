// tests/persona/run-sync.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as P from "../../src/db/personas";
import { runSync, SyncFailure } from "../../src/persona/sync/run";

const T = "default";
const payload = (personas: unknown[], extra: object = {}) =>
  ({ revision: "r1", committedAt: "2026-10-01T10:00:00Z", personas, ...extra });
const ana = { name: "ana", slackUserId: "UTESTUSER1", soul: "You are Ana.", userToken: "${ANA_XOXP}" };
const okExtract = async () => ({ approvers: [] });
const env = { ANA_XOXP: "user-token-1" };

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  // The persona tables are Postgres-only (migration 0011).
  if (process.env.SLAUDE_DB !== "pg") return;
  for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
});

describe.skipIf(process.env.SLAUDE_DB !== "pg")("runSync", () => {
  test("applies a set: effective state equals the payload, variables resolved", async () => {
    await runSync(T, payload([ana]), { dryRun: false, env, by: "ci", extract: okExtract });
    const [p] = await P.effectivePersonas(T);
    expect(p!.userToken).toBe("user-token-1");
    expect(p!.soulMd).toBe("You are Ana.");
  });

  test("dryRun applies nothing, and reports tombstones and wiped overrides", async () => {
    await runSync(T, payload([ana, { ...ana, name: "bea", slackUserId: "UTESTUSER2" }]), { dryRun: false, env, by: "ci", extract: okExtract });
    await P.setOverride(T, "ana", "model", "m", "ops");
    const r = await runSync(T, payload([ana], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" }),
      { dryRun: true, env, by: "ci", extract: okExtract });
    expect(r.tombstoned).toEqual(["bea"]);
    expect(r.overridesWiped).toBe(1);
    expect((await P.effectivePersonas(T)).map((p) => p.name).sort()).toEqual(["ana", "bea"]);
    expect((await P.effectivePersonas(T))[0]!.overridden).toEqual(["model"]);
  });

  test("an unresolved variable is a 422 that names it and applies nothing", async () => {
    const e = await runSync(T, payload([ana]), { dryRun: false, env: {}, by: "ci", extract: okExtract }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toContain("ANA_XOXP");
    expect(await P.isManaged(T)).toBe(false);
  });

  test("an extraction failure is a 502 and leaves the previous revision live", async () => {
    await runSync(T, payload([ana]), { dryRun: false, env, by: "ci", extract: okExtract });
    const failing = async () => { throw new Error("provider down"); };
    const e = await runSync(T, payload([{ ...ana, soul: "changed" }], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" }),
      { dryRun: false, env, by: "ci", extract: failing }).catch((x) => x);
    expect(e.status).toBe(502);
    expect((await P.syncState(T))!.revision).toBe("r1");
  });

  test("an unchanged soul is not re-extracted", async () => {
    let calls = 0;
    const counting = async () => { calls++; return { approvers: [] }; };
    await runSync(T, payload([ana]), { dryRun: false, env, by: "ci", extract: counting });
    await runSync(T, payload([ana], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" }), { dryRun: false, env, by: "ci", extract: counting });
    expect(calls).toBe(1);
  });

  test("an empty set is refused unless allowEmpty is set", async () => {
    const e = await runSync(T, payload([]), { dryRun: false, env, by: "ci", extract: okExtract }).catch((x) => x);
    expect(e.status).toBe(422);
    await expect(runSync(T, payload([], { allowEmpty: true }), { dryRun: false, env, by: "ci", extract: okExtract })).resolves.toBeDefined();
  });

  test("an older revision is a 409", async () => {
    await runSync(T, payload([ana], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" }), { dryRun: false, env, by: "ci", extract: okExtract });
    const e = await runSync(T, payload([ana]), { dryRun: false, env, by: "ci", extract: okExtract }).catch((x) => x);
    expect(e.status).toBe(409);
  });

  test("dry run and real run classify identically when a live override exists", async () => {
    await runSync(T, payload([ana]), { dryRun: false, env, by: "ci", extract: okExtract });
    await P.setOverride(T, "ana", "model", "m", "ops");
    const next = payload([ana], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" });
    const dry = await runSync(T, next, { dryRun: true, env, by: "ci", extract: okExtract });
    const real = await runSync(T, next, { dryRun: false, env, by: "ci", extract: okExtract });
    expect(dry.unchanged).toEqual(["ana"]);
    expect(real.unchanged).toEqual(["ana"]);
    expect(dry.updated).toEqual(real.updated);
    expect(dry.overridesWiped).toBe(real.overridesWiped);
  });

  test("an extraction failure is logged server-side but not leaked in the failure message", async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
    let e: any;
    try {
      e = await runSync(T, payload([ana]), { dryRun: false, env, by: "ci", extract: async () => { throw new Error("provider said no"); } }).catch((x) => x);
    } finally { console.error = orig; }
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.message).not.toContain("provider said no");
    expect(lines.some((l) => l.includes("persona=ana") && l.includes("provider said no"))).toBe(true);
  });

  test("a stale payload is a 409 before any extraction", async () => {
    await runSync(T, payload([ana], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" }), { dryRun: false, env, by: "ci", extract: okExtract });
    let calls = 0;
    const counting = async () => { calls++; return { approvers: [] }; };
    for (const dryRun of [true, false]) {
      const e = await runSync(T, payload([{ ...ana, soul: "changed" }]), { dryRun, env, by: "ci", extract: counting }).catch((x) => x);
      expect(e.status).toBe(409);
    }
    expect(calls).toBe(0);
  });
});
