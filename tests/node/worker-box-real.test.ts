/**
 * A boxed session end to end: a real node worker with SLAUDE_BOX_TIER set, the
 * real box supervisor as its own root process with a clean environment, the
 * real CLI inside a sandbox, and the mock model (e2e/mock-llm) as the
 * provider. One process hosts a gateway and its /v1 server (as
 * tests/node/worker-e2e.test.ts does); the node's agent manager is the real
 * one, so the CLI is spawned through the sandbox seam.
 *
 * Gated three ways and skipped unless all hold:
 *   SLAUDE_BOX_TEST_TIER=gvisor|bwrap   Linux, root, the tier's runtime
 *   SLAUDE_REDIS_TEST_URL               a throwaway Redis
 *   SLAUDE_BOX_TEST_MOCK_LLM            the URL of a running mock model
 * plus SLAUDE_BOX_TEST_LAYOUT and SLAUDE_BOX_TEST_INIT_DIR (the box image and
 * the compiled box-init). scripts/smoke/box-smoke.sh prepares all of it.
 *
 * No real credential exists here. "The provider's real credential" is a
 * random string this test invents; a guard in front of the mock records which
 * credential each model request carried.
 *
 * The gateway side cannot pin a session to a box in this harness (the box
 * tables are Postgres only), so the two facts the gateway would supply are
 * added to what the node's client reads: the box in the runtime bundle and
 * the pinned digest in the session view. Everything after that is the
 * production path: the join of the two, admission, the supervised driver, the
 * two proxies, the mounts, the spawn seam.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REAL_URL, realEnabled, testPrefix, cleanupPrefix, sweepTag, obliterateQueues, until, sleep } from "../queue/real";

const TIER = process.env.SLAUDE_BOX_TEST_TIER;
const MOCK = process.env.SLAUDE_BOX_TEST_MOCK_LLM ?? "";
const LAYOUT = process.env.SLAUDE_BOX_TEST_LAYOUT ?? "";
const INIT_DIR = process.env.SLAUDE_BOX_TEST_INIT_DIR ?? "";
const armed = (TIER === "gvisor" || TIER === "bwrap") && process.platform === "linux" && realEnabled && MOCK !== "" && LAYOUT !== "" && INIT_DIR !== "";
const tier = (TIER === "bwrap" ? "bwrap" : "gvisor") as "gvisor" | "bwrap";
const d = describe.skipIf(!armed);

const NODE_TOKEN = "box-e2e-node-token-must-not-enter-a-box";
const JOB_SECRET = "box-e2e-job-secret-must-not-enter-a-box";
const REAL_CREDENTIAL = `box-e2e-real-provider-credential-${Math.random().toString(36).slice(2)}`;
const PLACEHOLDER = "slaude-box-placeholder";
const REPO = join(import.meta.dir, "..", "..");

const ENV_KEYS = [
  "SLAUDE_BRAIN_DISABLED", "SLAUDE_AUTO_EVOLVE", "SLAUDE_IDLE_MINUTES", "SLAUDE_NODE_TOKEN", "SLAUDE_JOB_SECRET", "SLAUDE_MASTER_KEY", "SLAUDE_BOX_TIER",
  "SLAUDE_BOX_DIR", "SLAUDE_BOXD_SOCKET", "SLAUDE_BOX_IMAGE_BUDGET_MB", "SLAUDE_AUTO_ALLOW_TOOLS", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "SLAUDE_REDIS_URL", "SLAUDE_GATEWAY_URL",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let work = "";
let boxDir = "";
let configRoot = "";
let digest = "";
let boxdProc: ReturnType<typeof Bun.spawn> | null = null;
let boxdLog = "";
let guard: ReturnType<typeof Bun.serve>;
const modelRequests: Array<{ path: string; apiKey: string | null; authorization: string | null }> = [];
let redis: any;
let keys: any;
let server: any;
let qd: any;
let worker: any;
let startWorker: (nodeId: string) => Promise<any>;
let emitSlack: (name: string, args: any) => Promise<void>;
let workingDirOf: (thread: string) => Promise<string>;
let sessionIdOf: (thread: string) => Promise<string>;
let nodeTurnsQueueFn: any;
let boxdClient: any;
const posts: any[] = [];
const reacts: any[] = [];
const nodeIds: string[] = [];

const msg = (thread: string, ts: string, text: string) => ({
  event: { type: "message", channel: "C0TEAM", user: "U0MGR", team: "T", ts, thread_ts: thread, text },
  client: { auth: { test: async () => ({ user_id: "USLAUDE", bot_id: "BSLAUDE" }) } },
  context: { teamId: "T" },
});

let turnSeq = 0;
/**
 * A mock-model turn that makes the agent run one Bash command. Each turn gets its own tool call ids: a session resumed
 * from its transcript drops a tool call whose id an earlier turn used, and the mock would then never see its result.
 */
const bashTurn = (script: string): string =>
  `<@USLAUDE> [[mock:multi-tool n=1 id=t${++turnSeq} args=${Buffer.from(JSON.stringify({ command: script, description: "box smoke" })).toString("base64url")}]] run it`;

async function turn(thread: string, ts: string, text: string, timeoutMs = 120_000): Promise<void> {
  await emitSlack("message", msg(thread, ts, text));
  await until(() => reacts.some((r) => r.name === "white_check_mark" && r.timestamp === ts), timeoutMs);
}

const read = (dir: string, name: string): string => {
  try {
    return readFileSync(join(dir, "smoke", name), "utf8");
  } catch {
    return `<${name} was not written>`;
  }
};

d(`a boxed session end to end on tier ${tier}`, () => {
  beforeAll(async () => {
    if (process.getuid?.() !== 0) throw new Error("the boxed worker suite needs root");
    const home = process.env.SLAUDE_HOME!;
    work = mkdtempSync("/var/tmp/sbw-");
    boxDir = join(work, "box");
    configRoot = join(work, "config-home");
    for (const p of [boxDir, configRoot, join(work, "run")]) mkdirSync(p, { recursive: true });

    // The provider: a guard that records the credential of every model request, in front of the mock model.
    guard = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      async fetch(req) {
        const u = new URL(req.url);
        modelRequests.push({ path: u.pathname, apiKey: req.headers.get("x-api-key"), authorization: req.headers.get("authorization") });
        if (req.headers.get("x-api-key") !== REAL_CREDENTIAL) return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });
        const h = new Headers(req.headers);
        h.delete("host");
        h.delete("content-length");
        return fetch(`${MOCK}${u.pathname}${u.search}`, { method: req.method, headers: h, body: req.method === "GET" ? undefined : req.body, duplex: "half" } as RequestInit);
      },
    });

    Object.assign(process.env, {
      SLAUDE_BRAIN_DISABLED: "1",
      SLAUDE_AUTO_EVOLVE: "0",
      SLAUDE_IDLE_MINUTES: "0",
      SLAUDE_NODE_TOKEN: NODE_TOKEN,
      SLAUDE_JOB_SECRET: JOB_SECRET,
      SLAUDE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      SLAUDE_BOX_TIER: tier,
      SLAUDE_BOX_DIR: boxDir,
      SLAUDE_BOXD_SOCKET: join(work, "run", "boxd.sock"),
      // The node's boot sizing check is real: a small test disk needs small budgets.
      SLAUDE_BOX_IMAGE_BUDGET_MB: "1024",
      SLAUDE_AUTO_ALLOW_TOOLS: "Bash",
      // The node's own provider variables: what an unboxed child would inherit, and what a box must never see.
      ANTHROPIC_API_KEY: REAL_CREDENTIAL,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${guard.port}`,
      SLAUDE_REDIS_URL: REAL_URL,
    });

    // The image, into the node's image cache.
    const { makeImageStore, cliImageRunner } = await import("../../src/box/image");
    digest = (await makeImageStore({ dir: boxDir, runner: cliImageRunner(), budgetMb: 0, log: () => {} }).importLayout(LAYOUT)).digest;

    // The supervisor: its own process, root, with NOTHING of this process's environment.
    boxdProc = Bun.spawn(["bun", "--no-env-file", join(REPO, "src/box/boxd/main.ts"), "--mount-root", home, "--mount-root", configRoot, "--ro-root", REPO], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SLAUDE_BOX_DIR: boxDir, SLAUDE_BOXD_SOCKET: join(work, "run", "boxd.sock"), SLAUDE_BOX_TIER: tier, SLAUDE_BOX_INIT_DIR: INIT_DIR },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    for (const s of [boxdProc.stdout, boxdProc.stderr]) {
      void (async () => {
        for await (const c of s as ReadableStream<Uint8Array>) boxdLog += Buffer.from(c).toString();
      })();
    }
    await until(() => existsSync(join(work, "run", "boxd.sock")) || boxdProc!.exitCode !== null, 30_000);
    if (boxdProc.exitCode !== null) throw new Error(`the supervisor did not start: ${boxdLog}`);

    const { ensureHome } = await import("../../src/config/home");
    const { writeSoulFixture, WORLD } = await import("../../src/gateway/sim/soul-fixture");
    const { createGateway } = await import("../../src/gateway/core/gateway");
    const { makeQueueDispatch } = await import("../../src/gateway/core/dispatch");
    const { AgentManager } = await import("../../src/agent/manager");
    const { makeKeys, nodeTurnsQueue } = await import("../../src/queue/keys");
    const { makeRegistry } = await import("../../src/queue/registry");
    const { makePubSub } = await import("../../src/queue/pubsub");
    const { TurnQueues } = await import("../../src/queue/turns");
    const { Redis } = await import("ioredis");
    const { NodeClient } = await import("../../src/node/client");
    const { startNodeWorker } = await import("../../src/node/worker");
    const { defaultBoxPolicy } = await import("../../src/box/policy");
    const { BoxdClient } = await import("../../src/box/boxd/client");
    const Sessions = await import("../../src/db/sessions");
    nodeTurnsQueueFn = nodeTurnsQueue;
    boxdClient = new BoxdClient({ socketPath: join(work, "run", "boxd.sock") });

    ensureHome();
    writeSoulFixture(WORLD);
    keys = makeKeys(testPrefix("wbox"));
    redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
    await sweepTag(redis, "wbox");
    const subG = new Redis(REAL_URL, { maxRetriesPerRequest: null });

    const gwAgent = new AgentManager();
    const turnsQ = new TurnQueues({ connection: redis, keys });
    const registryG = makeRegistry({ redis, keys, heartbeatSec: 1 });
    const pubsubG = makePubSub({ redis, sub: subG, keys });
    qd = makeQueueDispatch(gwAgent, { keys, followPollMs: 50, followLingerMs: 400, infra: { turns: turnsQ, registry: registryG, pubsub: pubsubG } });

    const handlers = new Map<string, (args: any) => Promise<void>>();
    const transport: any = {
      client: {
        auth: { test: async () => ({ user_id: "USLAUDE", bot_id: "BSLAUDE", team: "T", url: "x" }) },
        chat: {
          postMessage: async (a: any) => (posts.push(a), { ok: true, ts: `${posts.length}.1` }),
          update: async () => ({ ok: true }),
          postEphemeral: async (a: any) => (posts.push(a), { ok: true }),
        },
        reactions: { add: async (a: any) => (reacts.push(a), { ok: true }), remove: async () => ({ ok: true }) },
        conversations: { info: async () => ({}), members: async () => ({ members: [] }), replies: async () => ({ messages: [] }), open: async () => ({ channel: { id: "D0MGR" } }) },
        users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
        search: { messages: async () => ({ messages: { matches: [], total: 0 } }) },
        files: { uploadV2: async () => ({ files: [] }) },
      },
      action: () => {},
      use: () => {},
      start: async () => {},
      stop: async () => {},
      event: (name: string, fn: any) => handlers.set(name, fn),
    };
    emitSlack = async (name, args) => {
      await handlers.get(name)?.(args);
    };
    const gw = createGateway(gwAgent, transport, { queueDispatch: qd });
    server = Bun.serve({ port: 0, idleTimeout: 0, fetch: async (req: Request) => (await gw.fetchV1(req)) ?? new Response("nf", { status: 404 }) });
    process.env.SLAUDE_GATEWAY_URL = `http://127.0.0.1:${server.port}`;

    const row = async (thread: string) => (await Sessions.findByThread({ team_id: "T", channel_id: "C0TEAM", thread_ts: thread }))!;
    workingDirOf = async (thread) => (await row(thread)).working_dir;
    sessionIdOf = async (thread) => (await row(thread)).id;

    const policy = defaultBoxPolicy();
    policy.tier = tier;
    policy.resources = { ...policy.resources, memoryMb: 1536, memoryReserveMb: 512, pids: 256, rootOverlayMb: 512 };
    const box = { name: "smoke", image: `localhost/imported@${digest}`, digest, policy };

    startWorker = async (nodeId: string) => {
      const client = new NodeClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: NODE_TOKEN, baseDelayMs: 5 });
      // What a gateway with boxes on would supply: the box in the bundle, the pin in the session view.
      const getRuntime = client.getRuntime.bind(client);
      client.getRuntime = (async (...a: Parameters<typeof getRuntime>) => ({ ...(await getRuntime(...a)), box })) as typeof client.getRuntime;
      const getSession = client.getSession.bind(client);
      client.getSession = (async (...a: Parameters<typeof getSession>) => {
        const v = await getSession(...a);
        return v ? { ...v, box_name: box.name, box_digest: digest } : v;
      }) as typeof client.getSession;
      nodeIds.push(nodeId);
      return startNodeWorker({
        nodeId,
        client,
        redisUrl: REAL_URL,
        keys,
        concurrency: 2,
        heartbeatSec: 1,
        nodeTtlSec: 3,
        drainSec: 15,
        port: null,
        lock: { ttlMs: 10_000, extendEveryMs: 1_000 },
        turnTimeoutMs: 180_000,
        configRoot,
        manifest: null,
        // No driver: the worker runs its boxes through the supervisor, as a deployment does.
        box: { capacity: { maxBoxes: 4, memoryBudgetMb: 6144, parkBudgetMb: 0, smallestReserveMb: 512 }, prewarmTimeoutMs: 500 },
      });
    };
    worker = await startWorker("box-node-a");
  }, 300_000);

  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (!armed) return;
    await worker?.stop({ drainSec: 5 }).catch(() => {});
    await qd?.close().catch(() => {});
    server?.stop(true);
    guard?.stop(true);
    boxdClient?.close();
    if (boxdProc) {
      boxdProc.kill("SIGTERM");
      await Promise.race([boxdProc.exited, sleep(20_000)]);
    }
    if (redis) await obliterateQueues(redis, keys.bullPrefix, ["turns", ...nodeIds.map((n) => nodeTurnsQueueFn(n))]);
    if (redis) await cleanupPrefix(redis, keys.prefix);
    try {
      await redis?.quit();
    } catch {
      /* already closed */
    }
    if (process.env.SLAUDE_BOX_TEST_KEEP !== "1" && work) rmSync(work, { recursive: true, force: true });
  }, 120_000);

  const A = "7100.0";
  const B = "7200.0";

  test("the supervisor refuses to start with a credential in its environment, and names only the variable", async () => {
    const p = Bun.spawn(["bun", "--no-env-file", join(REPO, "src/box/boxd/main.ts")], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SLAUDE_BOX_DIR: join(work, "other-box"), SLAUDE_BOXD_SOCKET: join(work, "run", "other.sock"), SLAUDE_BOX_INIT_DIR: INIT_DIR, ANTHROPIC_API_KEY: REAL_CREDENTIAL, SLAUDE_NODE_TOKEN: NODE_TOKEN },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(code).toBe(1);
    expect(err).toContain("ANTHROPIC_API_KEY");
    expect(err).toContain("SLAUDE_NODE_TOKEN");
    expect(err).not.toContain(REAL_CREDENTIAL);
    expect(err).not.toContain(NODE_TOKEN);
    expect(existsSync(join(work, "run", "other.sock"))).toBe(false);
  }, 60_000);

  test("a turn with a Bash tool call runs in a box and completes", async () => {
    const script = [
      "mkdir -p smoke",
      "id -u > smoke/uid",
      "pwd > smoke/pwd",
      "echo $HOME > smoke/home",
      "env > smoke/env",
      "for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' < $f; echo; done > smoke/environ 2>/dev/null",
      "cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' ' > smoke/cmdline",
      "grep -E 'CapEff|NoNewPrivs' /proc/self/status > smoke/caps",
      "cat /home/agent/.box-seed > smoke/seed 2>&1",
      "echo home-write > /home/agent/kept",
      "echo overlay-write > /var/tmp/sys-marker; cat /var/tmp/sys-marker > smoke/sys-now",
      "(curl -sS --noproxy '*' -m 6 -o /dev/null -w 'http=%{http_code}' https://example.com; echo \" rc=$?\") > smoke/direct 2>&1",
      "(curl -sS -m 8 -w ' http=%{http_code}' http://not-on-the-list.example.com/) > smoke/blocked 2>&1",
      "(curl -sS -m 8 -o /dev/null https://not-on-the-list.example.com/; echo \"rc=$?\") > smoke/blocked-tls 2>&1",
      "(curl -sS -m 8 -o /dev/null -w 'http=%{http_code}' http://127.0.0.1:1/ --noproxy '' -x http://127.0.0.1:3128) > smoke/loopback 2>&1",
      "echo done > smoke/done",
    ].join("; ");
    await turn(A, "7100.1", bashTurn(script));
    const ws = await workingDirOf(A);
    expect(read(ws, "done").trim()).toBe("done");
    expect(read(ws, "uid").trim()).toBe("10001");
    expect(read(ws, "pwd").trim()).toBe(ws);
    expect(read(ws, "home").trim()).toBe("/home/agent");
    expect(read(ws, "seed").trim()).toBe("seeded from the image");
    expect(read(ws, "caps")).toMatch(/CapEff:\s+0000000000000000/);
    expect(read(ws, "caps")).toMatch(/NoNewPrivs:\s+1/);
    expect(read(ws, "sys-now").trim()).toBe("overlay-write");
    // The supervisor ran it: a sandbox of this session exists.
    const list = await boxdClient.request("sandbox.list", {});
    expect(list.sandboxes.map((s: { sandboxId: string }) => s.sandboxId)).toContain(await sessionIdOf(A));
    expect(list.sandboxes[0].tier).toBe(tier);
  }, 240_000);

  test("the box's environment, every process's environ and every command line hold no credential", async () => {
    const ws = await workingDirOf(A);
    const all = read(ws, "env") + read(ws, "environ") + read(ws, "cmdline");
    expect(all.length).toBeGreaterThan(200);
    for (const secret of [REAL_CREDENTIAL, NODE_TOKEN, JOB_SECRET, process.env.SLAUDE_MASTER_KEY!]) expect(all).not.toContain(secret);
    for (const name of ["SLAUDE_NODE_TOKEN", "SLAUDE_JOB_SECRET", "SLAUDE_MASTER_KEY", "SLAUDE_REDIS_URL", "SLAUDE_S3_", "SLAUDE_GATEWAY_URL"]) expect(read(ws, "env")).not.toContain(name);
    expect(read(ws, "env")).toContain(`ANTHROPIC_API_KEY=${PLACEHOLDER}`);
    expect(read(ws, "env")).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:3129");
    expect(read(ws, "env")).toContain("HTTPS_PROXY=http://127.0.0.1:3128");
    expect(read(ws, "env")).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
    // And nothing of them is in the directories the box was given.
    const sid = await sessionIdOf(A);
    const grep = Bun.spawnSync(["grep", "-rIl", "-e", REAL_CREDENTIAL, "-e", NODE_TOKEN, "-e", JOB_SECRET, join(boxDir, "sessions", sid), ws, join(configRoot, "sessions", sid)]);
    expect(grep.stdout.toString().trim()).toBe("");
    expect(existsSync(join(configRoot, "sessions", sid, ".credentials.json"))).toBe(false);
  }, 60_000);

  test("every model request reached the provider with the real credential, added outside the box; the placeholder never did", () => {
    const messages = modelRequests.filter((r) => r.path.endsWith("/v1/messages"));
    expect(messages.length).toBeGreaterThanOrEqual(2);
    for (const r of modelRequests) {
      expect(r.apiKey).toBe(REAL_CREDENTIAL);
      expect(`${r.apiKey} ${r.authorization}`).not.toContain(PLACEHOLDER);
    }
  });

  test("the network is refused except through the proxy, and a host that is not allowlisted gets the 403", async () => {
    const ws = await workingDirOf(A);
    expect(read(ws, "direct")).not.toContain("http=200");
    expect(read(ws, "direct")).not.toContain("rc=0");
    expect(read(ws, "blocked")).toContain("http=403");
    expect(read(ws, "blocked")).toContain("not-on-the-list.example.com is not on this box's allowlist");
    expect(read(ws, "blocked-tls")).toMatch(/403/);
    expect(read(ws, "blocked-tls")).not.toContain("rc=0");
    expect(read(ws, "loopback")).toContain("http=403");
  }, 60_000);

  test("a reply goes out through the node's shims from a boxed session", async () => {
    posts.length = 0;
    await turn(A, "7100.2", "<@USLAUDE> [[mock:echo]] can you hear me from the box");
    expect(posts.some((p) => String(p.text ?? "").includes("can you hear me from the box"))).toBe(true);
  }, 240_000);

  test("a second session's box cannot see the first's home or workspace", async () => {
    const wsA = await workingDirOf(A);
    const script = [
      "mkdir -p smoke",
      `(ls -la ${wsA}; cat ${wsA}/smoke/env) > smoke/peek-workspace 2>&1`,
      "(cat /home/agent/kept) > smoke/peek-home 2>&1",
      `(ls ${join(boxDir, "sessions")}) > smoke/peek-sessions 2>&1`,
      "(cat /var/tmp/sys-marker) > smoke/peek-overlay 2>&1",
      "echo b-home > /home/agent/b-only",
      "echo done > smoke/done",
    ].join("; ");
    await turn(B, "7200.1", bashTurn(script));
    const wsB = await workingDirOf(B);
    expect(wsB).not.toBe(wsA);
    expect(read(wsB, "done").trim()).toBe("done");
    for (const f of ["peek-workspace", "peek-home", "peek-sessions", "peek-overlay"]) expect(read(wsB, f)).toMatch(/No such file or directory/);
    expect(read(wsB, "peek-workspace")).not.toContain("ANTHROPIC");
    expect(read(wsB, "peek-home")).not.toContain("home-write");
    // Both sandboxes are running at once, each on its own home.
    const [a, b] = [await sessionIdOf(A), await sessionIdOf(B)];
    expect(readFileSync(join(boxDir, "sessions", a, "home", "kept"), "utf8").trim()).toBe("home-write");
    expect(existsSync(join(boxDir, "sessions", a, "home", "b-only"))).toBe(false);
    expect(readFileSync(join(boxDir, "sessions", b, "home", "b-only"), "utf8").trim()).toBe("b-home");
  }, 240_000);

  // On thread B, which nothing uses afterwards: an aborted turn leaves a tool call without a result in the
  // transcript, and the mock model numbers its tool calls from 1 in every turn, so the next turn of that thread would
  // be answered with tool calls for ever. That is the mock's doing, not a box's.
  test("abort ends what the agent was running, within seconds", async () => {
    const sid = await sessionIdOf(B);
    /** Processes in the session's sandbox, counted by the supervisor; none when the sandbox is gone. */
    const pids = async (): Promise<number> => {
      try {
        return (await boxdClient.request("sandbox.stats", { sandboxId: sid })).pids;
      } catch (e) {
        if (/no sandbox of this id/.test(String((e as Error).message))) return 0;
        throw e;
      }
    };
    const idle = await pids();
    expect(idle).toBeGreaterThan(0);
    await emitSlack("message", msg(B, "7200.2", bashTurn("sleep 300 & sleep 300 & sleep 300; wait")));
    await until(async () => (await pids()) >= idle + 3, 60_000);
    const running = await pids();
    const t0 = Date.now();
    await emitSlack("message", msg(B, "7200.3", "<@USLAUDE> /abort"));
    await until(async () => (await pids()) < idle + 1, 20_000);
    const took = Date.now() - t0;
    const left = await pids();
    const live = (await boxdClient.request("sandbox.list", {})).sandboxes.some((s: { sandboxId: string }) => s.sandboxId === sid);
    console.log(`[tier ${tier}] abort: ${running} processes while the tool ran (${idle} idle); ${left} left ${took} ms after /abort; the sandbox is ${live ? "still running" : "stopped (the agent's process was ended, and its sandbox with it)"}`);
    expect(took).toBeLessThan(10_000);
    expect(posts.some((p) => String(p.text) === "aborted")).toBe(true);
    // Once the agent's own process has gone too, nothing of the turn is left: gVisor keeps box-init, bwrap nothing.
    await until(async () => (await pids()) <= (tier === "gvisor" ? 1 : 0), 15_000);
  }, 240_000);

  test("after the node drains and another worker starts: the home write is there, the write outside home and workspace is not", async () => {
    const sidA = await sessionIdOf(A);
    await worker.stop({ drainSec: 10 });
    // Drain stopped every sandbox and threw their root overlays away.
    expect((await boxdClient.request("sandbox.list", {})).sandboxes).toEqual([]);
    expect(existsSync(join(boxDir, "sessions", sidA, "overlay"))).toBe(false);
    expect(existsSync(join(boxDir, "sessions", sidA, "run"))).toBe(false);
    expect(readFileSync(join(boxDir, "sessions", sidA, "home", "kept"), "utf8").trim()).toBe("home-write");

    worker = await startWorker("box-node-b");
    const script = ["(cat /home/agent/kept) > smoke/after-home 2>&1", "(cat /var/tmp/sys-marker) > smoke/after-overlay 2>&1", "cat smoke/done > smoke/after-workspace 2>&1", "echo again > smoke/done2"].join("; ");
    await turn(A, "7100.5", bashTurn(script));
    const ws = await workingDirOf(A);
    expect(read(ws, "done2").trim()).toBe("again");
    expect(read(ws, "after-home").trim()).toBe("home-write");
    expect(read(ws, "after-workspace").trim()).toBe("done");
    expect(read(ws, "after-overlay")).toMatch(/No such file or directory/);
  }, 300_000);

  test("a node that offers a sandbox says so, and the supervisor's log holds no credential", async () => {
    const { nodeCapabilities } = await import("../../src/node/worker");
    expect(nodeCapabilities(tier)).toContain("box/1");
    expect(nodeCapabilities(tier)).toContain(`box-tier/${tier}`);
    expect(boxdLog).toContain(`tier ${tier}`);
    expect(boxdLog).not.toContain(REAL_CREDENTIAL);
    expect(boxdLog).not.toContain(NODE_TOKEN);
  });

  // Last: it ends the supervisor.
  test("a box that cannot be started is a failed turn, never an unboxed run", async () => {
    boxdProc!.kill("SIGTERM");
    await Promise.race([boxdProc!.exited, sleep(20_000)]);
    const C = "7300.0";
    const before = { requests: modelRequests.length, reacts: reacts.length };
    await emitSlack("message", msg(C, "7300.1", bashTurn("mkdir -p smoke; echo ran-on-the-node > smoke/ran; id -u > smoke/uid")));
    // The turn fails; give it the time a successful one takes several times over.
    await until(() => reacts.slice(before.reacts).some((r) => r.timestamp === "7300.1" && r.name !== "eyes"), 30_000).catch(() => {});
    await sleep(3_000);
    const ws = await workingDirOf(C);
    expect(existsSync(join(ws, "smoke", "ran"))).toBe(false);
    expect(modelRequests.length).toBe(before.requests);
    expect(reacts.some((r) => r.name === "white_check_mark" && r.timestamp === "7300.1")).toBe(false);
  }, 120_000);
});
