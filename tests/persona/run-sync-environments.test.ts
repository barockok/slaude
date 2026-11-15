// Environment definition sync through a real runSync. Postgres-only: run with SLAUDE_DB=pg.
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { flushAudits } from "../../src/audit/emit";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { __resetPersonaRegistry } from "../../src/persona/registry";
import { parsePayload } from "../../src/persona/sync/payload";
import { runSync } from "../../src/persona/sync/run";
import { getKey } from "../../src/db/remote";
import { definitionRowId } from "../../src/remote/definitions/resolve";

const isPg = process.env.SLAUDE_DB === "pg";
const T = "default";
const FP = "SHA256:" + "A".repeat(43);
const HOST = "build-box.example.com";
const defaultFile = `name: default\nsoul: You are the default.\nmandate:\n  global: Default mandate.\naccess:\n  manager: UBOSS\n`;
const anaFile = (env = "") => `name: ana\nslackUserId: UANA1\nsoul: You are Ana.\n${env}`;
const envYaml = (name: string, over: { host?: string; dir?: string } = {}) =>
  `name: ${name}\nkind: ssh\nshared: true\ntrust: unlocked\ndefaultDir: ${over.dir ?? "/srv/work"}\nssh:\n  host: ${over.host ?? HOST}\n  user: dev\n  hostKey: "${FP}"\n`;
const allowAna = "environment:\n  allow: [env:team-sandbox]\n";

let n = 0;
function payload(opts: { ana?: string; environments?: Array<{ name: string; yaml: string }> | undefined; committedAt?: string; revision?: string } = {}) {
  n += 1;
  const personas = [parseAgentYaml("default", defaultFile).spec, parseAgentYaml("ana", anaFile(opts.ana ?? "")).spec];
  const used = opts.environments !== undefined || (opts.ana ?? "").includes("environment:");
  return parsePayload({
    version: used ? 7 : 6,
    revision: opts.revision ?? `r${n}`,
    committedAt: opts.committedAt ?? new Date(Date.UTC(2026, 9, 1, 10, n)).toISOString(),
    personas,
    ...(opts.environments !== undefined ? { environments: opts.environments } : {}),
  }, {});
}
const on = { SLAUDE_REMOTE: "1" };
const run = (p: ReturnType<typeof payload>, o: { dryRun?: boolean; env?: Record<string, string>; tenant?: string; generateKey?: never } = {}) =>
  runSync(o.tenant ?? T, p, { dryRun: o.dryRun ?? false, env: o.env ?? on, by: "ci" });
const defs = (tenant = T) => db.query<Record<string, any>>("SELECT * FROM environments WHERE tenant_id = ? AND source = 'definition' ORDER BY name", [tenant]);
const wipe = async () => {
  for (const t of ["env_bindings", "persona_overrides", "persona_sync_state", "personas", "audit_events", "environments", "remote_keys"]) await db.run(`DELETE FROM ${t}`);
  __resetPersonaRegistry();
};

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  if (isPg) await wipe();
});
afterAll(async () => {
  if (isPg) await wipe();
});

describe.skipIf(!isPg)("environment definition sync", () => {
  test("create: a tenant-qualified row, the def~tenant team, a key pair, names only in the report", async () => {
    const r = await run(payload({ environments: [{ name: "team-sandbox", yaml: envYaml("team-sandbox") }] }));
    expect(r.environments).toEqual({ created: ["team-sandbox"], updated: [], revived: [], unchanged: [], retired: [] });
    const row = (await defs())[0]!;
    expect(row).toMatchObject({
      id: definitionRowId(T, "team-sandbox"), tenant_id: T, team_id: `def~${T}`, user_id: "team-sandbox", name: "team-sandbox", kind: "ssh",
      source: "definition", definition_name: "team-sandbox", default_dir: "/srv/work", secrets: null, retired_at: null,
    });
    expect(row.id).toHaveLength(25);
    expect(JSON.parse(row.config)).toMatchObject({ host: HOST, shared: "true", trust: "unlocked" });
    const key = await getKey(`def~${T}`, "team-sandbox");
    expect(key?.publicKey).toStartWith("ssh-ed25519");
    expect(JSON.stringify(r)).not.toContain(HOST);
    expect(JSON.stringify(r)).not.toContain(key!.publicKey.split(" ")[1]!);
  });

  test("a no-op resync writes nothing and moves nothing", async () => {
    const envs = [{ name: "team-sandbox", yaml: envYaml("team-sandbox") }];
    await run(payload({ environments: envs, ana: allowAna }));
    const before = await defs();
    const keyBefore = await getKey(`def~${T}`, "team-sandbox");
    const r = await run(payload({ environments: [{ name: "team-sandbox", yaml: `# comment\nssh:\n  hostKey: "${FP}"\n  user: dev\n  host: ${HOST}\ndefaultDir: /srv/work\ntrust: unlocked\nshared: true\nkind: ssh\nname: team-sandbox\n` }], ana: allowAna }));
    // Same canonical content, different key order and a comment: unchanged.
    expect(r.environments?.unchanged).toEqual(["team-sandbox"]);
    expect(r.unchanged.sort()).toEqual(["ana", "default"]);
    expect(await defs()).toEqual(before);
    expect(await getKey(`def~${T}`, "team-sandbox")).toEqual(keyBefore);
    await flushAudits();
    // Only the first sync changed a definition, so only it has an environment audit row.
    expect((await db.query("SELECT 1 FROM audit_events WHERE action = 'environment.definition_synced'")).length).toBe(1);
  });

  test("a change updates the row and moves updated_at, keeping the key", async () => {
    await run(payload({ environments: [{ name: "team-sandbox", yaml: envYaml("team-sandbox") }] }));
    const a = (await defs())[0]!;
    const keyA = await getKey(`def~${T}`, "team-sandbox");
    const r = await run(payload({ environments: [{ name: "team-sandbox", yaml: envYaml("team-sandbox", { dir: "/srv/other" }) }] }));
    expect(r.environments?.updated).toEqual(["team-sandbox"]);
    const b = (await defs())[0]!;
    expect(b.default_dir).toBe("/srv/other");
    expect(Number(b.updated_at)).toBeGreaterThan(Number(a.updated_at));
    expect(b.definition_hash).not.toBe(a.definition_hash);
    expect(await getKey(`def~${T}`, "team-sandbox")).toEqual(keyA);
  });

  test("an unlisted definition is retired, a relisted one is revived with the same key", async () => {
    const team = { name: "team-sandbox", yaml: envYaml("team-sandbox") };
    await run(payload({ environments: [team] }));
    const key = await getKey(`def~${T}`, "team-sandbox");
    const r1 = await run(payload({ environments: [] }));
    expect(r1.environments?.retired).toEqual(["team-sandbox"]);
    expect((await defs())[0]!.retired_at).not.toBeNull();
    const r2 = await run(payload({ environments: [team] }));
    expect(r2.environments?.revived).toEqual(["team-sandbox"]);
    expect((await defs())[0]!.retired_at).toBeNull();
    expect(await getKey(`def~${T}`, "team-sandbox")).toEqual(key);
  });

  test("a revive or change with no master key is a 422 (not a 500); a retire needs none", async () => {
    const team = { name: "team-sandbox", yaml: envYaml("team-sandbox") };
    await run(payload({ environments: [team] }));
    await run(payload({ environments: [] }));
    const key = process.env.SLAUDE_MASTER_KEY;
    delete process.env.SLAUDE_MASTER_KEY;
    __resetMasterKeyCache();
    try {
      const revive = (await run(payload({ environments: [team] })).catch((x) => x)) as Error & { status: number };
      expect(revive.status).toBe(422);
      expect(revive.message).toContain("SLAUDE_MASTER_KEY");
      expect((await defs())[0]!.retired_at).not.toBeNull();
    } finally {
      process.env.SLAUDE_MASTER_KEY = key;
      __resetMasterKeyCache();
    }
  });

  test("reviving a definition that threads are still bound to is reported, logged and audited", async () => {
    const team = { name: "team-sandbox", yaml: envYaml("team-sandbox") };
    await run(payload({ environments: [team] }));
    const id = (await defs())[0]!.id;
    await db.run("INSERT INTO env_bindings (channel_id, thread_ts, env_id, dir, lock_by_env, generation, last_used_at, created_at) VALUES ('C0EXAMPLE', '1.1', ?, '/srv/work', 0, 0, 1, 1)", [id]);
    await run(payload({ environments: [] }));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await run(payload({ environments: [team] }));
      expect(r.environments?.revivedBound).toEqual({ "team-sandbox": 1 });
      expect(r.warnings.join(" ")).toContain("1 thread is still bound");
      expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("still bound");
    } finally {
      warn.mockRestore();
    }
    await flushAudits();
    const rows = await db.query<{ details: unknown }>("SELECT details FROM audit_events WHERE action = 'environment.definition_synced'");
    expect(JSON.stringify(rows)).toContain("revivedBound");
  });

  test("an absent list leaves stored rows alone; a version 6 payload still deploys", async () => {
    await run(payload({ environments: [{ name: "team-sandbox", yaml: envYaml("team-sandbox") }] }));
    const before = await defs();
    const p = payload();
    expect(p.version).toBe(6);
    const r = await run(p);
    expect(r.environments).toBeUndefined();
    expect(await defs()).toEqual(before);
  });

  test("a dry run reports and writes nothing", async () => {
    const r = await run(payload({ environments: [{ name: "team-sandbox", yaml: envYaml("team-sandbox") }], ana: allowAna }), { dryRun: true });
    expect(r.environments?.created).toEqual(["team-sandbox"]);
    expect(await defs()).toEqual([]);
    expect(await getKey(`def~${T}`, "team-sandbox")).toBeNull();
    expect(await db.query("SELECT 1 FROM personas")).toEqual([]);
  });

  test("a key insert that fails rolls the personas and the row back", async () => {
    const p = payload({ environments: [{ name: "team-sandbox", yaml: envYaml("team-sandbox") }] });
    await expect(runSync(T, p, { dryRun: false, env: on, by: "ci", generateKey: () => { throw new Error("boom"); } })).rejects.toThrow("boom");
    expect(await db.query("SELECT 1 FROM personas")).toEqual([]);
    expect(await defs()).toEqual([]);
    expect(await db.query("SELECT 1 FROM remote_keys")).toEqual([]);
  });

  test("a stale payload applies no environment", async () => {
    await run(payload({ committedAt: "2026-10-05T10:00:00Z" }));
    await expect(run(payload({ committedAt: "2026-10-01T10:00:00Z", environments: [{ name: "team-sandbox", yaml: envYaml("team-sandbox") }] }))).rejects.toMatchObject({ status: 409 });
    expect(await defs()).toEqual([]);
    expect(await db.query("SELECT 1 FROM remote_keys")).toEqual([]);
  });

  test("an agent referencing an environment the deploy does not define is refused naming only what it submitted", async () => {
    // A stored definition the submitter did not name must never appear in a refusal.
    await run(payload({ environments: [{ name: "stored-secret-box", yaml: envYaml("stored-secret-box") }] }));
    const e = (await run(payload({ ana: "environment:\n  allow: [env:nowhere]\n" })).catch((x) => x)) as Error & { status: number };
    expect(e.status).toBe(422);
    expect(e.message).toContain("persona 'ana'");
    expect(e.message).toContain("env:nowhere");
    expect(e.message).not.toContain("stored-secret-box");
    const e2 = (await run(payload({ ana: "environment:\n  allow: [env:nowhere]\n", environments: [{ name: "team-sandbox", yaml: envYaml("team-sandbox") }] })).catch((x) => x)) as Error;
    expect(e2.message).not.toContain("stored-secret-box");
    expect(e2.message).not.toContain("team-sandbox");
  });

  test("a retired definition is refused as a reference when the list is absent", async () => {
    await run(payload({ environments: [{ name: "team-sandbox", yaml: envYaml("team-sandbox") }] }));
    await run(payload({ environments: [] }));
    await expect(run(payload({ ana: allowAna }))).rejects.toMatchObject({ status: 422 });
    // A live one resolves against the stored rows.
    await run(payload({ environments: [{ name: "team-sandbox", yaml: envYaml("team-sandbox") }] }));
    const r = await run(payload({ ana: allowAna }));
    expect(r.updated).toEqual(["ana"]);
  });

  test("SLAUDE_REMOTE off refuses an agent that declares environment and applies nothing", async () => {
    const e = (await run(payload({ ana: allowAna, environments: [{ name: "team-sandbox", yaml: envYaml("team-sandbox") }] }), { env: {} }).catch((x) => x)) as Error & { status: number };
    expect(e.status).toBe(422);
    expect(e.message).toContain("persona 'ana'");
    expect(e.message).toContain("SLAUDE_REMOTE");
    expect(await db.query("SELECT 1 FROM personas")).toEqual([]);
    expect(await defs()).toEqual([]);
    // Agents without the key and no definitions deploy exactly as before.
    await expect(run(payload(), { env: {} })).resolves.toMatchObject({ created: ["default", "ana"] });
  });

  test("a bad definition is a 422 that names the environment and key, never a value", async () => {
    const bad = envYaml("team-sandbox").replace("trust: unlocked\n", "").replace(HOST, "10.0.0.5");
    const e = (await run(payload({ environments: [{ name: "team-sandbox", yaml: bad }] })).catch((x) => x)) as Error & { status: number };
    expect(e.status).toBe(422);
    expect(e.message).toContain("environment 'team-sandbox'");
    expect(e.message).not.toContain("10.0.0.5");
    expect(await defs()).toEqual([]);
  });

  test("two tenants with the same name get distinct ids, teams and keys", async () => {
    const envs = [{ name: "team-sandbox", yaml: envYaml("team-sandbox") }];
    await run(payload({ environments: envs }), { tenant: "tenant-a" });
    await run(payload({ environments: envs }), { tenant: "tenant-b" });
    const a = (await defs("tenant-a"))[0]!;
    const b = (await defs("tenant-b"))[0]!;
    expect(a.id).not.toBe(b.id);
    expect(a.team_id).toBe("def~tenant-a");
    expect(b.team_id).toBe("def~tenant-b");
    const ka = await getKey("def~tenant-a", "team-sandbox");
    const kb = await getKey("def~tenant-b", "team-sandbox");
    expect(ka!.publicKey).not.toBe(kb!.publicKey);
  });

  test("no host or key reaches the report, the logs or the audit trail", async () => {
    const logs: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    try {
      const r = await run(payload({ ana: allowAna, environments: [{ name: "team-sandbox", yaml: envYaml("team-sandbox") }] }));
      await flushAudits();
      const key = (await getKey(`def~${T}`, "team-sandbox"))!;
      const audits = JSON.stringify(await db.query("SELECT * FROM audit_events"));
      expect(audits).toContain("environment.definition_synced");
      for (const out of [JSON.stringify(r), logs.join("\n"), audits]) {
        expect(out).not.toContain(HOST);
        expect(out).not.toContain(FP);
        expect(out).not.toContain(key.publicKey.split(" ")[1]!);
        expect(out).not.toContain("PRIVATE KEY");
      }
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
