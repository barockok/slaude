// Definition sync creates the records its references name. Postgres-only: run with SLAUDE_DB=pg.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as Domain from "../../src/db/domain";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { __resetPersonaRegistry } from "../../src/persona/registry";
import { parsePayload } from "../../src/persona/sync/payload";
import { runSync, SyncFailure } from "../../src/persona/sync/run";
import { clearWorkspaces, seedWorkspace } from "../helpers/workspace";

const isPg = process.env.SLAUDE_DB === "pg";
const T = "default";
const WS = "T0EXAMPLE";
const env = {};
const defaultFile = `name: default\nsoul: You are the default.\n`;
const anaFile = (access: string) => `name: ana\nslackUserId: UANA1\nsoul: You are Ana.\naccess:\n${access}`;
const compile = (name: string, text: string) => parseAgentYaml(name, text).spec;
let n = 0;
const payload = (access: string) =>
  parsePayload({ version: 6, revision: `r${n}`, committedAt: new Date(Date.UTC(2026, 10, 14, 10, 0, n++)).toISOString(), personas: [compile("default", defaultFile), compile("ana", anaFile(access))] }, {});
const ACCESS = `  manager: slack:user:U0EXAMPLE\n  channels:\n    public: [slack:channel:C0EXAMPLE]\n`;
const count = async (t: string) => Number((await db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n);

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  if (!isPg) return;
  for (const t of ["persona_overrides", "persona_sync_state", "personas", "user_aliases", "bindings", "boundaries", "users", "slack_apps"]) await db.run(`DELETE FROM ${t}`);
  await db.run("DELETE FROM audit_events");
  await seedWorkspace(T, WS);
  __resetPersonaRegistry();
});
afterAll(async () => {
  if (isPg) await clearWorkspaces();
  __resetPersonaRegistry();
});

describe.skipIf(!isPg)("sync creates declared records", () => {
  test("creates, reports and audits them; a rerun creates nothing", async () => {
    const r = await runSync(T, payload(ACCESS), { dryRun: false, env, by: "ci" });
    expect(r.records.created.map((x) => x.ref).sort()).toEqual([`slack:channel:${WS}/C0EXAMPLE`, `slack:user:${WS}/U0EXAMPLE`]);
    expect(r.records.created.every((x) => x.state === "declared" && x.id && x.personas.join() === "ana")).toBe(true);
    expect(r.warnings.join(" ")).toContain("2 reference(s) will create declared records");
    const b = await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE" });
    expect(b?.state).toBe("declared");
    expect((await Domain.findBoundary({ service: "slack", workspace: WS, value: "C0EXAMPLE" }))?.state).toBe("declared");
    const actions = (await db.query<{ action: string }>("SELECT action FROM audit_events WHERE action LIKE '%.created'")).map((x) => x.action).sort();
    expect(actions).toEqual(["binding.created", "boundary.created", "user.created"]);
    const again = await runSync(T, payload(ACCESS), { dryRun: false, env, by: "ci" });
    expect(again.records.created).toEqual([]);
    expect(await count("bindings")).toBe(1);
    expect(await count("boundaries")).toBe(1);
  });

  test("a dry run reports would-create and writes nothing", async () => {
    const r = await runSync(T, payload(ACCESS), { dryRun: true, env, by: "ci" });
    expect(r.records.created).toEqual([]);
    expect(r.records.wouldCreate).toHaveLength(2);
    expect(await count("bindings")).toBe(0);
    expect(await count("boundaries")).toBe(0);
    expect(await count("users")).toBe(0);
  });

  test("strict refuses a reference that would create a record, applies nothing, and passes once the record exists", async () => {
    const e = await runSync(T, payload(ACCESS), { dryRun: false, strict: true, env, by: "ci" }).catch((x) => x);
    expect(e).toBeInstanceOf(SyncFailure);
    expect(e.status).toBe(422);
    expect(e.message).toContain("slack:user:T0EXAMPLE/U0EXAMPLE");
    expect(e.message).toContain("slack:channel:T0EXAMPLE/C0EXAMPLE");
    expect(await count("personas")).toBe(0);
    expect(await count("bindings")).toBe(0);
    await runSync(T, payload(ACCESS), { dryRun: false, env, by: "ci" });
    const ok = await runSync(T, payload(ACCESS), { dryRun: false, strict: true, env, by: "ci" });
    expect(ok.records.created).toEqual([]);
  });

  test("with no workspace connected a sync succeeds with a warning and creates no Slack records", async () => {
    await db.run("DELETE FROM slack_apps");
    const r = await runSync(T, payload(ACCESS), { dryRun: false, env, by: "ci" });
    expect(r.warnings).toContain("no Slack workspace is connected, records for Slack references were not created");
    expect(r.records.created).toEqual([]);
    expect(await count("personas")).toBe(2);
    expect(await count("bindings")).toBe(0);
    expect(await count("boundaries")).toBe(0);
  });

  test("a short Slack reference is refused with several workspaces, naming persona and field", async () => {
    await db.run("DELETE FROM slack_apps");
    await seedWorkspace(T, WS, "A1");
    await seedWorkspace(T, "T1EXAMPLE", "A2");
    const many = await runSync(T, payload(ACCESS), { dryRun: true, env, by: "ci" }).catch((x) => x);
    expect(many.status).toBe(422);
    expect(many.message).toContain("persona 'ana': access.manager");
    expect(many.message).toContain("2 Slack workspaces");
    expect(await count("personas")).toBe(0);
  });

  test("a typo creates an empty declared record that the report lists", async () => {
    const r = await runSync(T, payload(`  manager: slack:user:U0EXAMPL\n`), { dryRun: false, env, by: "ci" });
    expect(r.records.created.map((x) => x.ref)).toEqual([`slack:user:${WS}/U0EXAMPL`]);
    const b = await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPL" });
    expect(b?.state).toBe("declared");
  });

  test("existing verified and observed state is not downgraded", async () => {
    await Domain.ensureBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE", state: "verified", source: "test" });
    await Domain.ensureBoundary({ service: "slack", workspace: WS, value: "C0EXAMPLE", kind: "channel", state: "observed" });
    const r = await runSync(T, payload(ACCESS), { dryRun: false, strict: true, env, by: "ci" });
    expect(r.records.created).toEqual([]);
    expect((await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE" }))?.state).toBe("verified");
    expect((await Domain.findBoundary({ service: "slack", workspace: WS, value: "C0EXAMPLE" }))?.state).toBe("observed");
  });

  test("more than 20 created records also write one summary event", async () => {
    const ids = Array.from({ length: 22 }, (_, i) => `slack:user:U${String(i).padStart(2, "0")}EXAMPLE`);
    const r = await runSync(T, payload(`  dm: [${ids.join(", ")}]\n`), { dryRun: false, env, by: "ci" });
    expect(r.records.created).toHaveLength(22);
    const rows = await db.query<{ details: unknown }>("SELECT details FROM audit_events WHERE action = 'domain.sync_created'");
    expect(rows).toHaveLength(1);
    const small = await runSync(T, payload(`  dm: [slack:user:U99EXAMPLE]\n`), { dryRun: false, env, by: "ci" });
    expect(small.records.created).toHaveLength(1);
    expect(await count("audit_events")).toBeGreaterThan(0);
    expect((await db.query("SELECT 1 FROM audit_events WHERE action = 'domain.sync_created'")).length).toBe(1);
  });
});
