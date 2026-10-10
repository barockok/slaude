/**
 * A warm session that outlives its job's token, then exits (idle TTL, reload,
 * the end of a voice call's hold). The manager's teardown writes the session's
 * status through the node's RestSessionStore with the last bound job token,
 * which by then is expired: the idle TTL (15 min) is as long as the token TTL
 * and starts later. That write used to reject inside the manager's detached
 * query loop, an unhandled rejection that killed the node worker process.
 *
 * Real pieces: AgentManager, RestSessionStore, NodeClient and the gateway's
 * /v1 router (token refresh included) over Bun.serve on sqlite. Fake: the SDK
 * query (see manager-lifecycle.test.ts for the same mock pattern).
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";

process.env.SLAUDE_BRAIN_DISABLED = "1";
process.env.SLAUDE_AUTO_EVOLVE = "0";
process.env.SLAUDE_IDLE_MINUTES = "0";

const realSdk = await import("@anthropic-ai/claude-agent-sdk");
const realQuery = realSdk.query;
type QueryArgs = { prompt: AsyncIterable<any>; options: any };
const passthrough = (args: QueryArgs) => realQuery(args as any);
let currentQuery: (args: QueryArgs) => any = passthrough;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...realSdk,
  query: (args: QueryArgs) => currentQuery(args),
}));

/** A CLI that answers every input with a bare result and exits when its
 *  input closes. */
function fakeQuery({ prompt }: QueryArgs) {
  const out: any[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  void (async () => {
    for await (const _ of prompt) {
      out.push({ type: "result", subtype: "success", is_error: false });
      poke();
    }
    ended = true;
    poke();
  })();
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (out.length) {
          yield out.shift();
          continue;
        }
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
    setPermissionMode: async () => ({}),
    mcpServerStatus: async () => [],
    interrupt: async () => {},
  };
}

const { createGateway } = await import("../../src/gateway/core/gateway");
const { AgentManager } = await import("../../src/agent/manager");
const { mintJobToken } = await import("../../src/gateway/api/auth");
const { dbSessionStore } = await import("../../src/agent/session-store");
const { NodeClient } = await import("../../src/node/client");
const { RestSessionStore } = await import("../../src/node/session-store");
const { ensureHome } = await import("../../src/config/home");

const NODE_TOKEN = "expired-exit-node-token";
const JOB_SECRET = "expired-exit-job-secret";

let server: ReturnType<typeof Bun.serve>;
let base = "";
let seq = 0;

function fakeTransport(): any {
  return {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
    },
    action: () => {}, event: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
  };
}

async function until(cond: () => boolean, ms = 3000, label = "condition") {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await Bun.sleep(5);
  }
}

beforeAll(async () => {
  process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
  process.env.SLAUDE_JOB_SECRET = JOB_SECRET;
  ensureHome();
  const handle = createGateway(new AgentManager(), fakeTransport());
  server = Bun.serve({
    port: 0,
    fetch: async (req) => (await handle.fetchV1(req)) ?? new Response("nf", { status: 404 }),
  });
  base = `http://127.0.0.1:${server.port}`;
  currentQuery = fakeQuery;
});

afterAll(() => {
  currentQuery = passthrough;
  server?.stop(true);
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_JOB_SECRET;
});

/** A node-side session: a gateway row, a manager on the REST store, one turn
 *  run on a fresh token. Returns what the test needs to age the token. */
async function warmSession() {
  seq++;
  const thread = { team_id: "T1", channel_id: "C0EXPIRED", thread_ts: `700.${seq}` };
  const row = await dbSessionStore.createForThread({ thread, model: "m", working_dir: "/tmp/expired-wd" });
  const store = new RestSessionStore(new NodeClient({ baseUrl: base, token: NODE_TOKEN, baseDelayMs: 1 }));
  const claims = {
    tenant: "default", persona: "default", session: row.id, team: "T1",
    channel: thread.channel_id, thread: thread.thread_ts, initiator: "U1", scope: "turn", job: `job-${seq}`,
  };
  store.bindToken(row.id, mintJobToken(claims));
  const mgr = new AgentManager();
  mgr.setSessionStore(store);
  const exits: string[] = [];
  mgr.on("sessionExit", (id: string) => exits.push(id));
  let done = 0;
  mgr.on("event", (e: any) => {
    if (e.type === "done" && e.sessionId === row.id) done++;
  });
  await mgr.sendMessage(row.id, "hello");
  await until(() => done === 1, 3000, "turn done");
  return { row, store, mgr, exits, claims };
}

/** Collect unhandled rejections for the duration of fn. */
async function watchingRejections(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRej = (r: unknown) => seen.push(r);
  process.on("unhandledRejection", onRej);
  try {
    await fn();
    // Let a rejected teardown promise surface.
    await Bun.sleep(50);
  } finally {
    process.off("unhandledRejection", onRej);
  }
  return seen;
}

describe("a node session that outlives its job token", () => {
  test("its exit refreshes the expired token, writes the idle status and does not crash", async () => {
    const { row, store, mgr, exits, claims } = await warmSession();
    // The session sat warm past its token's TTL (still within the refresh grace).
    const expired = mintJobToken(claims, { now: Date.now() - 20 * 60_000 });
    store.bindToken(row.id, expired);
    const seen = await watchingRejections(async () => {
      mgr.reload(row.id);
      await until(() => exits.length === 1, 3000, "sessionExit");
    });
    expect(seen).toEqual([]);
    expect(mgr.isLive(row.id)).toBe(false);
    expect((await dbSessionStore.findById(row.id))?.status).toBe("idle");
    // The fresh token replaced the expired one for the session's later calls.
    expect(store.tokenFor(row.id)).not.toBe(expired);
  });

  test("a token past the refresh grace fails only the status write: logged, teardown completes", async () => {
    const { row, store, mgr, exits, claims } = await warmSession();
    store.bindToken(row.id, mintJobToken(claims, { now: Date.now() - 3 * 3600_000 }));
    const err = spyOn(console, "error").mockImplementation(() => {});
    let seen: unknown[];
    let logged = "";
    try {
      seen = await watchingRejections(async () => {
        mgr.reload(row.id);
        await until(() => exits.length === 1, 3000, "sessionExit");
      });
      logged = err.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    } finally {
      err.mockRestore();
    }
    expect(seen).toEqual([]);
    expect(mgr.isLive(row.id)).toBe(false);
    expect(logged).toContain(`session=${row.id}`);
    expect(logged).toContain("401");
  });
});
