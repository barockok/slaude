/**
 * POST /v1/tools/memory/prefetch|sync: episodic memory for node turns, run on
 * the gateway. The session, the persona's slice and the scope come from the
 * verified job token, never from the body; the route is label-gated.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createV1Api } from "../../../src/gateway/api";
import { __setNodeVerifier, JOB_HEADER, mintJobToken, type JobClaims } from "../../../src/gateway/api/auth";
import { mintNodeCredential, NodeCredentialVerifier } from "../../../src/gateway/auth/node-credential";
import { InMemoryPendingSource } from "../../../src/gateway/api/pending-source";
import { defaultMemoryPlane, makeMemoryPlane, MEMORY_BODY_MAX_BYTES } from "../../../src/gateway/api/memory";
import { PersonaNotLiveError } from "../../../src/persona/registry";
import { resetAgentId, resolveAgentId, agentIdSync } from "../../../src/knowledge/agent-identity";
import { BrainMemoryProvider } from "../../../src/memory/brain-provider";
import type { MemoryProvider } from "../../../src/memory/provider";
import { agentSourceId, userSourceId } from "../../../src/knowledge/scope";
import type { GateInput } from "../../../src/knowledge/gated-dispatch";
import { fakeBrain } from "../../memory/fake-brain";

const VARS = ["SLAUDE_NODE_KEY", "SLAUDE_NODE_LEGACY_TOKEN", "SLAUDE_NODE_TOKEN", "SLAUDE_JOB_SECRET", "SLAUDE_NODE_LEGACY"];
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of VARS) saved[k] = process.env[k];
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_NODE_LEGACY;
  delete process.env.SLAUDE_NODE_LEGACY_TOKEN;
  process.env.SLAUDE_NODE_KEY = "memory-node-key";
  process.env.SLAUDE_JOB_SECRET = "memory-job-secret";
  __setNodeVerifier(new NodeCredentialVerifier({ revocations: async () => null }));
});
afterAll(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __setNodeVerifier(null);
});

/** Persona → its own Slack user id, as brainGateFor resolves it. */
const PERSONA_IDS: Record<string, string> = { finance: "U0FINANCE", engineering: "U0ENG" };
const TRUSTED = "C0TRUSTED";

/** The gate the KB tools would compute for these claims (stand-in for
 *  brainGateFor; the live lock is `liveLock`, the token's claim is merged by
 *  the plane). tests/gateway/api/memory-gateway.test.ts uses the real one. */
let liveLock: string | null = null;
const gateFromClaims = async (c: JobClaims): Promise<GateInput> => ({
  userId: c.initiator || null,
  lockedUser: liveLock,
  channelTrust: c.channel === TRUSTED ? "trusted" : "public",
  isManager: false,
  agentId: PERSONA_IDS[c.persona] ?? "default",
});

function setup(opts: { memory?: "none"; provider?: MemoryProvider; assertLive?: (c: JobClaims) => void } = {}) {
  liveLock = null;
  const fb = fakeBrain();
  const provider = opts.provider ?? new BrainMemoryProvider({ call: fb.call, ready: async () => {} });
  const v1 = createV1Api({
    tools: {} as any,
    pendingSource: new InMemoryPendingSource(),
    memory: opts.memory === "none"
      ? null
      : makeMemoryPlane({ provider, gateFor: gateFromClaims, ready: async () => {}, ...(opts.assertLive ? { assertLive: opts.assertLive } : {}) }),
  });
  return { fb, v1 };
}

const claims = (o: Partial<JobClaims> = {}): Omit<JobClaims, "exp" | "iat"> => ({
  tenant: "default", persona: "finance", session: "S-mem", team: "T1", channel: TRUSTED, thread: "1.0",
  initiator: "U1", scope: "turn", job: "J1", runAs: "agent", label: "finance", ...o,
});

async function post(v1: ReturnType<typeof createV1Api>, op: string, body: unknown, c = claims(), labels = ["finance"]) {
  const res = (await v1.fetch(
    new Request(`http://gw/v1/tools/memory/${op}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mintNodeCredential({ id: "n1", labels }, { key: "memory-node-key" })}`,
        [JOB_HEADER]: mintJobToken(c),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  ))!;
  return { status: res.status, body: (await res.json()) as any };
}

describe("memory routes", () => {
  test("sync writes the persona's own slice; prefetch reads it back", async () => {
    const { fb, v1 } = setup();
    expect(await post(v1, "sync", { user: "what is the cadence?", assistant: "weekly" })).toEqual({ status: 200, body: { ok: true } });
    expect(fb.sourcesOf("S-mem")).toEqual([agentSourceId("U0FINANCE")]);
    const r = await post(v1, "prefetch", {});
    expect(r.status).toBe(200);
    expect(r.body.block).toContain("<recent-turns>");
    expect(r.body.block).toContain("what is the cadence?");
  });

  test("two personas never share a slice, and nothing lands in agent-default", async () => {
    const { fb, v1 } = setup();
    await post(v1, "sync", { user: "u", assistant: "a" }, claims({ persona: "finance", session: "S-f" }));
    await post(v1, "sync", { user: "u", assistant: "a" }, claims({ persona: "engineering", session: "S-e", label: "engineering" }), ["engineering"]);
    expect(fb.sourcesOf("S-f")).toEqual([agentSourceId("U0FINANCE")]);
    expect(fb.sourcesOf("S-e")).toEqual([agentSourceId("U0ENG")]);
    expect([...fb.pages.keys()].some((k) => k.startsWith(`${agentSourceId("default")}\u0000`))).toBe(false);
  });

  test("a public-channel turn reads back only its own thread's page in the persona's slice, never the legacy source", async () => {
    const { fb, v1 } = setup();
    await post(v1, "sync", { user: "public question", assistant: "a" }, claims({ session: "S-pub", channel: "C0PUBLIC" }));
    expect(fb.sourcesOf("S-pub")).toEqual([agentSourceId("U0FINANCE")]);
    fb.seed("agent", "S-pub", "legacy private turn");
    const r = await post(v1, "prefetch", {}, claims({ session: "S-pub", channel: "C0PUBLIC" }));
    expect(r.body.block).toContain("public question");
    expect(r.body.block).not.toContain("legacy private turn");
  });

  test("a DM from a non-manager is written to and read from the user's slice", async () => {
    const { fb, v1 } = setup();
    await post(v1, "sync", { user: "dm question", assistant: "a" }, claims({ session: "S-dm", channel: "D0DM" }));
    expect(fb.sourcesOf("S-dm")).toEqual([userSourceId("U1")]);
    expect((await post(v1, "prefetch", {}, claims({ session: "S-dm", channel: "D0DM" }))).body.block).toContain("dm question");
  });

  test("the owner's /1on1 turn is written to the user's slice", async () => {
    const { fb, v1 } = setup();
    liveLock = "U1";
    await post(v1, "sync", { user: "u", assistant: "a" }, claims({ session: "S-1on1" }));
    expect(fb.sourcesOf("S-1on1")).toEqual([userSourceId("U1")]);
  });

  test("a sync that arrives after /1on1 off stays private: the token's lock claim counts", async () => {
    const { fb, v1 } = setup();
    liveLock = null; // the lock was released while the turn ran
    await post(v1, "sync", { user: "u", assistant: "a" }, claims({ session: "S-off", lock: { user: "U1", openScope: null } }));
    expect(fb.sourcesOf("S-off")).toEqual([userSourceId("U1")]);
    // Locked to someone else at dispatch: neither written nor read.
    await post(v1, "sync", { user: "u", assistant: "a" }, claims({ session: "S-other", lock: { user: "U0ALICE", openScope: null } }));
    expect(fb.sourcesOf("S-other")).toEqual([]);
  });

  test("a job that runs as a person (a cron created inside a 1:1) is that person's slice, read and written", async () => {
    const { fb, v1 } = setup();
    liveLock = null; // a cron's synthetic thread holds no lock
    const c = claims({ session: "S-cron", runAs: "user:U1" });
    await post(v1, "sync", { user: "cron question", assistant: "a" }, c);
    expect(fb.sourcesOf("S-cron")).toEqual([userSourceId("U1")]);
    expect((await post(v1, "prefetch", {}, c)).body.block).toContain("cron question");
    // A speaker other than the runAs user: nothing.
    await post(v1, "sync", { user: "u", assistant: "a" }, claims({ session: "S-cron-2", runAs: "user:U1", initiator: "U2" }));
    expect(fb.sourcesOf("S-cron-2")).toEqual([]);
  });

  test("a retired persona is refused with 409 and one log line, for a flat provider too", async () => {
    const flat: MemoryProvider = { prefetch: async () => "x", syncTurn: async () => {} };
    const retired = (c: JobClaims) => { if (c.persona === "finance") throw new PersonaNotLiveError("finance"); };
    for (const provider of [undefined, flat]) {
      const { v1 } = setup({ provider, assertLive: retired });
      const lines: unknown[][] = [];
      const warn = console.warn; const error = console.error;
      console.warn = (...a: unknown[]) => void lines.push(a);
      console.error = (...a: unknown[]) => void lines.push(a);
      try {
        const r = await post(v1, "prefetch", {});
        expect(r.status).toBe(409);
        expect(r.body.code).toBe("PERSONA_NOT_LIVE");
        expect((await post(v1, "sync", { user: "u", assistant: "a" })).status).toBe(409);
      } finally { console.warn = warn; console.error = error; }
      expect(lines).toHaveLength(2); // one line per request, no stack
      expect(lines.every((l) => l.length === 1 && typeof l[0] === "string" && !String(l[0]).includes("\n    at "))).toBe(true);
    }
  });

  test("the body is capped", async () => {
    const { fb, v1 } = setup();
    const r = await post(v1, "sync", { user: "u".repeat(MEMORY_BODY_MAX_BYTES), assistant: "a" });
    expect(r.status).toBe(413);
    expect(fb.pages.size).toBe(0);
  });

  test("the session comes from the token: a body naming a session, persona or scope is refused", async () => {
    const { fb, v1 } = setup();
    for (const extra of [{ sessionId: "S-other" }, { persona: "engineering" }, { scope: { sourceId: "shared" } }]) {
      expect((await post(v1, "sync", { user: "u", assistant: "a", ...extra })).status).toBe(400);
      expect((await post(v1, "prefetch", extra)).status).toBe(400);
    }
    expect(fb.pages.size).toBe(0);
  });

  test("label gate: a node without the job's label gets 403 and nothing is written", async () => {
    const { fb, v1 } = setup();
    const r = await post(v1, "sync", { user: "u", assistant: "a" }, claims(), ["engineering"]);
    expect(r.status).toBe(403);
    expect(fb.pages.size).toBe(0);
  });

  test("a deployment that does not serve memory answers 404", async () => {
    const { v1 } = setup({ memory: "none" });
    expect((await post(v1, "prefetch", {})).status).toBe(404);
  });
});

describe("defaultMemoryPlane", () => {
  test("gates through the tool plane's brainDeps, built from the claims' context", async () => {
    const fb = fakeBrain();
    const provider = new BrainMemoryProvider({ call: fb.call, ready: async () => {} });
    const seen: any[] = [];
    const tools = {
      slackCtx: (c: JobClaims) => ({ channel: c.channel, threadTs: c.thread, userId: c.initiator, personaId: c.persona }),
      surfaceFor: () => ({}),
      brainDeps: (ctx: any) => ({
        gate: async () => {
          seen.push(ctx);
          return { userId: ctx.userId, lockedUser: null, channelTrust: "trusted", isManager: false, agentId: "U0FINANCE" };
        },
      }),
    } as any;
    const plane = defaultMemoryPlane(tools, provider);
    await plane.sync({ ...claims(), exp: 0, iat: 0 } as JobClaims, { user: "u", assistant: "a" });
    expect(seen[0]).toMatchObject({ channel: TRUSTED, userId: "U1", personaId: "finance" });
    expect(fb.sourcesOf("S-mem")).toEqual([agentSourceId("U0FINANCE")]);
  });

  test("brain disabled (no brainDeps): a brain provider reads and writes nothing", async () => {
    const fb = fakeBrain();
    const provider = new BrainMemoryProvider({ call: fb.call, ready: async () => {} });
    const tools = { slackCtx: () => ({}), surfaceFor: () => ({}), brainDeps: () => undefined } as any;
    const plane = defaultMemoryPlane(tools, provider);
    const c = { ...claims(), exp: 0, iat: 0 } as JobClaims;
    await plane.sync(c, { user: "u", assistant: "a" });
    expect(await plane.prefetch(c)).toBeNull();
    expect(fb.pages.size).toBe(0);
  });

  test("a flat provider (SLAUDE_MEMORY=sqlite) is keyed on the token's session", async () => {
    const calls: unknown[] = [];
    const flat: MemoryProvider = {
      prefetch: async (id) => (calls.push(["prefetch", id]), "<facts>x</facts>"),
      syncTurn: async (t) => void calls.push(["sync", t]),
    };
    const plane = defaultMemoryPlane({} as any, flat);
    const c = { ...claims(), exp: 0, iat: 0 } as JobClaims;
    expect(await plane.prefetch(c)).toBe("<facts>x</facts>");
    await plane.sync(c, { user: "u", assistant: "a" });
    expect(calls).toEqual([["prefetch", "S-mem"], ["sync", { sessionId: "S-mem", user: "u", assistant: "a" }]]);
  });
});

describe("makeMemoryPlane bounds and identity", () => {
  const c = () => ({ ...claims(), exp: 0, iat: 0 }) as JobClaims;

  test("a hung brain: prefetch answers null and sync returns within the bound, logged once per operation", async () => {
    const warnings: string[] = [];
    const hung = new BrainMemoryProvider({ call: () => new Promise(() => {}), ready: async () => {} });
    const plane = makeMemoryPlane({ provider: hung, gateFor: gateFromClaims, ready: async () => {}, timeoutMs: 100, warn: (m) => warnings.push(m) });
    const t0 = Date.now();
    expect(await plane.prefetch(c())).toBeNull();
    expect(await plane.prefetch(c())).toBeNull();
    await plane.sync(c(), { user: "u", assistant: "a" });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(warnings).toHaveLength(2);
  });

  test("a hung flat provider is bounded too", async () => {
    const flat: MemoryProvider = { prefetch: () => new Promise(() => {}), syncTurn: () => new Promise(() => {}) };
    const plane = makeMemoryPlane({ provider: flat, gateFor: gateFromClaims, timeoutMs: 100, warn: () => {} });
    expect(await plane.prefetch(c())).toBeNull();
    await plane.sync(c(), { user: "u", assistant: "a" });
  });

  // On a freshly started replica auth.test may still be in flight: the gate
  // must not read the "default" fallback identity.
  test("the plane waits for the process agent identity before it scopes the turn", async () => {
    const saved = process.env.SLAUDE_AGENT_ID;
    delete process.env.SLAUDE_AGENT_ID;
    resetAgentId();
    try {
      let settle!: (v: { user_id: string }) => void;
      void resolveAgentId(() => new Promise((r) => (settle = r)));
      const fb = fakeBrain();
      const provider = new BrainMemoryProvider({ call: fb.call, ready: async () => {} });
      // The default persona: its gate uses the process identity, read at call time.
      const plane = makeMemoryPlane({ provider, gateFor: async (cl) => ({ ...(await gateFromClaims(cl)), agentId: agentIdSync() }) });
      const done = plane.sync({ ...c(), persona: "default" }, { user: "u", assistant: "a" });
      await Bun.sleep(20);
      settle({ user_id: "U0LATE" });
      await done;
      expect(fb.sourcesOf("S-mem")).toEqual([agentSourceId("U0LATE")]);
    } finally {
      if (saved === undefined) delete process.env.SLAUDE_AGENT_ID;
      else process.env.SLAUDE_AGENT_ID = saved;
      resetAgentId();
    }
  });
});
