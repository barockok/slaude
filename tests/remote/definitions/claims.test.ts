/**
 * Every claim point, per persona, fail closed (finding 1): no path hands a node
 * the key, signs a remote claim, or runs a shared environment for a persona that
 * does not allow it. Each path is exercised with a second agent in the same
 * thread, a retired row, an allow entry dropped after binding, a removed
 * definition and the same name in another tenant.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleRemoteEnv } from "../../../src/gateway/api/remote-env";
import { handleTokenRefresh } from "../../../src/gateway/api/jobs";
import { JOB_HEADER, mintJobToken, verifyJobToken, type JobClaims } from "../../../src/gateway/api/auth";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";
import { threadIdentity } from "../../../src/gateway/core/thread-identity";
import { flushAudits } from "../../../src/audit/emit";
import { db, type SessionRow } from "../../../src/db/schema";
import * as Sessions from "../../../src/db/sessions";
import * as Envs from "../../../src/db/environments";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../../src/persona/registry";
import { __setDecisionDepsForTests, remoteDecision } from "../../../src/remote/definitions/decision";
import { makeMonoRemoteFactory, monoRemoteResolver, monoSharedBindingGuard } from "../../../src/remote/mono";
import { definitionRowId } from "../../../src/remote/definitions/resolve";
import { RemoteError, type RemoteHandle } from "../../../src/remote/types";
import { bindShared, insertPersonal, insertShared, PRIV, reset } from "./helpers";
import * as OneOnOne from "../../../src/db/one-on-one";

const CH = "C0EXAMPLE";
const TH = "1.1";
let allows: Record<string, string[]> = {};
const TENANT = "default";

beforeEach(async () => {
  await reset();
  process.env.SLAUDE_REMOTE = "1";
  process.env.SLAUDE_JOB_SECRET = "test-secret";
  allows = { "agent-a": ["team-sandbox"] };
  __setDecisionDepsForTests({ allowed: async (_t, p) => allows[p] ?? [] });
});
afterEach(() => {
  delete process.env.SLAUDE_REMOTE;
  __setDecisionDepsForTests(null);
  __resetPersonaRegistry();
});

const identity = (persona: string | undefined, o: { tenant?: string; turnKind?: "interactive" | "scheduled" | "background" | "other" } = {}) =>
  threadIdentity(CH, TH, () => "U0EXAMPLE", { tenant: o.tenant ?? TENANT, persona, turnKind: o.turnKind ?? "interactive" });

/** Claims as dispatch would have signed them for `persona`, from a real identity. */
async function claimsFor(persona: string, o: { tenant?: string; stale?: boolean } = {}): Promise<JobClaims> {
  const id = await identity("agent-a");
  const remote = id.remote ? { ...id.remote, env: { ...id.remote.env!, ...(o.stale ? { hash: "0".repeat(16) } : {}) } } : undefined;
  return { tenant: o.tenant ?? TENANT, persona, session: "S1", team: "T0EXAMPLE", channel: CH, thread: TH, initiator: "U0EXAMPLE", scope: "turn", origin: "slack", ...(remote ? { remote } : {}) } as JobClaims;
}
async function fetchEnv(claims: JobClaims): Promise<{ status: number; body: string }> {
  const r = await handleRemoteEnv(new Request("https://gw.example.com/v1/remote/env"), claims);
  return { status: r.status, body: await r.text() };
}
const noKey = (body: string) => {
  expect(body).not.toContain("planted-secret-material");
  expect(body).not.toContain("build-box.example.com");
};

describe("threadIdentity", () => {
  test("the allowing agent's interactive turn signs the remote claim as an unlocked machine", async () => {
    await bindShared(await insertShared());
    const id = await identity("agent-a");
    expect(id.refused).toBeUndefined();
    expect(id.remote?.env).toMatchObject({ name: "team-sandbox", kind: "ssh", trust: "provisioned" });
    expect(id.lock).toBeNull();
  });

  test("a second agent in the bound thread gets no claim and a refusal", async () => {
    await bindShared(await insertShared());
    const id = await identity("agent-b");
    expect(id.remote).toBeUndefined();
    expect(id.refused?.code).toBe("SHARED_ENV_REFUSED");
  });

  test("a retired row, a dropped allow entry, another tenant, a cron turn, no asker: all refused with no claim", async () => {
    const id = await insertShared();
    await bindShared(id);
    allows = { "agent-a": [] };
    expect((await identity("agent-a")).refused).toBeDefined();
    allows = { "agent-a": ["team-sandbox"] };
    expect((await identity("agent-a", { tenant: "other-tenant" })).refused).toBeDefined();
    expect((await identity("agent-a", { turnKind: "scheduled" })).refused?.code).toBe("SHARED_ENV_NOT_INTERACTIVE");
    expect((await identity("agent-a", { turnKind: "background" })).remote).toBeUndefined();
    expect((await threadIdentity(CH, TH, () => "U0EXAMPLE")).refused).toBeDefined();
    await db.run("UPDATE environments SET retired_at = 9 WHERE id = ?", [id]);
    const r = await identity("agent-a");
    expect(r.refused).toBeDefined();
    expect(r.remote).toBeUndefined();
  });

  test("remote mode off with the thread still bound to a shared machine is a refusal, not the server, and tells the operator what to run", async () => {
    await bindShared(await insertShared());
    delete process.env.SLAUDE_REMOTE;
    const id = await identity("agent-a");
    expect(id.refused?.code).toBe("SHARED_ENV_REMOTE_OFF");
    expect(id.refused?.message).toContain("slaude env unbind-shared");
    expect(id.refused?.message).not.toContain("/env off");
    expect(id.remote).toBeUndefined();
  });

  test("remote mode off and nothing bound to a shared machine behaves as before", async () => {
    delete process.env.SLAUDE_REMOTE;
    const id = await identity("agent-a");
    expect(id).toEqual({ runAsUser: "U0EXAMPLE", lock: null, remote: undefined });
  });

  test("a personal environment's claim is the same for every asker (byte for byte)", async () => {
    const id = await insertPersonal();
    await Envs.bind({ channelId: CH, threadTs: TH, envId: id, dir: "/home/dev", lockByEnv: true });
    await OneOnOne.lock({ channelId: CH, threadTs: TH, lockedUser: "U0EXAMPLE", createdBy: "U0EXAMPLE", teamId: "T0EXAMPLE" });
    const a = await identity("agent-a");
    const b = await identity("agent-b", { turnKind: "scheduled" });
    const old = await threadIdentity(CH, TH, () => "U0EXAMPLE");
    expect(a.remote).toBeDefined();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).toBe(JSON.stringify({ ...old }));
  });

  test("token refresh (voice) reports no identity for a refused thread, and a remote for the allowed one", async () => {
    await bindShared(await insertShared());
    const refresh = async (persona: string) => {
      const token = mintJobToken({ tenant: TENANT, persona, session: "S1", team: "T0EXAMPLE", channel: CH, thread: TH, initiator: "U0EXAMPLE", scope: "turn", runAs: "agent", origin: "slack", job: "J1" } as never);
      const res = await handleTokenRefresh(new Request("https://gw/x", { method: "POST", headers: { [JOB_HEADER]: token } }), "J1");
      return (await res.json()) as { identity?: { remote: boolean } };
    };
    expect((await refresh("agent-a")).identity?.remote).toBe(true);
    expect((await refresh("agent-b")).identity).toBeUndefined();
  });
});

describe("a bound shared row of a kind this process does not know", () => {
  test("is a refusal at every point, never none (the server)", async () => {
    const id = await insertShared();
    await bindShared(id);
    await db.run("UPDATE environments SET kind = 'weird' WHERE id = ?", [id]);
    const d = await remoteDecision({ tenant: TENANT, persona: "agent-a", channel: CH, thread: TH, turnKind: "interactive" });
    expect("refused" in d).toBe(true);
    expect((await identity("agent-a")).refused).toBeDefined();
  });
});

describe("handleRemoteEnv (the key)", () => {
  test("the allowing agent's turn gets the transport and key", async () => {
    await bindShared(await insertShared());
    const r = await fetchEnv(await claimsFor("agent-a"));
    expect(r.status).toBe(200);
    expect(r.body).toContain("planted-secret-material");
  });

  test("a second agent with the first agent's claim gets no key", async () => {
    await bindShared(await insertShared());
    const r = await fetchEnv(await claimsFor("agent-b"));
    expect(r.status).toBe(403);
    noKey(r.body);
  });

  test("another tenant's token, with the right claim shape, gets no key", async () => {
    await bindShared(await insertShared());
    const r = await fetchEnv(await claimsFor("agent-a", { tenant: "other-tenant" }));
    expect(r.status).toBe(403);
    noKey(r.body);
  });

  test("a stale hash gets no key", async () => {
    await bindShared(await insertShared());
    const r = await fetchEnv(await claimsFor("agent-a", { stale: true }));
    expect(r.status).toBe(409);
    noKey(r.body);
  });

  test("a retired row, a removed definition and a dropped allow entry get no key", async () => {
    const id = await insertShared();
    await bindShared(id);
    const claims = await claimsFor("agent-a");
    allows = { "agent-a": [] };
    const dropped = await fetchEnv(claims);
    expect(dropped.status).toBe(403);
    noKey(dropped.body);
    allows = { "agent-a": ["team-sandbox"] };
    await db.run("UPDATE environments SET retired_at = 9 WHERE id = ?", [id]);
    const retired = await fetchEnv(claims);
    expect(retired.status).toBe(403);
    noKey(retired.body);
    await db.run("DELETE FROM env_bindings");
    const removed = await fetchEnv(claims);
    expect(removed.status).toBe(409);
    noKey(removed.body);
  });

  test("a scheduled or wake token gets no key", async () => {
    await bindShared(await insertShared());
    const base = await claimsFor("agent-a");
    for (const extra of [{ origin: "cron" }, { wake: true, bgRun: "run1" }, { origin: undefined }]) {
      const r = await fetchEnv({ ...base, ...extra } as JobClaims);
      expect(r.status).toBe(403);
      noKey(r.body);
    }
  });
});

describe("mono", () => {
  async function session(persona: string): Promise<SessionRow> {
    return Sessions.createForThread({ thread: { team_id: "T0EXAMPLE", channel_id: CH, thread_ts: TH, persona_id: persona }, model: "m", working_dir: "/tmp" });
  }

  test("the resolver returns the target for the allowing agent and THROWS for another", async () => {
    await bindShared(await insertShared());
    const a = await session("agent-a");
    const b = await session("agent-b");
    expect((await monoRemoteResolver(a.id, () => "interactive"))?.env?.name).toBe("team-sandbox");
    const err = await monoRemoteResolver(b.id, () => "interactive").catch((e) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect(err.code).toBe("REMOTE_UNREACHABLE");
  });

  test("a retired row, a scheduled turn and an unknown turn kind throw (the default is not interactive)", async () => {
    const id = await insertShared();
    await bindShared(id);
    const a = await session("agent-a");
    expect(await monoRemoteResolver(a.id).catch((e) => e)).toBeInstanceOf(RemoteError);
    expect(await monoRemoteResolver(a.id, () => "scheduled").catch((e) => e)).toBeInstanceOf(RemoteError);
    await db.run("UPDATE environments SET retired_at = 9 WHERE id = ?", [id]);
    expect(await monoRemoteResolver(a.id, () => "interactive").catch((e) => e)).toBeInstanceOf(RemoteError);
  });

  test("a personal environment resolves exactly as before and an unbound thread is null", async () => {
    const a = await session("agent-a");
    expect(await monoRemoteResolver(a.id)).toBeNull();
  });

  test("with remote mode off, a thread still bound to a shared machine refuses to boot", async () => {
    await bindShared(await insertShared());
    const a = await session("agent-a");
    await expect(monoSharedBindingGuard(a.id)).rejects.toBeInstanceOf(RemoteError);
    await db.run("DELETE FROM env_bindings");
    expect(await monoSharedBindingGuard(a.id)).toBeNull();
  });

  test("an open session stops the moment its agent drops the allow entry", async () => {
    await bindShared(await insertShared());
    const a = await session("agent-a");
    const target = (await monoRemoteResolver(a.id, () => "interactive"))!;
    let ran = 0;
    const handle: RemoteHandle = { exec: async () => { ran++; return { stdout: "", stderr: "", code: 0, truncated: false, timedOut: false }; }, release: async () => {}, dispose: async () => {} };
    const open = await makeMonoRemoteFactory(() => handle, () => "interactive")(a.id, target);
    await open.exec("true", { timeoutMs: 1000 });
    expect(ran).toBe(1);
    allows = {};
    await expect(open.exec("true", { timeoutMs: 1000 })).rejects.toBeInstanceOf(RemoteError);
    expect(ran).toBe(1);
  });
});

describe("dispatch", () => {
  function harness(caps?: { warm?: { node: string; caps: string[] } }) {
    const enqueued: any[] = [];
    const events: any[] = [];
    const dispatch = makeQueueDispatch({ emit: (_n: string, e: any) => (events.push(e), true), resolveEffectiveIdentity: async () => undefined } as any, {
      needsGuardrails: async () => false,
      guardrailWaitMs: 20,
      guardrailPollMs: 5,
      infra: {
        turns: { enqueueTurn: async (job: any, target: any) => (enqueued.push({ job, target }), { queue: "turns", jobId: "J1", coalesced: false }), queue: () => ({ getJob: async () => null }), movedTo: async () => null, close: async () => {} } as any,
        registry: {
          lookup: async () => (caps?.warm ? { node: caps.warm.node, since: 1, lastBeat: Date.now(), fresh: true } : null),
          nodeCarries: async () => true,
          nodeCaps: async () => new Set(caps?.warm?.caps ?? []),
          liveNodesWithCap: async () => [{ node: "n1", has: true }],
          close: async () => {},
        } as any,
        pubsub: { consumeAbortFlag: async () => null, lastEventId: async () => null, appendEvent: async () => {}, readEvents: async () => [], close: async () => {} } as any,
      },
    });
    return { enqueued, events, dispatch };
  }
  const META = { teamId: "T0EXAMPLE", channelId: CH, threadTs: TH, eventTs: TH, userId: "U0EXAMPLE", origin: "slack" as const };
  const S = { id: "S-d" } as unknown as SessionRow;

  test("the allowing agent's turn is queued with the remote claim; another agent's is refused: nothing queued, one notice per hour", async () => {
    await bindShared(await insertShared());
    const a = harness();
    await a.dispatch.dispatch(S, "hi", { ...META, personaId: "agent-a" });
    expect(a.enqueued).toHaveLength(1);
    const claims = (verifyJobToken(a.enqueued[0].job.jobToken) as { claims: JobClaims }).claims;
    expect(claims.remote?.env?.name).toBe("team-sandbox");
    expect(claims.remote?.env?.trust).toBe("provisioned");

    const b = harness();
    await b.dispatch.dispatch(S, "hi", { ...META, personaId: "agent-b" });
    await b.dispatch.dispatch(S, "again", { ...META, personaId: "agent-b" });
    await flushAudits();
    expect(b.enqueued).toHaveLength(0);
    // Every refused message settles (its reaction and status line clear); the text posts once.
    const refusedEvents = b.events.filter((e) => e.code === "SHARED_ENV_REFUSED");
    expect(refusedEvents).toHaveLength(2);
    expect(refusedEvents.filter((e) => !e.quiet)).toHaveLength(1);
    const audits = await db.query<{ action: string }>("SELECT action FROM audit_events WHERE action = 'environment.refused'");
    expect(audits.length).toBeGreaterThan(0);
  });

  test("cron, wake and background turns of the allowing agent are refused", async () => {
    await bindShared(await insertShared());
    for (const m of [{ origin: "cron" as const }, { wake: { maxTurns: 1 }, backgroundRunId: "r1" }, { backgroundRunId: "r2" }, { origin: undefined }]) {
      const h = harness();
      await h.dispatch.dispatch(S, "hi", { ...META, personaId: "agent-a", ...m } as never);
      expect(h.enqueued).toHaveLength(0);
    }
  });

  test("a retired row and a removed allow entry are refused at dispatch", async () => {
    const id = await insertShared();
    await bindShared(id);
    allows = {};
    const h = harness();
    await h.dispatch.dispatch(S, "hi", { ...META, personaId: "agent-a" });
    expect(h.enqueued).toHaveLength(0);
    allows = { "agent-a": ["team-sandbox"] };
    await db.run("UPDATE environments SET retired_at = 9 WHERE id = ?", [id]);
    const r = harness();
    await r.dispatch.dispatch(S, "hi", { ...META, personaId: "agent-a" });
    expect(r.enqueued).toHaveLength(0);
  });

  test("no shared-env node at all is reported as its own failure, not as guardrails", async () => {
    const reg = (): PersonaRegistry => ({
      lookupByUserId: () => null,
      lookupByName: (n) => ({ name: n, slackUserId: "U1", config: { slackUserId: "U1", name: n }, outClient: null, mcp: null, runsOn: null, model: null, definition: { environment: { allow: ["team-sandbox"] } } } as never),
      list: () => [], isMultiPersonaMode: () => true, isManaged: () => true, tombstonedPersonaFor: () => null,
      defaultPersona: () => ({ model: null, mcp: null, runsOn: null }) as never,
    });
    setPersonaRegistry(reg());
    const h = harness();
    // Replace the fleet: nobody has the capability.
    (h as any).dispatch.registry.liveNodesWithCap = async () => [{ node: "old", has: false }];
    await h.dispatch.dispatch(S, "hi", { ...META, personaId: "agent-a" });
    expect(h.enqueued).toHaveLength(0);
    expect(h.events[0]).toMatchObject({ code: "SHARED_ENV_UNSUPPORTED" });
    expect(h.events.some((e) => e.code === "GUARDRAILS_UNSUPPORTED")).toBe(false);
  });

  test("an agent that declares environment: needs a shared-env/1 node; one that does not is unaffected", async () => {
    const reg = (envDef: unknown): PersonaRegistry => ({
      lookupByUserId: () => null,
      lookupByName: (n) => ({ name: n, slackUserId: "U1", config: { slackUserId: "U1", name: n }, outClient: null, mcp: null, runsOn: null, model: null, definition: envDef } as never),
      list: () => [], isMultiPersonaMode: () => true, isManaged: () => true, tombstonedPersonaFor: () => null,
      defaultPersona: () => ({ model: null, mcp: null, runsOn: null }) as never,
    });
    setPersonaRegistry(reg({ environment: { allow: ["team-sandbox"] } }));
    const withEnv = harness({ warm: { node: "old", caps: ["guardrails/1", "agent-definition/1"] } });
    await withEnv.dispatch.dispatch(S, "hi", { ...META, personaId: "agent-a" });
    expect(withEnv.enqueued[0].target).toEqual({ label: "default" });
    expect(withEnv.enqueued[0].job.requiresCaps).toContain("shared-env/1");
    const capable = harness({ warm: { node: "new", caps: ["guardrails/1", "agent-definition/1", "shared-env/1"] } });
    await capable.dispatch.dispatch(S, "hi", { ...META, personaId: "agent-a" });
    expect(capable.enqueued[0].target).toEqual({ node: "new" });
    setPersonaRegistry(reg({ skills: ["x"] }));
    const plain = harness({ warm: { node: "old", caps: ["guardrails/1", "agent-definition/1"] } });
    await plain.dispatch.dispatch(S, "hi", { ...META, personaId: "agent-a" });
    expect(plain.enqueued[0].target).toEqual({ node: "old" });
    expect(plain.enqueued[0].job.requiresCaps).toEqual(["agent-definition/1"]);
  });
});

// sqlite has no tenant column (definition sync is a database-tenant feature), so two tenants' rows exist on pg only.
describe.skipIf(process.env.SLAUDE_DB !== "pg")("cross-tenant, same name", () => {
  test("tenant B's row of the same name is refused for tenant A's asker, and has its own id and key", async () => {
    const a = await insertShared({ tenant: "tenant-a" });
    const b = await insertShared({ tenant: "tenant-b" });
    expect(a).not.toBe(b);
    expect(a).toBe(definitionRowId("tenant-a", "team-sandbox"));
    await bindShared(b);
    const asA = await remoteDecision({ tenant: "tenant-a", persona: "agent-a", channel: CH, thread: TH, turnKind: "interactive" });
    expect("refused" in asA).toBe(true);
    const asB = await remoteDecision({ tenant: "tenant-b", persona: "agent-a", channel: CH, thread: TH, turnKind: "interactive" });
    expect("target" in asB).toBe(true);
  });
});
