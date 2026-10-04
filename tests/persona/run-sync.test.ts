// tests/persona/run-sync.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as P from "../../src/db/personas";
import { runSync, SyncFailure } from "../../src/persona/sync/run";

const T = "default";
const bare = (personas: unknown[], extra: object = {}) =>
  ({ revision: "r1", committedAt: "2026-10-01T10:00:00Z", personas, ...extra });
// A managed tenant always carries its default persona: every non-empty fixture includes it.
const def = { name: "default", soul: "You are the default." };
const payload = (personas: unknown[], extra: object = {}) => bare(personas.length ? [def, ...personas] : personas, extra);
const ana = { name: "ana", slackUserId: "UTESTUSER1", soul: "You are Ana.", userToken: "${PERSONA_ANA_XOXP}" };
const okExtract = async () => ({ approvers: [] });
const env = { PERSONA_ANA_XOXP: "user-token-1" };

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
    expect((await P.effectivePersonas(T)).map((p) => p.name).sort()).toEqual(["ana", "bea", "default"]);
    expect((await P.effectivePersonas(T))[0]!.overridden).toEqual(["model"]);
  });

  test("an unresolved variable is a 422 that names it and applies nothing", async () => {
    const e = await runSync(T, payload([ana]), { dryRun: false, env: {}, by: "ci", extract: okExtract }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toContain("PERSONA_ANA_XOXP");
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
    expect(calls).toBe(2); // once per persona (default and ana), not again on r2
  });

  test("an empty set is refused unless allowEmpty is set", async () => {
    const e = await runSync(T, payload([]), { dryRun: false, env, by: "ci", extract: okExtract }).catch((x) => x);
    expect(e.status).toBe(422);
    await expect(runSync(T, payload([], { allowEmpty: true }), { dryRun: false, env, by: "ci", extract: okExtract })).resolves.toBeDefined();
  });

  test("a non-empty set without the default persona is a 422 and applies nothing", async () => {
    const e = await runSync(T, bare([ana]), { dryRun: false, env, by: "ci", extract: okExtract }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toBe("payload must include the default persona");
    expect(await P.isManaged(T)).toBe(false);
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
    expect(dry.unchanged).toEqual(["default", "ana"]);
    expect(real.unchanged).toEqual(["default", "ana"]);
    expect(dry.updated).toEqual(real.updated);
    expect(dry.overridesWiped).toBe(real.overridesWiped);
  });

  test("an extraction failure is logged server-side but not leaked in the failure message", async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
    let e: any;
    try {
      e = await runSync(T, payload([ana]), { dryRun: false, env, by: "ci", extract: async (t: string) => { if (t === ana.soul) throw new Error("provider said no"); return { approvers: [] }; } }).catch((x) => x);
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

// Refusals happen in phase one, before any database access: no Postgres needed.
describe("runSync payload version and unknown fields", () => {
  const strictEnv = { ...env, SLAUDE_DEPLOY_STRICT: "1" };
  test("a newer payload version is a 422", async () => {
    const e = await runSync(T, payload([], { version: 99 }), { dryRun: true, env, by: "ci", extract: okExtract }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toMatch(/newer than this gateway supports/);
  });
  test("strict mode refuses an unknown field, naming it and never its value", async () => {
    const e = await runSync(T, payload([{ ...ana, visibility: "leaky-value" }], { futureKnob: "leaky-value" }),
      { dryRun: true, env: strictEnv, by: "ci", extract: okExtract }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toContain("futureKnob");
    expect(e.message).toContain("persona.ana.visibility");
    expect(e.message).not.toContain("leaky-value");
  });
  test("strict mode plus a newer version gives the newer-version message", async () => {
    const e = await runSync(T, payload([], { version: 2, v2Knob: 1 }), { dryRun: true, env: strictEnv, by: "ci", extract: okExtract }).catch((x) => x);
    expect(e.status).toBe(422);
    expect(e.message).toMatch(/newer than this gateway supports/);
    expect(e.message).not.toContain("v2Knob");
  });
  test("the strict error is capped for a payload with many unknown keys", async () => {
    const extra = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, 1]));
    const e = await runSync(T, payload([], extra), { dryRun: true, env: strictEnv, by: "ci", extract: okExtract }).catch((x) => x);
    expect(e.status).toBe(422);
    expect(e.message).toContain("…and 4950 more");
    expect(e.message.length).toBeLessThan(1000);
  });
  test("strict mode is off unless the value is exactly 1", async () => {
    // Not refused in phase one: it proceeds to the database (absent here), so any error is not the strict 422.
    const e = await runSync(T, payload([], { futureKnob: 1 }), { dryRun: true, env: { ...env, SLAUDE_DEPLOY_STRICT: "0" }, by: "ci", extract: okExtract }).catch((x) => x);
    expect(String(e?.message ?? "")).not.toContain("SLAUDE_DEPLOY_STRICT");
  });
});

describe.skipIf(process.env.SLAUDE_DB !== "pg")("runSync stage one reporting", () => {
  test("unknown fields are applied-around, reported, and warned by name only", async () => {
    const warn = console.warn; const lines: string[] = [];
    console.warn = (m: string) => { lines.push(String(m)); };
    try {
      const r = await runSync(T, payload([{ ...ana, visibility: "leaky-value" }], { futureKnob: "leaky-value" }),
        { dryRun: false, env, by: "ci", extract: okExtract });
      expect(r.ignoredFields).toEqual(["futureKnob", "persona.ana.visibility"]);
    } finally { console.warn = warn; }
    expect(lines.join("\n")).toContain("persona.ana.visibility");
    expect(lines.join("\n")).not.toContain("leaky-value");
  });
  test("ignoredFields is capped; the total is reported and the log line is bounded", async () => {
    const extra = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, 1]));
    const warn = console.warn; const lines: string[] = [];
    console.warn = (m: string) => { lines.push(String(m)); };
    try {
      const r = await runSync(T, payload([ana], extra), { dryRun: true, env, by: "ci", extract: okExtract });
      expect(r.ignoredFields).toHaveLength(50);
      expect(r.ignoredFieldsTotal).toBe(5000);
    } finally { console.warn = warn; }
    expect(lines.join("").length).toBeLessThan(1000);
  });
  test("a known-field payload reports an empty list", async () => {
    expect((await runSync(T, payload([ana]), { dryRun: true, env, by: "ci", extract: okExtract })).ignoredFields).toEqual([]);
  });
});

describe.skipIf(process.env.SLAUDE_DB !== "pg")("runSync provider references (WS-A §4, §6.3)", () => {
  // References need a gateway: mono refuses them (below).
  const env = { PERSONA_ANA_XOXP: "user-token-1", SLAUDE_ROLE: "gateway" };
  const vaultEnv = {
    ...env,
    SLAUDE_VAULT_ADDR: "https://vault.example.com",
    SLAUDE_VAULT_ROLE: "slaude-gateway",
    SLAUDE_VAULT_ALLOWED_PREFIXES: "secret/slaude/personas/{persona}",
  };
  const withRef = (apiKey: string) => ({ ...ana, model: "m-1", provider: { apiKey } });
  const fail = (p: unknown, e: Record<string, string>) =>
    runSync(T, payload([p]), { dryRun: false, env: e, by: "ci", extract: okExtract }).catch((x) => x);

  test("references are stored as references; no value is resolved at sync", async () => {
    await runSync(T, payload([withRef("env://PERSONA_ANA_KEY")]), { dryRun: false, env, by: "ci", extract: okExtract });
    const p = (await P.desiredPersonas(T)).find((x) => x.name === "ana")!;
    expect(p.provider).toEqual({ apiKey: "env://PERSONA_ANA_KEY" });
  });

  test("a vault:// reference inside the persona's own prefix is accepted", async () => {
    const r = await runSync(T, payload([withRef("vault://secret/slaude/personas/ana#api_key")]),
      { dryRun: false, env: vaultEnv, by: "ci", extract: okExtract });
    expect(r.created).toContain("ana");
  });

  test("a vault:// reference to a sibling's folder is refused at sync, naming persona and field", async () => {
    const e = await fail(withRef("vault://secret/slaude/personas/bea#api_key"), vaultEnv);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toContain("persona 'ana': provider.apiKey");
    expect(e.message).toContain("SLAUDE_VAULT_ALLOWED_PREFIXES");
    expect(e.message).not.toContain("personas/bea");
    expect(await P.isManaged(T)).toBe(false);
  });

  test("a vault:// reference under no configured mount is refused", async () => {
    const e = await fail(withRef("vault://other/slaude/personas/ana#api_key"), vaultEnv);
    expect(e.status).toBe(422);
    expect(e.message).toContain("mount");
  });

  test("mono refuses a payload with provider references, naming the persona, and applies nothing", async () => {
    const e = await fail(withRef("env://PERSONA_ANA_KEY"), { PERSONA_ANA_XOXP: "user-token-1" });
    expect(e.status).toBe(422);
    expect(e.message).toContain("SLAUDE_ROLE=mono");
    expect(e.message).toContain("ana");
    expect(await P.isManaged(T)).toBe(false);
  });

  test("a vault:// reference on a gateway without Vault is refused, not stored to fail every turn", async () => {
    const e = await fail(withRef("vault://secret/slaude/personas/ana#api_key"), env);
    expect(e.status).toBe(422);
    expect(e.message).toContain("SLAUDE_VAULT_ADDR");
  });

  test("provider/model warnings are logged and reported", async () => {
    const warn = console.warn; const lines: string[] = [];
    console.warn = (m: string) => { lines.push(String(m)); };
    try {
      const r = await runSync(T, payload([{ ...ana, provider: { baseUrl: "https://llm.example.com" } }]),
        { dryRun: true, env, by: "ci", extract: okExtract });
      expect(r.warnings.some((w) => w.includes("'ana'"))).toBe(true);
    } finally { console.warn = warn; }
    expect(lines.join("\n")).toContain("'ana'");
  });

  test("a database that predates provider_json refuses the sync loudly", async () => {
    await db.run(`ALTER TABLE personas DROP COLUMN provider_json`);
    try {
      const e = await fail(withRef("env://PERSONA_ANA_KEY"), env);
      expect(e).toBeInstanceOf(SyncFailure);
      expect(e.status).toBe(503);
      expect(e.message).toContain("provider_json");
    } finally {
      await db.run(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS provider_json JSONB`);
    }
  });
});
