import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as Envs from "../../src/db/environments";
import * as OneOnOne from "../../src/db/one-on-one";
import { handleEnvCommand, removeEnvironment, useEnvironment, type EnvCommandDeps } from "../../src/gateway/core/env-command";
import { __setDecisionDepsForTests } from "../../src/remote/definitions/decision";
import { definitionRowId } from "../../src/remote/definitions/resolve";
import { bindShared, FP, HOST, insertPersonal, insertShared, PRIV, reset } from "../remote/definitions/helpers";
import { db } from "../../src/db/schema";

let replies: string[], privately: string[], reloads: number, preflights: any[];
let allows: Record<string, string[]>;
const ctx = (over: { personaId?: string; tenantId?: string; userId?: string } = {}) => ({
  teamId: "T0EXAMPLE", channelId: "C0EXAMPLE", threadTs: "1.1", userId: over.userId ?? "U0EXAMPLE", sessionId: "S1", isManager: false,
  personaId: over.personaId ?? "agent-a", tenantId: over.tenantId ?? "default",
  reply: async (t: string) => { replies.push(t); },
  sayPrivately: async (t: string) => { privately.push(t); },
  reload: () => { reloads++; },
});
const deps = (): EnvCommandDeps => ({
  preflight: async (i) => { preflights.push(i); return { ok: true, dir: i.dir }; },
  cleanup: async () => {},
  status: async () => "reachable",
  provision: async () => {},
  generateKeyPair: (c) => ({ privateKey: `PRIV-${c}`, publicKey: `ssh-ed25519 AAAA ${c}` }),
  validKey: () => true,
  listForeignThreadCrons: async () => 0,
});
const out = () => [...replies, ...privately].join("\n");
const noLeak = () => {
  for (const bad of [HOST, FP, "planted-secret-material", "ssh-ed25519 AAAAplanted", "def~", PRIV]) expect(out()).not.toContain(bad);
  expect(out()).not.toMatch(/\b[0-9a-f]{16}\b/);
};

beforeEach(async () => {
  await reset();
  process.env.SLAUDE_REMOTE = "1";
  replies = []; privately = []; reloads = 0; preflights = [];
  allows = { "agent-a": ["team-sandbox"] };
  __setDecisionDepsForTests({ allowed: async (_t, p) => allows[p] ?? [] });
});
afterEach(() => {
  delete process.env.SLAUDE_REMOTE;
  __setDecisionDepsForTests(null);
});

describe("/env use env:<name>", () => {
  it("an allowing agent binds the thread, warns that the machine is shared, and locks nothing", async () => {
    await insertShared();
    await handleEnvCommand({ kind: "env", action: "use", name: "env:team-sandbox" }, ctx(), deps());
    const b = await Envs.findBinding("C0EXAMPLE", "1.1");
    expect(b?.env_id).toBe(definitionRowId("default", "team-sandbox"));
    expect(b?.lock_by_env).toBe(0);
    expect(await OneOnOne.find("C0EXAMPLE", "1.1")).toBeNull();
    expect(replies.join("\n")).toContain("`team-sandbox` is a SHARED machine: anyone in this thread can steer it through me, and what runs there is visible to the team.");
    expect(preflights).toHaveLength(1);
    expect(reloads).toBe(1);
    noLeak();
  });

  it("an agent without the key (or with another name) is refused and binds nothing", async () => {
    await insertShared();
    await handleEnvCommand({ kind: "env", action: "use", name: "env:team-sandbox" }, ctx({ personaId: "agent-b" }), deps());
    allows = { "agent-a": ["other"] };
    await handleEnvCommand({ kind: "env", action: "use", name: "env:team-sandbox" }, ctx(), deps());
    expect(await Envs.findBinding("C0EXAMPLE", "1.1")).toBeNull();
    expect(preflights).toHaveLength(0);
    expect(replies.every((r) => r.includes("no shared environment named"))).toBe(true);
    noLeak();
  });

  it("unknown, retired, malformed and other-tenant names all get the same answer", async () => {
    const id = await insertShared();
    await db.run("UPDATE environments SET retired_at = 9 WHERE id = ?", [id]);
    await handleEnvCommand({ kind: "env", action: "use", name: "env:team-sandbox" }, ctx(), deps());
    await handleEnvCommand({ kind: "env", action: "use", name: "env:nope" }, ctx(), deps());
    await handleEnvCommand({ kind: "env", action: "use", name: "env:BAD NAME" }, ctx(), deps());
    expect(await Envs.findBinding("C0EXAMPLE", "1.1")).toBeNull();
    expect(replies).toHaveLength(3);
    const tenant = await insertShared({ name: "second" });
    allows = { "agent-a": ["second"] };
    await handleEnvCommand({ kind: "env", action: "use", name: "env:second" }, ctx({ tenantId: "other-tenant" }), deps());
    expect(await Envs.findBinding("C0EXAMPLE", "1.1")).toBeNull();
    expect(tenant).toBeTruthy();
  });

  it("a stale Use button re-checks: the row, the agent and the tenant are asked again", async () => {
    const id = await insertShared();
    const row = (await Envs.getEnv(id))!;
    allows = {};
    expect(await useEnvironment(row, undefined, ctx(), deps())).toBe(false);
    allows = { "agent-a": ["team-sandbox"] };
    await db.run("UPDATE environments SET retired_at = 9 WHERE id = ?", [id]);
    expect(await useEnvironment((await Envs.getEnv(id))!, undefined, ctx(), deps())).toBe(false);
    expect(await Envs.findBinding("C0EXAMPLE", "1.1")).toBeNull();
  });

  it("a preflight failure undoes the binding and tells nothing about the host", async () => {
    await insertShared();
    const d = deps();
    d.preflight = async () => ({ ok: false, error: "connection refused" } as never);
    await handleEnvCommand({ kind: "env", action: "use", name: "env:team-sandbox" }, ctx(), d);
    expect(await Envs.findBinding("C0EXAMPLE", "1.1")).toBeNull();
    expect(out()).toContain("Couldn't use");
    noLeak();
  });

  it("remote mode off answers as before", async () => {
    delete process.env.SLAUDE_REMOTE;
    await insertShared();
    await handleEnvCommand({ kind: "env", action: "use", name: "env:team-sandbox" }, ctx(), deps());
    expect(replies).toEqual([":no_entry: `/env` is not enabled on this deployment."]);
  });
});

describe("edit, rm and add over a shared name", () => {
  it("answer 'defined in the repository' and change nothing", async () => {
    const id = await insertShared();
    await bindShared(id);
    await handleEnvCommand({ kind: "env", action: "edit", name: "env:team-sandbox", fields: { host: "x.example.com" } }, ctx(), deps());
    await handleEnvCommand({ kind: "env", action: "rm", name: "env:team-sandbox" }, ctx(), deps());
    await handleEnvCommand({ kind: "env", action: "add", kindName: "ssh", name: "env:team-sandbox", fields: { host: "x.example.com", user: "d" } }, ctx(), deps());
    // A bare name of an allowed shared environment, with no personal row of that name, answers the same way.
    await handleEnvCommand({ kind: "env", action: "rm", name: "team-sandbox" }, ctx(), deps());
    expect(replies).toHaveLength(4);
    expect(replies.every((r) => r.includes("defined in the repository"))).toBe(true);
    expect((await Envs.getEnv(id))?.config.host).toBe(HOST);
    expect(await Envs.findBinding("C0EXAMPLE", "1.1")).not.toBeNull();
  });

  it("the removal helper refuses a definition row before unbinding any thread", async () => {
    const id = await insertShared();
    await bindShared(id);
    await removeEnvironment((await Envs.getEnv(id))!, ctx(), deps());
    expect(replies[0]).toContain("defined in the repository");
    expect(await Envs.findBinding("C0EXAMPLE", "1.1")).not.toBeNull();
    expect(await Envs.getEnv(id)).not.toBeNull();
  });
});

describe("/env list and status", () => {
  it("lists shared environments for an agent that allows them, by name only", async () => {
    await insertShared();
    await handleEnvCommand({ kind: "env", action: "list" }, ctx(), deps());
    expect(privately.join("\n")).toContain("env:team-sandbox");
    noLeak();
    privately = [];
    await handleEnvCommand({ kind: "env", action: "list" }, ctx({ personaId: "agent-b" }), deps());
    expect(privately.join("\n")).not.toContain("team-sandbox");
  });

  it("a thread bound by one agent reports to another that it may not use it", async () => {
    await bindShared(await insertShared());
    await handleEnvCommand({ kind: "env", action: "status" }, ctx({ personaId: "agent-b" }), deps());
    expect(replies.join("\n")).toContain("this agent may not use it");
    replies = [];
    await handleEnvCommand({ kind: "env", action: "status" }, ctx(), deps());
    expect(replies.join("\n")).toContain("env:team-sandbox");
    noLeak();
  });

  it("anyone in an unlocked thread can switch a shared environment off", async () => {
    await bindShared(await insertShared());
    await handleEnvCommand({ kind: "env", action: "off" }, ctx({ userId: "U0OTHER" }), deps());
    expect(await Envs.findBinding("C0EXAMPLE", "1.1")).toBeNull();
  });
});

describe("personal environments are unaffected", () => {
  it("a personal environment uses, lists and removes as before, beside shared ones", async () => {
    await insertShared();
    const personal = await insertPersonal("U0EXAMPLE", "mine");
    await handleEnvCommand({ kind: "env", action: "list" }, ctx(), deps());
    expect(privately.join("\n")).toContain("*mine*");
    expect(privately.join("\n")).toContain("env:team-sandbox");
    await handleEnvCommand({ kind: "env", action: "rm", name: "mine" }, ctx(), deps());
    expect(await Envs.getEnv(personal)).toBeNull();
    // The bare name of a shared environment does not select it: it means the user's own.
    replies = [];
    await handleEnvCommand({ kind: "env", action: "use", name: "team-sandbox" }, ctx(), deps());
    expect(replies.join("\n")).toContain("You have no environment named");
  });
});
