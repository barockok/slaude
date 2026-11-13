// tests/persona/run-sync.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as P from "../../src/db/personas";
import { runSync, SyncFailure, unservedLabelWarnings } from "../../src/persona/sync/run";
import { SUPPORTED_PAYLOAD_VERSION } from "../../src/persona/sync/payload";
import * as AuditEvents from "../../src/db/audit-events";
import { flushAudits } from "../../src/audit/emit";
import { __clearGuardrailsForTests, __setOverrideForTests, applyGuardrailChange, readGuardrails, sha256 } from "../../src/db/guardrails";
import { loadTenantSnapshot } from "../../src/guardrails/snapshot";

const T = "default";
const bare = (personas: unknown[], extra: object = {}) =>
  ({ revision: "r1", committedAt: "2026-10-01T10:00:00Z", personas, ...extra });
// A managed tenant always carries its default persona: every non-empty fixture includes it.
// Every persona carries its agent.yaml definition: a soul with none is refused at sync.
const soulData = (name: string) => ({ identity: { name }, manager: { userId: "UTESTMGR1" } });
const def = { name: "default", soul: "You are the default.", definition: { soulData: soulData("default") } };
const payload = (personas: unknown[], extra: object = {}) => bare(personas.length ? [def, ...personas] : personas, extra);
const ana = { name: "ana", slackUserId: "UTESTUSER1", soul: "You are Ana.", userToken: "${PERSONA_ANA_XOXP}", definition: { soulData: soulData("ana") } };
const env = { PERSONA_ANA_XOXP: "user-token-1" };
const baseEnv = env;

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  // The persona tables are Postgres-only (migration 0011).
  if (process.env.SLAUDE_DB !== "pg") return;
  for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
});

describe.skipIf(process.env.SLAUDE_DB !== "pg")("runSync", () => {
  test("an applied sync records persona.sync with revision and counts; a dry run records nothing", async () => {
    await db.run("DELETE FROM audit_events");
    await runSync(T, payload([ana]), { dryRun: true, env, by: "ci" });
    await runSync(T, payload([ana]), { dryRun: false, env, by: "ci" });
    await flushAudits();
    const rows = (await AuditEvents.list({ action: "persona.sync" })).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorKind: "system", actorId: "ci", tenantId: T, targetKind: "tenant", targetId: T, persona: "default" });
    expect(rows[0]!.details).toMatchObject({ revision: "r1", counts: { created: 2, updated: 0, tombstoned: 0 } });
    expect(JSON.stringify(rows[0])).not.toContain("user-token-1");
  });

  test("applies a set: effective state equals the payload, variables resolved", async () => {
    await runSync(T, payload([ana]), { dryRun: false, env, by: "ci" });
    const [p] = await P.effectivePersonas(T);
    expect(p!.userToken).toBe("user-token-1");
    expect(p!.soulMd).toBe("You are Ana.");
  });

  test("dryRun applies nothing, and reports tombstones and wiped overrides", async () => {
    await runSync(T, payload([ana, { ...ana, name: "bea", slackUserId: "UTESTUSER2" }]), { dryRun: false, env, by: "ci" });
    await P.setOverride(T, "ana", "model", "m", "ops");
    const r = await runSync(T, payload([ana], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" }),
      { dryRun: true, env, by: "ci" });
    expect(r.tombstoned).toEqual(["bea"]);
    expect(r.overridesWiped).toBe(1);
    expect((await P.effectivePersonas(T)).map((p) => p.name).sort()).toEqual(["ana", "bea", "default"]);
    expect((await P.effectivePersonas(T))[0]!.overridden).toEqual(["model"]);
  });

  test("an unresolved variable is a 422 that names it and applies nothing", async () => {
    const e = await runSync(T, payload([ana]), { dryRun: false, env: {}, by: "ci" }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toContain("PERSONA_ANA_XOXP");
    expect(await P.isManaged(T)).toBe(false);
  });

  test("a persona with no agent.yaml is a 422 naming the export command, and leaves the previous revision live", async () => {
    await runSync(T, payload([ana]), { dryRun: false, env, by: "ci" });
    const { definition: _d, ...legacy } = ana;
    const e = await runSync(T, payload([{ ...legacy, soul: "changed" }], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" }),
      { dryRun: false, env, by: "ci" }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toContain("persona 'ana' has no agent.yaml");
    expect(e.message).toContain("personas export --format agent-yaml");
    expect((await P.syncState(T))!.revision).toBe("r1");
  });

  test("a dry run refuses it too, so a preview never reports a sync that would fail", async () => {
    const { definition: _d, ...legacy } = ana;
    const e = await runSync(T, payload([legacy]), { dryRun: true, env, by: "ci" }).catch((x) => x);
    expect(e.status).toBe(422);
  });

  test("an empty set is refused unless allowEmpty is set", async () => {
    const e = await runSync(T, payload([]), { dryRun: false, env, by: "ci" }).catch((x) => x);
    expect(e.status).toBe(422);
    await expect(runSync(T, payload([], { allowEmpty: true }), { dryRun: false, env, by: "ci" })).resolves.toBeDefined();
  });

  test("a non-empty set without the default persona is a 422 and applies nothing", async () => {
    const e = await runSync(T, bare([ana]), { dryRun: false, env, by: "ci" }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toBe("payload must include the default persona");
    expect(await P.isManaged(T)).toBe(false);
  });

  test("an older revision is a 409", async () => {
    await runSync(T, payload([ana], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" }), { dryRun: false, env, by: "ci" });
    const e = await runSync(T, payload([ana]), { dryRun: false, env, by: "ci" }).catch((x) => x);
    expect(e.status).toBe(409);
  });

  test("dry run and real run classify identically when a live override exists", async () => {
    await runSync(T, payload([ana]), { dryRun: false, env, by: "ci" });
    await P.setOverride(T, "ana", "model", "m", "ops");
    const next = payload([ana], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" });
    const dry = await runSync(T, next, { dryRun: true, env, by: "ci" });
    const real = await runSync(T, next, { dryRun: false, env, by: "ci" });
    expect(dry.unchanged).toEqual(["default", "ana"]);
    expect(real.unchanged).toEqual(["default", "ana"]);
    expect(dry.updated).toEqual(real.updated);
    expect(dry.overridesWiped).toBe(real.overridesWiped);
  });

  test("a stale payload is a 409 before anything else is checked", async () => {
    await runSync(T, payload([ana], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" }), { dryRun: false, env, by: "ci" });
    for (const dryRun of [true, false]) {
      const e = await runSync(T, payload([{ ...ana, soul: "changed" }]), { dryRun, env, by: "ci" }).catch((x) => x);
      expect(e.status).toBe(409);
    }
  });
});

// Refusals happen in phase one, before any database access: no Postgres needed.
describe("runSync payload version and unknown fields", () => {
  const strictEnv = { ...env, SLAUDE_DEPLOY_STRICT: "1" };
  test("a newer payload version is a 422", async () => {
    const e = await runSync(T, payload([], { version: 99 }), { dryRun: true, env, by: "ci" }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toMatch(/newer than this gateway supports/);
  });
  test("strict mode refuses an unknown field, naming it and never its value", async () => {
    const e = await runSync(T, payload([{ ...ana, visibility: "leaky-value" }], { futureKnob: "leaky-value" }),
      { dryRun: true, env: strictEnv, by: "ci" }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toContain("futureKnob");
    expect(e.message).toContain("persona.ana.visibility");
    expect(e.message).not.toContain("leaky-value");
  });
  test("strict mode plus a newer version gives the newer-version message", async () => {
    const e = await runSync(T, payload([], { version: SUPPORTED_PAYLOAD_VERSION + 1, v2Knob: 1 }), { dryRun: true, env: strictEnv, by: "ci" }).catch((x) => x);
    expect(e.status).toBe(422);
    expect(e.message).toMatch(/newer than this gateway supports/);
    expect(e.message).not.toContain("v2Knob");
  });
  test("the strict error is capped for a payload with many unknown keys", async () => {
    const extra = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, 1]));
    const e = await runSync(T, payload([], extra), { dryRun: true, env: strictEnv, by: "ci" }).catch((x) => x);
    expect(e.status).toBe(422);
    expect(e.message).toContain("…and 4950 more");
    expect(e.message.length).toBeLessThan(1000);
  });
  test("strict is the default (v0.45.0): unset refuses an unknown field", async () => {
    const e = await runSync(T, payload([], { futureKnob: 1 }), { dryRun: true, env, by: "ci" }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toContain("futureKnob");
  });
  test("SLAUDE_DEPLOY_STRICT=0 (any off spelling) turns strict mode off; an unknown value stays strict", async () => {
    // Not refused in phase one: it proceeds to the database (absent here), so any error is not the strict 422.
    for (const off of ["0", "false", "no", "off"]) {
      const e = await runSync(T, payload([], { futureKnob: 1 }), { dryRun: true, env: { ...env, SLAUDE_DEPLOY_STRICT: off }, by: "ci" }).catch((x) => x);
      expect(String(e?.message ?? "")).not.toContain("SLAUDE_DEPLOY_STRICT");
    }
    const e = await runSync(T, payload([], { futureKnob: 1 }), { dryRun: true, env: { ...env, SLAUDE_DEPLOY_STRICT: "loose" }, by: "ci" }).catch((x) => x);
    expect(e.status).toBe(422);
  });
});

// Stage one is the opt-out since v0.45.0 (strict is the default): these run
// with SLAUDE_DEPLOY_STRICT=0.
describe.skipIf(process.env.SLAUDE_DB !== "pg")("runSync stage one reporting (SLAUDE_DEPLOY_STRICT=0)", () => {
  const env = { ...baseEnv, SLAUDE_DEPLOY_STRICT: "0" };
  test("unknown fields are applied-around, reported, and warned by name only", async () => {
    const warn = console.warn; const lines: string[] = [];
    console.warn = (m: string) => { lines.push(String(m)); };
    try {
      const r = await runSync(T, payload([{ ...ana, visibility: "leaky-value" }], { futureKnob: "leaky-value" }),
        { dryRun: false, env, by: "ci" });
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
      const r = await runSync(T, payload([ana], extra), { dryRun: true, env, by: "ci" });
      expect(r.ignoredFields).toHaveLength(50);
      expect(r.ignoredFieldsTotal).toBe(5000);
    } finally { console.warn = warn; }
    expect(lines.join("").length).toBeLessThan(1000);
  });
  test("a known-field payload reports an empty list", async () => {
    expect((await runSync(T, payload([ana]), { dryRun: true, env, by: "ci" })).ignoredFields).toEqual([]);
  });
});

describe.skipIf(process.env.SLAUDE_DB !== "pg")("runSync kbSources (WS-C §4.1)", () => {
  const withKb = (kbSources: unknown) => ({ ...ana, kbSources });
  const run = (p: unknown, o: { dryRun?: boolean; installed?: string[] } = {}) =>
    runSync(T, payload([p]), { dryRun: o.dryRun ?? false, env, by: "ci", installedKbSources: () => o.installed ?? ["kb-runbook"] });

  test("null, [] and a list are stored as written", async () => {
    await runSync(T, payload([withKb(["kb-runbook"]), { ...ana, name: "bea", slackUserId: "UTESTUSER2", kbSources: [] }]),
      { dryRun: false, env, by: "ci", installedKbSources: () => ["kb-runbook"] });
    const by = new Map((await P.desiredPersonas(T)).map((p) => [p.name, p.kbSources]));
    expect(by.get("ana")).toEqual(["kb-runbook"]);
    expect(by.get("bea")).toEqual([]);
    expect(by.get("default")).toBeNull();
  });

  test("an id that matches no installed KB is a warning, and the persona is applied", async () => {
    const r = await run(withKb(["kb-runbook", "kb-not-installed"]));
    expect(r.created).toContain("ana");
    expect(r.warnings.filter((w) => w.includes("kbSources"))).toEqual([
      "persona 'ana' lists kb-not-installed in kbSources, but no such knowledge base is installed; it reads nothing from it until one is",
    ]);
  });

  test("a malformed id is a 422 that applies nothing", async () => {
    const e = await run(withKb(["Runbook"])).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toContain("persona 'ana': kbSources[0]");
    expect(await P.isManaged(T)).toBe(false);
  });

  test("a database that predates kb_sources refuses the sync loudly", async () => {
    await db.run(`ALTER TABLE personas DROP COLUMN kb_sources`);
    try {
      const e = await run(withKb([])).catch((x) => x);
      expect(e).toBeInstanceOf(SyncFailure);
      expect(e.status).toBe(503);
      expect(e.message).toContain("kb_sources");
    } finally {
      await db.run(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS kb_sources JSONB`);
    }
  });
});

// Node labels spec §4.5.
describe("runsOn", () => {
  test("a label no live node carries is a warning naming persona and label", () => {
    expect(unservedLabelWarnings([{ name: "ana", runsOn: "finance" }, { name: "bea", runsOn: null }, { name: "cy", runsOn: "default" }],
      new Set(["default"]))).toEqual(["persona 'ana': no live node carries label 'finance'; its turns wait until one does"]);
    expect(unservedLabelWarnings([{ name: "ana", runsOn: "finance" }], new Set(["finance"]))).toEqual([]);
  });

  test("a malformed label is a 422 before any database access", async () => {
    const e = await runSync(T, payload([{ ...ana, runsOn: "Finance" }]), { dryRun: true, env, by: "ci" }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toContain("runsOn");
  });

  test.skipIf(process.env.SLAUDE_DB !== "pg")("runsOn is stored, a relabel is an update, and an unserved label is applied with a warning", async () => {
    const live = async () => new Set(["default", "engineering"]);
    const r1 = await runSync(T, payload([{ ...ana, runsOn: "engineering" }]), { dryRun: false, env, by: "ci", liveLabels: live });
    const labelW = (w: string[]) => w.filter((x) => x.includes("no live node carries"));
    expect(labelW(r1.warnings)).toEqual([]);
    expect((await P.effectivePersonas(T)).find((p) => p.name === "ana")!.runsOn).toBe("engineering");
    const second = payload([{ ...ana, runsOn: "finance" }], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" });
    const dry = await runSync(T, second, { dryRun: true, env, by: "ci", liveLabels: live });
    expect(dry.updated).toEqual(["ana"]);
    expect(labelW(dry.warnings)).toHaveLength(1);
    const r2 = await runSync(T, second, { dryRun: false, env, by: "ci", liveLabels: live });
    expect(r2.updated).toEqual(["ana"]);
    expect(labelW(r2.warnings)[0]).toContain("'finance'");
    expect((await P.effectivePersonas(T)).find((p) => p.name === "ana")!.runsOn).toBe("finance");
  });

  test.skipIf(process.env.SLAUDE_DB !== "pg")("a failing label read does not fail the deploy", async () => {
    const warn = console.warn; console.warn = () => {};
    try {
      const r = await runSync(T, payload([{ ...ana, runsOn: "engineering" }]), {
        dryRun: false, env, by: "ci", liveLabels: async () => { throw new Error("redis down"); },
      });
      expect(r.warnings.filter((x) => x.includes("no live node carries"))).toEqual([]);
      expect(r.created).toContain("ana");
    } finally { console.warn = warn; }
  });

  test.skipIf(process.env.SLAUDE_DB !== "pg")("one warnings array carries the provider, the label and the KB warnings", async () => {
    const warn = console.warn; console.warn = () => {};
    try {
      const r = await runSync(T, payload([{ ...ana, runsOn: "finance", kbSources: ["kb-not-installed"], provider: { baseUrl: "https://llm.example.com", apiKey: "env://PERSONA_ANA_KEY" } }]), {
        dryRun: true, env: { ...env, PERSONA_ANA_KEY: "k", SLAUDE_ROLE: "gateway" }, by: "ci",
        liveLabels: async () => new Set(["default"]), installedKbSources: () => ["kb-runbook"],
      });
      expect(r.warnings.some((w) => w.includes("no live node carries label 'finance'"))).toBe(true);
      expect(r.warnings.some((w) => w.includes("provider.baseUrl") && w.includes("'ana'"))).toBe(true);
      expect(r.warnings.some((w) => w.includes("kb-not-installed") && w.includes("'ana'"))).toBe(true);
    } finally { console.warn = warn; }
  });
});

describe.skipIf(process.env.SLAUDE_DB !== "pg")("runSync provider references (WS-A §4, §6.3)", () => {
  // References need a gateway: mono refuses them (below).
  const env = { PERSONA_ANA_XOXP: "user-token-1", PERSONA_ANA_KEY: "ana-key-value", SLAUDE_ROLE: "gateway" };
  const vaultEnv = {
    ...env,
    SLAUDE_VAULT_ADDR: "https://vault.example.com",
    SLAUDE_VAULT_ROLE: "slaude-gateway",
    SLAUDE_VAULT_ALLOWED_PREFIXES: "secret/slaude/personas/{persona}",
  };
  const withRef = (apiKey: string) => ({ ...ana, model: "m-1", provider: { apiKey } });
  const fail = (p: unknown, e: Record<string, string>) =>
    runSync(T, payload([p]), { dryRun: false, env: e, by: "ci" }).catch((x) => x);

  test("references are stored as references; no value is resolved at sync", async () => {
    await runSync(T, payload([withRef("env://PERSONA_ANA_KEY")]), { dryRun: false, env, by: "ci" });
    const p = (await P.desiredPersonas(T)).find((x) => x.name === "ana")!;
    expect(p.provider).toEqual({ apiKey: "env://PERSONA_ANA_KEY" });
  });

  test("a vault:// reference inside the persona's own prefix is accepted", async () => {
    const r = await runSync(T, payload([withRef("vault://secret/slaude/personas/ana#api_key")]),
      { dryRun: false, env: vaultEnv, by: "ci" });
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

  test("an env:// reference to an unset variable fails the sync, naming it, never echoing a value", async () => {
    const e = await fail(withRef("env://PERSONA_ANA_TYPO"), env);
    expect(e.status).toBe(422);
    expect(e.message).toContain("persona 'ana': provider.apiKey");
    expect(e.message).toContain("PERSONA_ANA_TYPO");
    expect(e.message).not.toContain("ana-key-value");
    expect(await P.isManaged(T)).toBe(false);
  });

  // Re-check F3: dropping provider silently changes whose credentials run.
  test("a sync that removes provider from a persona warns, naming it", async () => {
    await runSync(T, payload([withRef("env://PERSONA_ANA_KEY")]), { dryRun: false, env, by: "ci" });
    const next = payload([{ ...ana, model: "m-1" }], { revision: "r2", committedAt: "2026-10-01T11:00:00Z" });
    const dry = await runSync(T, next, { dryRun: true, env, by: "ci" });
    expect(dry.updated).toEqual(["ana"]);
    expect(dry.warnings).toContain("persona 'ana' no longer declares provider; it now uses tenant/node credentials");
    const r = await runSync(T, next, { dryRun: false, env, by: "ci" });
    expect(r.updated).toEqual(["ana"]);
    expect(r.warnings).toEqual(["persona 'ana' no longer declares provider; it now uses tenant/node credentials"]);
    const again = await runSync(T, payload([{ ...ana, model: "m-1" }], { revision: "r3", committedAt: "2026-10-01T12:00:00Z" }),
      { dryRun: false, env, by: "ci" });
    expect(again.warnings).toEqual([]);
  });

  test("a persona with a baseUrl and no credential is refused at sync (M-1)", async () => {
    const e = await fail({ ...ana, model: "m-1", provider: { baseUrl: "https://llm.example.com" } }, env);
    expect(e.status).toBe(422);
    expect(e.message).toContain("persona 'ana': provider.baseUrl");
  });

  test("an internal host from the gateway's SLAUDE_OUTBOUND_INTERNAL_HOSTS may use http", async () => {
    const p = { ...ana, model: "m-1", provider: { baseUrl: "http://llm.internal.example", apiKey: "env://PERSONA_ANA_KEY" } };
    expect((await fail(p, env)).status).toBe(422);
    const r = await runSync(T, payload([p]), { dryRun: true, env: { ...env, SLAUDE_OUTBOUND_INTERNAL_HOSTS: "llm.internal.example" }, by: "ci" });
    expect(r.created).toContain("ana");
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
      const r = await runSync(T, payload([{ ...ana, provider: { baseUrl: "https://llm.example.com", apiKey: "env://PERSONA_ANA_KEY" } }]),
        { dryRun: true, env, by: "ci" });
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

describe.skipIf(process.env.SLAUDE_DB !== "pg")("runSync: guardrails", () => {
  const g = (slug: string, body = "prose", front = "") => ({ slug, md: `---\nname: ${slug}\n${front}---\n${body}\n` });
  const v5 = (guardrails: unknown[], extra: object = {}) => payload([ana], { version: 5, guardrails, ...extra });
  let rev = 0;
  const next = () => ({ revision: `g${++rev}`, committedAt: new Date(Date.parse("2026-10-02T00:00:00Z") + rev * 1000).toISOString() });
  beforeEach(() => __clearGuardrailsForTests());

  test("the payload's list becomes the git set: created, unchanged, removed; signed and audited", async () => {
    await db.run("DELETE FROM audit_events");
    const r1 = await runSync(T, v5([g("a"), g("b")], next()), { dryRun: false, env, by: "ci" });
    expect(r1.guardrails).toMatchObject({ created: ["a", "b"], removed: [] });
    const r2 = await runSync(T, v5([g("a")], next()), { dryRun: false, env, by: "ci" });
    expect(r2.guardrails).toMatchObject({ unchanged: ["a"], removed: ["b"] });
    expect((await readGuardrails()).rows.map((r) => [r.slug, r.source])).toEqual([["a", "git"]]);
    expect((await loadTenantSnapshot(T)).resolved.map((x) => x.slug)).toEqual(["a"]);
    await flushAudits();
    const acts = (await AuditEvents.list({ action: "guardrail." })).items.map((e) => `${e.action}:${e.targetId}`).sort();
    expect(acts).toEqual(["guardrail.created:a", "guardrail.created:b", "guardrail.deleted:b"]);
  });

  test("absent leaves the git set alone; a dry run reports and writes nothing", async () => {
    await runSync(T, v5([g("a")], next()), { dryRun: false, env, by: "ci" });
    const absent = await runSync(T, payload([ana], next()), { dryRun: false, env, by: "ci" });
    expect(absent.guardrails).toBeUndefined();
    expect((await readGuardrails()).rows).toHaveLength(1);
    const dry = await runSync(T, v5([g("a", "changed"), g("c")], next()), { dryRun: true, env, by: "ci" });
    expect(dry.guardrails).toMatchObject({ created: ["c"], updated: ["a"] });
    expect((await readGuardrails()).rows.map((r) => r.slug)).toEqual(["a"]);
  });

  test("an override is kept and reported behind source; host-file and unknown agents are reported", async () => {
    await applyGuardrailChange(T, { upsert: [{ slug: "host", md: g("host").md, source: "file" }], by: "cli" });
    await runSync(T, v5([g("a")], next()), { dryRun: false, env, by: "ci" });
    await __setOverrideForTests(T, { slug: "a", md: g("a", "mine").md, baseSha: sha256(g("a").md), author: "op" });
    const r = await runSync(T, v5([g("a", "moved"), g("lonely", "p", "scope: agents\nagents: [nobody]\n")], next()), { dryRun: false, env, by: "ci" });
    expect(r.guardrails!.behindSource).toEqual(["a"]);
    expect(r.warnings.join("\n")).toContain("names agent 'nobody'");
    expect(r.warnings.join("\n")).toContain("guardrail 'a' has a console override");
    const s = await loadTenantSnapshot(T);
    expect(s.resolved.find((x) => x.slug === "a")!.doc).toMatchObject({ override: true, behindSource: true });
    expect(s.resolved.find((x) => x.slug === "host")!.doc.source).toBe("file");
    // A git guardrail named like a host file takes it over; the host file one stays only if git does not list it.
    expect((await readGuardrails()).rows.map((x) => x.slug)).toEqual(["a", "host", "lonely"]);
  });

  test("a rule that fails to parse refuses the whole sync with a 422, before anything is applied", async () => {
    const bad = g("broken", "p", "") ;
    bad.md += "\n```rules\n- id: r\n  on: tool\n  match: { tool: Bash, input: '(' }\n  action: deny\n```\n";
    const e = await runSync(T, v5([g("fine"), bad], next()), { dryRun: false, env, by: "ci" }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toContain("guardrail 'broken'");
    expect((await readGuardrails()).rows).toEqual([]);
    const noFront = { slug: "nofront", md: "```rules\n- id: r\n  on: inbound\n  match: { text: x }\n  action: deny\n```" };
    const e2 = await runSync(T, v5([noFront], next()), { dryRun: true, env, by: "ci" }).catch((x) => x);
    expect(e2.status).toBe(422);
    expect(e2.message).toContain("rules would apply to nobody");
  });

  test("a reserved name (new, test) is refused for a new guardrail (422); one already stored deploys as before", async () => {
    const e = await runSync(T, v5([g("fine"), g("test")], next()), { dryRun: false, env, by: "ci" }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toContain("'test' is reserved for a new guardrail");
    expect((await readGuardrails()).rows).toEqual([]);
    // Stored before the name was reserved: the deploy repo keeps updating it.
    await applyGuardrailChange(T, { upsert: [{ slug: "test", md: g("test").md, source: "git" }], by: "old" });
    const r = await runSync(T, v5([g("test", "changed")], next()), { dryRun: false, env, by: "ci" });
    expect(r.guardrails).toMatchObject({ updated: ["test"] });
    expect((await readGuardrails()).rows.map((x) => [x.slug, x.md])).toEqual([["test", g("test", "changed").md]]);
  });

  test("on Postgres without SLAUDE_MASTER_KEY a guardrail change is a 422 before anything is applied; an unchanged set is not", async () => {
    const plain = (guardrails: unknown[], extra: object = {}) => bare([def], { version: 5, guardrails, ...extra });
    // A persona set that stores no secret (no userToken), so only the guardrails need the key.
    await runSync(T, plain([g("a")], next()), { dryRun: false, env, by: "ci" });
    const before = (await P.syncState(T))!.revision;
    const saved = process.env.SLAUDE_MASTER_KEY;
    delete process.env.SLAUDE_MASTER_KEY;
    __resetMasterKeyCache();
    try {
      const e = await runSync(T, plain([g("a"), g("b")], next()), { dryRun: false, env, by: "ci" }).catch((x) => x);
      expect(e).toBeInstanceOf(SyncFailure);
      expect(e.status).toBe(422);
      expect(e.message).toBe("guardrails on Postgres need SLAUDE_MASTER_KEY");
      // The personas were not applied: the live revision is the one before.
      expect((await P.syncState(T))!.revision).toBe(before);
      const removing = await runSync(T, plain([], next()), { dryRun: false, env, by: "ci" }).catch((x) => x);
      expect(removing.status).toBe(422);
      // Nothing to change in the guardrails: the personas sync goes through.
      const same = await runSync(T, plain([g("a")], next()), { dryRun: false, env, by: "ci" });
      expect(same.guardrails!.unchanged).toEqual(["a"]);
    } finally {
      process.env.SLAUDE_MASTER_KEY = saved;
      __resetMasterKeyCache();
    }
  });

  test("a host-file guardrail taken over by the deploy repo is reported", async () => {
    await applyGuardrailChange(T, { upsert: [{ slug: "host", md: g("host").md, source: "file" }], by: "cli" });
    const r = await runSync(T, v5([g("host", "from git")], next()), { dryRun: false, env, by: "ci" });
    expect(r.guardrails!.takenOver).toEqual(["host"]);
    expect(r.warnings.join("\n")).toContain("guardrail 'host' was imported from host files");
    expect((await readGuardrails()).rows.map((x) => [x.slug, x.source])).toEqual([["host", "git"]]);
  });

  test("an invalid guardrail is stored and reported, the sync still applies", async () => {
    const r = await runSync(T, v5([{ slug: "bad", md: "no frontmatter" }], next()), { dryRun: false, env, by: "ci" });
    expect(r.guardrails!.invalid[0]!.slug).toBe("bad");
    expect((await readGuardrails()).rows.map((x) => x.slug)).toEqual(["bad"]);
  });
});

afterAll(async () => {
  if (process.env.SLAUDE_DB === "pg") await __clearGuardrailsForTests();
});
