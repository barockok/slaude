// A persona from an agent.yaml through a real sync. Postgres-only: run with SLAUDE_DB=pg.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { seedWorkspace } from "../helpers/workspace";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as P from "../../src/db/personas";
import { handleTenantRuntime } from "../../src/gateway/api/tenants";
import { createPanelApi } from "../../src/gateway/panel/api";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { __resetPersonaRegistry, refreshPersonaState, getPersonaRegistry, skillsAllowedFor } from "../../src/persona/registry";
import { parsePayload } from "../../src/persona/sync/payload";
import { runSync } from "../../src/persona/sync/run";

const isPg = process.env.SLAUDE_DB === "pg";
const T = "default";
const META = { revision: "r1", committedAt: "2026-10-01T10:00:00Z" };

const agent = (body: string) => `name: ana\nslackUserId: UANA1\nsoul: You are Ana.\n${body}`;
const defaultFile = `name: default\nsoul: You are the default.\nmandate:\n  global: Default mandate.\naccess:\n  manager: UBOSS\n`;
const body = `model: provider/model
mandate:
  global: Answer support questions.
access:
  manager: UANAMGR
  approvers: [{ user: UBOB, scope: budget, catchall: false }]
skills: [triage]
guardrails: [ghost-rule]
`;
const compile = (name: string, text: string) => parseAgentYaml(name, text).spec;
const payload = (anaBody: string, committedAt = META.committedAt) =>
  parsePayload({ version: 6, revision: META.revision, committedAt, personas: [compile("default", defaultFile), compile("ana", agent(anaBody))] }, {});

const env = {};

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  if (isPg) for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
  if (isPg) await seedWorkspace();
  __resetPersonaRegistry();
});
afterAll(async () => {
  if (isPg) for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
  __resetPersonaRegistry();
});

describe.skipIf(!isPg)("sync of a persona from an agent.yaml", () => {
  test("stores the compiled structure and the definition", async () => {
    await runSync(T, payload(body), { dryRun: false, env, by: "ci" });
    const ana = (await P.effectivePersonas(T)).find((p) => p.name === "ana")!;
    expect(ana.soulMd).toBe("You are Ana.");
    expect((ana.soulJson as { manager: { userId: string } }).manager.userId).toBe("UANAMGR");
    expect(ana.definition).toEqual({ skills: ["triage"], guardrails: ["ghost-rule"] });
  });

  test("a dry run applies nothing; an unknown guardrail is a warning", async () => {
    const r = await runSync(T, payload(body), { dryRun: true, env, by: "ci" });
    expect(r.warnings.join(" ")).toContain("guardrail 'ghost-rule'");
    expect(r.created).toEqual(["default", "ana"]);
  });

  test("an access change with the same prose counts as a change, and a repeat as unchanged", async () => {
    await runSync(T, payload(body), { dryRun: false, env, by: "ci" });
    const same = await runSync(T, payload(body, "2026-10-01T11:00:00Z"), { dryRun: false, env, by: "ci" });
    expect(same.unchanged.sort()).toEqual(["ana", "default"]);
    const changed = await runSync(T, payload(body.replace("UANAMGR", "UOTHER"), "2026-10-01T12:00:00Z"), { dryRun: false, env, by: "ci" });
    expect(changed.updated).toEqual(["ana"]);
    const ana = (await P.effectivePersonas(T)).find((p) => p.name === "ana")!;
    expect((ana.soulJson as { manager: { userId: string } }).manager.userId).toBe("UOTHER");
  });

  test("the registry and the default soul pair see it, and the bundle carries the list", async () => {
    await runSync(T, payload(body), { dryRun: false, env, by: "ci" });
    await refreshPersonaState(T);
    expect(getPersonaRegistry().lookupByName("ana")?.definition?.skills).toEqual(["triage"]);
    expect(skillsAllowedFor("ana")).toEqual(["triage"]);
    const res = await handleTenantRuntime(new Request("https://x/", { headers: { "x-slaude-capabilities": "guardrails/1,agent-definition/1" } }), T, "ana");
    expect(res.status).toBe(200);
    const b = await res.json() as any;
    expect(b.definition).toEqual({ skills: ["triage"], guardrails: ["ghost-rule"] });
    expect(b.soulMd).toBe("You are Ana.");
    expect(b.soulJson.manager.userId).toBe("UANAMGR");
  });

  test("a node without the capability is refused", async () => {
    await runSync(T, payload(body), { dryRun: false, env, by: "ci" });
    await refreshPersonaState(T);
    const old = () => new Request("https://x/", { headers: { "x-slaude-capabilities": "guardrails/1" } });
    expect((await handleTenantRuntime(old(), T, "ana")).status).toBe(409);
  });

  test("moving back to the older layout is refused and leaves the definition live", async () => {
    await runSync(T, payload(body), { dryRun: false, env, by: "ci" });
    const legacy = parsePayload({ ...META, committedAt: "2026-10-02T10:00:00Z", revision: "r2", personas: [{ name: "default", soul: "You are the default." }, { name: "ana", slackUserId: "UANA1", soul: "You are Ana." }] }, {});
    await expect(runSync(T, legacy, { dryRun: false, env, by: "ci" })).rejects.toMatchObject({ status: 422 });
    const ana = (await P.effectivePersonas(T)).find((p) => p.name === "ana")!;
    expect(ana.definition).not.toBeNull();
  });

  test("a console soul override keeps the compiled structure", async () => {
    process.env.SLAUDE_PANEL_SECRET = "t".repeat(32);
    process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
    __resetRoleCache();
    await runSync(T, payload(body), { dryRun: false, env, by: "ci" });
    const panel = createPanelApi({ registry: null, pubsub: { publishReload: async () => 1 } as never, panelLock: null, chat: async () => {} });
    const cookie = `${AT_COOKIE}=${mintSession({ sub: "s", email: "lead@example.com" }, "at", { secret: "t".repeat(32) })}`;
    const res = await panel.fetch(new Request(`https://panel.example.com/panel/api/personas/ana/overrides/soul`, {
      method: "PUT", headers: { cookie, "x-panel-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ value: "New prose." }),
    }));
    expect(res?.status).toBe(200);
    const ana = (await P.effectivePersonas(T)).find((p) => p.name === "ana")!;
    expect(ana.soulMd).toBe("New prose.");
    expect((ana.soulJson as { manager: { userId: string } }).manager.userId).toBe("UANAMGR");
  });
});
