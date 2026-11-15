/**
 * Console list of shared environments: read only, superadmin only, names and
 * state, never a host, address, key or hash. And no panel route can write one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import type { EnvironmentsResponse } from "../../src/gateway/panel/api-types";
import { FP, HOST, insertPersonal, insertShared, reset } from "../remote/definitions/helpers";
import { definitionRowId } from "../../src/remote/definitions/resolve";
import * as Envs from "../../src/db/environments";
import { db } from "../../src/db/schema";

const SECRET = "t".repeat(32);
const cookie = (email: string) => `${AT_COOKIE}=${mintSession({ sub: "s", email }, "at", { secret: SECRET })}`;
const superadmin = cookie("lead@example.com");
const operator = cookie("alice@example.com");

const panel = () => createPanelApi({ registry: null, role: "mono", pubsub: null, panelLock: null, chat: async () => {} });
const call = async (method: string, path: string, who = superadmin, body?: unknown) => {
  const res = (await panel().fetch(new Request(`https://panel.example.com${path}`, {
    method, headers: { cookie: who, "x-panel-csrf": "1", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  })))!;
  const text = await res.text();
  return { status: res.status, text };
};

function registry(defs: Record<string, unknown>): PersonaRegistry {
  const full = Object.entries(defs).map(([name, definition]) => ({ name, slackUserId: `UP${name.toUpperCase()}`, config: { slackUserId: "UX", name }, outClient: null, runsOn: null, definition }) as unknown as Persona);
  return {
    lookupByUserId: () => null, lookupByName: (n) => full.find((p) => p.name === n) ?? null, list: () => full,
    isMultiPersonaMode: () => true, isManaged: () => true, tombstonedPersonaFor: () => null, defaultPersona: () => ({ model: null, mcp: null, runsOn: null }),
  };
}

async function seedAgents(tenant: string, agents: Record<string, string[] | null>): Promise<void> {
  const { applySync } = await import("../../src/db/personas");
  const persona = (name: string, allow: string[] | null) => ({
    name, slackUserId: name === "default" ? null : `U${name.toUpperCase()}`, userToken: null, model: null, soulMd: "x", soulJson: {}, mcp: null, provider: null,
    runsOn: null, kbSources: null, background: null,
    definition: allow ? { environment: { allow }, soulData: undefined } : null, origin: "git" as const, tombstonedAt: null,
  });
  await db.run("DELETE FROM personas WHERE tenant_id = ?", [tenant]);
  await db.run("DELETE FROM persona_sync_state WHERE tenant_id = ?", [tenant]);
  await applySync(tenant, [persona("default", null), ...Object.entries(agents).map(([n, a]) => persona(n, a))] as never, { revision: "r1", committedAt: 1, by: "ci" });
}

const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  for (const k of ["SLAUDE_PANEL_SECRET", "SLAUDE_PANEL_SUPERADMIN", "SLAUDE_PANEL_OPERATORS"]) saved[k] = process.env[k];
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
  __resetRoleCache();
  await reset();
  setPersonaRegistry(registry({ scout: { environment: { allow: ["team-sandbox"] } }, ledger: { skills: ["x"] } }));
});
afterEach(async () => {
  if (db.dialect === "pg") {
    await db.run("DELETE FROM personas");
    await db.run("DELETE FROM persona_sync_state");
  }
  __resetPersonaRegistry();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetRoleCache();
});

describe("GET /panel/api/environments: shared", () => {
  test("a superadmin sees name, state, revision, public key and the agents that allow it", async () => {
    await insertShared();
    await insertShared({ name: "old-box", retired: true });
    if (db.dialect === "pg") await seedAgents("default", { scout: ["team-sandbox"], ledger: null });
    const r = await call("GET", "/panel/api/environments");
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text) as EnvironmentsResponse;
    const live = body.shared.find((s) => s.ref === "env:team-sandbox")!;
    expect(live).toMatchObject({ retired: false, allowedBy: ["scout"], publicKey: "ssh-ed25519 AAAAplanted" });
    expect(body.shared.find((s) => s.ref === "env:old-box")).toMatchObject({ retired: true, allowedBy: [] });
  });

  test("no host, address, host key, hash, config or private key is in the payload", async () => {
    await insertShared();
    const r = await call("GET", "/panel/api/environments");
    for (const bad of [HOST, FP, "planted-secret-material", "hostKey", "config", "definition_hash", "default_dir", "def~", definitionRowId("default", "team-sandbox")]) {
      expect(r.text).not.toContain(bad);
    }
  });

  test("an operator gets an empty shared list", async () => {
    await insertShared();
    const r = await call("GET", "/panel/api/environments", operator);
    expect(r.status).toBe(200);
    expect((JSON.parse(r.text) as EnvironmentsResponse).shared).toEqual([]);
    expect(r.text).not.toContain("team-sandbox");
  });

  test("a definition row never appears among the personal environments, and personal rows are unchanged", async () => {
    await insertShared();
    await insertPersonal("U0EXAMPLE", "mine");
    const body = JSON.parse((await call("GET", "/panel/api/environments")).text) as EnvironmentsResponse;
    expect(body.personal.map((p) => p.name)).toEqual(["mine"]);
  });
});

describe.skipIf(process.env.SLAUDE_DB !== "pg")("allowedBy is resolved per row tenant", () => {
  test("a definition of tenant-b lists tenant-b's agents, not the process registry's", async () => {
    await seedAgents("tenant-b", { beta: ["team-sandbox"], gamma: ["other"] });
    await insertShared({ tenant: "tenant-b" });
    const body = JSON.parse((await call("GET", "/panel/api/environments")).text) as EnvironmentsResponse;
    expect(body.shared.find((x) => x.tenant === "tenant-b")?.allowedBy).toEqual(["beta"]);
    await db.run("DELETE FROM personas");
    await db.run("DELETE FROM persona_sync_state");
  });
});

describe("no panel route writes an environment", () => {
  test("a write to the environments routes, with a definition's id, changes nothing", async () => {
    const id = await insertShared();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/panel/api/environments", `/panel/api/environments/${id}`, `/panel/api/environments/${id}/retire`]) {
        const r = await call(method, path, superadmin, { name: "x" });
        expect([404, 405]).toContain(r.status);
      }
    }
    expect(await Envs.getEnv(id)).not.toBeNull();
    expect((await db.one<{ name: string }>("SELECT name FROM environments WHERE id = ?", [id]))?.name).toBe("team-sandbox");
  });

  test("the panel code never imports a write path for environments", () => {
    const dir = join(import.meta.dir, "../../src/gateway/panel");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(dir);
    const offenders = files.filter((f) => /\b(updateEnv|deleteEnv|createEnv|Envs\.bind|putKeyIfAbsent|replaceKey|clearBinding)\b/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
