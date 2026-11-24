/**
 * A boxed session moves between nodes through the object store (box plan,
 * Phase 5): what it installed into its home and into the workspace's
 * node_modules is there on the next node, what it wrote at system level is
 * not, and a node that dies with a flush still owed costs exactly the edits
 * since its last flush, counted.
 *
 * Real pieces: a node worker with SLAUDE_BOX_TIER set, the box supervisor as
 * its own root process, the real CLI in a real sandbox, the mock model, a
 * throwaway Redis, and one object store shared by every node (the directory
 * store behind SLAUDE_STORAGE=s3, the one tests/storage/contract.ts runs).
 *
 * Gated like tests/node/worker-box-real.test.ts and skipped unless all hold:
 *   SLAUDE_BOX_TEST_TIER=gvisor|bwrap, SLAUDE_REDIS_TEST_URL,
 *   SLAUDE_BOX_TEST_MOCK_LLM, SLAUDE_BOX_TEST_LAYOUT, SLAUDE_BOX_TEST_INIT_DIR.
 * scripts/smoke/box-smoke.sh prepares all of it.
 *
 * What is modelled, not real:
 *   - Three nodes run one after another in this process (A, B, C). A node's
 *     own disk is modelled by moving every node-local directory aside before
 *     the next node starts (workspaces, transcripts, the sync state, the box
 *     sessions and pack indexes, the session config homes): the next node
 *     finds the same paths, empty, as a new pod does. Only the object store
 *     and the image cache stay.
 *   - "A tool installed into home" is an executable written to
 *     ~/.local/bin, and "a dependency" is a file under node_modules: a box in
 *     this suite has no allowlisted registry, and the pack units do not care
 *     who wrote a file.
 *   - A killed node is `kill()` (every Redis connection cut, no drain) plus
 *     the supervisor ended and started again, as the pod's other container
 *     goes with the pod.
 *   - The store "cannot be written" by replacing its directory with a file
 *     while a turn runs.
 *   - The gateway cannot pin a session here (the box tables are Postgres
 *     only): the box in the bundle and the pin in the session view are added
 *     to what the node's client reads, as in the worker suite.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REAL_URL, realEnabled, testPrefix, cleanupPrefix, sweepTag, obliterateQueues, until, sleep } from "../queue/real";

const TIER = process.env.SLAUDE_BOX_TEST_TIER;
const MOCK = process.env.SLAUDE_BOX_TEST_MOCK_LLM ?? "";
const LAYOUT = process.env.SLAUDE_BOX_TEST_LAYOUT ?? "";
const INIT_DIR = process.env.SLAUDE_BOX_TEST_INIT_DIR ?? "";
const armed = (TIER === "gvisor" || TIER === "bwrap") && process.platform === "linux" && realEnabled && MOCK !== "" && LAYOUT !== "" && INIT_DIR !== "";
const tier = (TIER === "bwrap" ? "bwrap" : "gvisor") as "gvisor" | "bwrap";
const d = describe.skipIf(!armed);

const NODE_TOKEN = "box-resume-node-token";
const JOB_SECRET = "box-resume-job-secret";
const REAL_CREDENTIAL = `box-resume-provider-credential-${Math.random().toString(36).slice(2)}`;
const REPO = join(import.meta.dir, "..", "..");

const ENV_KEYS = [
  "SLAUDE_BRAIN_DISABLED", "SLAUDE_AUTO_EVOLVE", "SLAUDE_IDLE_MINUTES", "SLAUDE_NODE_TOKEN", "SLAUDE_JOB_SECRET", "SLAUDE_MASTER_KEY", "SLAUDE_BOX_TIER",
  "SLAUDE_BOX_DIR", "SLAUDE_BOXD_SOCKET", "SLAUDE_BOX_IMAGE_BUDGET_MB", "SLAUDE_AUTO_ALLOW_TOOLS", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "SLAUDE_REDIS_URL", "SLAUDE_GATEWAY_URL",
  "SLAUDE_STORAGE", "SLAUDE_STORAGE_LOCAL_DIR", "SLAUDE_SYNC_STATE_DIR", "SLAUDE_SYNC_FLUSH",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let work = "";
let boxDir = "";
let configRoot = "";
let storeDir = "";
let stateDir = "";
let socket = "";
let digest = "";
let boxdProc: ReturnType<typeof Bun.spawn> | null = null;
let boxdLog = "";
let guard: ReturnType<typeof Bun.serve>;
let redis: any;
let keys: any;
let server: any;
let qd: any;
let registry: any;
let store: any;
let worker: any;
let startWorker: (nodeId: string) => Promise<any>;
let startBoxd: () => Promise<void>;
let stopBoxd: () => Promise<void>;
let emitSlack: (name: string, args: any) => Promise<void>;
let workingDirOf: (thread: string) => Promise<string>;
let sessionIdOf: (thread: string) => Promise<string>;
let nodeTurnsQueueFn: any;
let boxdClient: any;
let units: { hm: (sid: string) => string; wx: (ws: string) => string; ws: (ws: string) => string };
let latest: (unit: string) => Promise<{ id: string; manifest: any } | null>;
let lossCount: () => number;
const reacts: any[] = [];
const nodeIds: string[] = [];
let disks = 0;

const msg = (thread: string, ts: string, text: string) => ({
  event: { type: "message", channel: "C0TEAM", user: "U0MGR", team: "T", ts, thread_ts: thread, text },
  client: { auth: { test: async () => ({ user_id: "USLAUDE", bot_id: "BSLAUDE" }) } },
  context: { teamId: "T" },
});

let turnSeq = 0;
/** One Bash command through the mock model. Each turn names its own tool call ids: a thread resumed from its transcript drops a repeated id. */
const bashTurn = (script: string): string =>
  `<@USLAUDE> [[mock:multi-tool n=1 id=r${++turnSeq} args=${Buffer.from(JSON.stringify({ command: script, description: "box resume" })).toString("base64url")}]] run it`;

async function turn(thread: string, ts: string, text: string, timeoutMs = 150_000): Promise<void> {
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

/** Every `projects` directory under the home: where the transcripts of every persona's sessions live on a node. */
function transcriptDirs(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (!isDir || n === "workspaces" || n === "node_modules" || n.includes(".disk")) continue;
      if (n === "projects") out.push(p);
      else if (depth < 4) walk(p, depth + 1);
    }
  };
  walk(home, 0);
  return out;
}

/**
 * The next node's disk: every node-local directory is moved aside, so the same paths are empty. What stays is what a
 * new pod also has or reaches: the object store, and the image cache (a new pod pulls the image; that is phase 4's).
 */
function newDisk(): string[] {
  const home = process.env.SLAUDE_HOME!;
  const n = ++disks;
  const local = [join(home, "workspaces"), ...transcriptDirs(home), stateDir, join(boxDir, "sessions"), join(boxDir, "pack-index"), join(boxDir, "pack-spool"), configRoot];
  const moved: string[] = [];
  for (const p of local) {
    if (!existsSync(p)) continue;
    // Beside itself, so the move never crosses a file system.
    renameSync(p, `${p}.disk${n}`);
    moved.push(p);
  }
  for (const p of [stateDir, configRoot]) mkdirSync(p, { recursive: true });
  return moved;
}

d(`a boxed session resumes on another node from the object store, tier ${tier}`, () => {
  beforeAll(async () => {
    if (process.getuid?.() !== 0) throw new Error("the box resume suite needs root");
    const home = process.env.SLAUDE_HOME!;
    work = mkdtempSync(join(process.env.SLAUDE_BOX_TEST_WORKDIR || "/var/tmp", "sbr-"));
    boxDir = join(work, "box");
    configRoot = join(work, "config-home");
    storeDir = join(work, "store");
    stateDir = join(work, "state");
    socket = join(work, "run", "boxd.sock");
    for (const p of [boxDir, configRoot, storeDir, stateDir, join(work, "run")]) mkdirSync(p, { recursive: true });

    guard = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      async fetch(req) {
        const u = new URL(req.url);
        if (req.headers.get("x-api-key") !== REAL_CREDENTIAL) return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });
        const h = new Headers(req.headers);
        h.delete("host");
        h.delete("content-length");
        const body = req.method === "GET" ? undefined : new Uint8Array(await req.arrayBuffer());
        return fetch(`${MOCK}${u.pathname}${u.search}`, { method: req.method, headers: h, ...(body ? { body } : {}), keepalive: false } as RequestInit);
      },
    });

    Object.assign(process.env, {
      SLAUDE_BRAIN_DISABLED: "1",
      SLAUDE_AUTO_EVOLVE: "0",
      // Three seconds: a session goes idle between the steps of this suite, which is what parks it.
      SLAUDE_IDLE_MINUTES: "0.05",
      SLAUDE_NODE_TOKEN: NODE_TOKEN,
      SLAUDE_JOB_SECRET: JOB_SECRET,
      SLAUDE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      SLAUDE_BOX_TIER: tier,
      SLAUDE_BOX_DIR: boxDir,
      SLAUDE_BOXD_SOCKET: socket,
      SLAUDE_BOX_IMAGE_BUDGET_MB: "1024",
      SLAUDE_AUTO_ALLOW_TOOLS: "Bash",
      ANTHROPIC_API_KEY: REAL_CREDENTIAL,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${guard.port}`,
      SLAUDE_REDIS_URL: REAL_URL,
      // One object store for every node: the directory store behind the s3 mode.
      SLAUDE_STORAGE: "s3",
      SLAUDE_STORAGE_LOCAL_DIR: storeDir,
      SLAUDE_SYNC_STATE_DIR: stateDir,
      SLAUDE_SYNC_FLUSH: "turn",
    });

    const Storage = await import("../../src/storage");
    Storage.resetObjectStore();
    store = Storage.objectStore()!;
    latest = (unit) => Storage.latestManifest(store, unit);
    const { metrics } = await import("../../src/metrics");
    lossCount = () => Number(/^slaude_storage_unflushed_loss_total(?:\{[^}]*\})? (\d+)/m.exec(metrics.render())?.[1] ?? 0);

    const { makeImageStore, cliImageRunner } = await import("../../src/box/image");
    digest = (await makeImageStore({ dir: boxDir, runner: cliImageRunner(), budgetMb: 0, log: () => {} }).importLayout(LAYOUT)).digest;
    units = { hm: (sid) => Storage.hmUnitId(sid), wx: (ws) => Storage.wxUnitId(ws, digest), ws: (ws) => Storage.wsUnitId(ws) };

    const { BoxdClient } = await import("../../src/box/boxd/client");
    startBoxd = async () => {
      rmSync(socket, { force: true });
      boxdProc = Bun.spawn(["bun", "--no-env-file", join(REPO, "src/box/boxd/main.ts"), "--mount-root", home, "--mount-root", configRoot, "--ro-root", REPO], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SLAUDE_BOX_DIR: boxDir, SLAUDE_BOXD_SOCKET: socket, SLAUDE_BOX_TIER: tier, SLAUDE_BOX_INIT_DIR: INIT_DIR },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const proc = boxdProc;
      for (const s of [proc.stdout, proc.stderr]) {
        void (async () => {
          for await (const c of s as ReadableStream<Uint8Array>) boxdLog += Buffer.from(c).toString();
        })();
      }
      await until(() => existsSync(socket) || proc.exitCode !== null, 30_000);
      if (proc.exitCode !== null) throw new Error(`the supervisor did not start: ${boxdLog}`);
      boxdClient = new BoxdClient({ socketPath: socket });
    };
    stopBoxd = async () => {
      boxdClient?.close();
      boxdClient = null;
      if (!boxdProc) return;
      boxdProc.kill("SIGTERM");
      await Promise.race([boxdProc.exited, sleep(20_000)]);
      boxdProc = null;
    };
    await startBoxd();

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
    const Sessions = await import("../../src/db/sessions");
    nodeTurnsQueueFn = nodeTurnsQueue;

    ensureHome();
    writeSoulFixture(WORLD);
    keys = makeKeys(testPrefix("bres"));
    redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
    await sweepTag(redis, "bres");
    const subG = new Redis(REAL_URL, { maxRetriesPerRequest: null });

    const gwAgent = new AgentManager();
    const turnsQ = new TurnQueues({ connection: redis, keys });
    registry = makeRegistry({ redis, keys, heartbeatSec: 1 });
    const pubsubG = makePubSub({ redis, sub: subG, keys });
    qd = makeQueueDispatch(gwAgent, { keys, followPollMs: 50, followLingerMs: 400, infra: { turns: turnsQ, registry, pubsub: pubsubG } });

    const handlers = new Map<string, (args: any) => Promise<void>>();
    const transport: any = {
      client: {
        auth: { test: async () => ({ user_id: "USLAUDE", bot_id: "BSLAUDE", team: "T", url: "x" }) },
        chat: { postMessage: async () => ({ ok: true, ts: `${Date.now()}.1` }), update: async () => ({ ok: true }), postEphemeral: async () => ({ ok: true }) },
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
        box: { capacity: { maxBoxes: 4, memoryBudgetMb: 3072, parkBudgetMb: 1024, smallestReserveMb: 512 }, prewarmTimeoutMs: 500 },
      });
    };
    worker = await startWorker("res-node-a");
  }, 300_000);

  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (!armed) return;
    const { resetObjectStore } = await import("../../src/storage");
    resetObjectStore();
    await worker?.stop({ drainSec: 5 }).catch(() => {});
    await qd?.close().catch(() => {});
    server?.stop(true);
    guard?.stop(true);
    await stopBoxd?.().catch(() => {});
    if (redis) await obliterateQueues(redis, keys.bullPrefix, ["turns", ...nodeIds.map((n) => nodeTurnsQueueFn(n))]);
    if (redis) await cleanupPrefix(redis, keys.prefix);
    try {
      await redis?.quit();
    } catch {
      /* already closed */
    }
    if (process.env.SLAUDE_BOX_TEST_KEEP !== "1" && work) rmSync(work, { recursive: true, force: true });
  }, 120_000);

  const T = "8100.0";
  const homeOf = (sid: string) => join(boxDir, "sessions", sid, "home");

  test("on node A a turn installs a tool into home, a dependency into node_modules and a file at system level", async () => {
    const script = [
      "mkdir -p smoke $HOME/.local/bin node_modules/left-pad",
      "printf '#!/bin/sh\\necho mytool-1.0\\n' > $HOME/.local/bin/mytool",
      "chmod 755 $HOME/.local/bin/mytool",
      "echo 'module.exports = 1' > node_modules/left-pad/index.js",
      "echo plain-workspace-file > smoke/plain",
      "(echo system-level > /var/tmp/sys-tool; cat /var/tmp/sys-tool) > smoke/sys-a 2>&1",
      "$HOME/.local/bin/mytool > smoke/tool-a 2>&1",
      "echo done > smoke/done-a",
    ].join("; ");
    await turn(T, "8100.1", bashTurn(script));
    const ws = await workingDirOf(T);
    expect(read(ws, "done-a").trim()).toBe("done");
    expect(read(ws, "tool-a").trim()).toBe("mytool-1.0");
    expect(read(ws, "sys-a").trim()).toBe("system-level");
    expect(worker.warmSessions()).toContain(await sessionIdOf(T));
  }, 240_000);

  test("idle on node A: the session is parked, its sandbox stopped, and all four units are in the store", async () => {
    const sid = await sessionIdOf(T);
    const ws = await workingDirOf(T);
    await until(async () => (await registry.parkedNode(sid)) === "res-node-a", 60_000);
    await until(async () => !(await boxdClient.request("sandbox.list", {})).sandboxes.some((s: { sandboxId: string }) => s.sandboxId === sid), 30_000);
    const hm = await latest(units.hm(sid));
    const wx = await latest(units.wx(ws));
    const wsUnit = await latest(units.ws(ws));
    expect(hm?.manifest.kind).toBe("pack");
    expect(wx?.manifest.kind).toBe("pack");
    expect(hm!.manifest.layers.length).toBeGreaterThanOrEqual(1);
    expect(wx!.manifest.layers.length).toBeGreaterThanOrEqual(1);
    // The per-file unit holds the plain file and nothing of node_modules: the two units split the workspace.
    const paths = JSON.stringify(wsUnit?.manifest ?? {});
    expect(paths).toContain("smoke/plain");
    expect(paths).not.toContain("node_modules");
    // Parked: the local copies are still on node A's disk.
    expect(existsSync(join(homeOf(sid), ".local", "bin", "mytool"))).toBe(true);
    expect(existsSync(join(ws, "node_modules", "left-pad", "index.js"))).toBe(true);
  }, 120_000);

  test("node A goes away; node B, on an empty disk, resumes the session with its home and node_modules and without the system-level file", async () => {
    const sid = await sessionIdOf(T);
    const ws = await workingDirOf(T);
    await worker.stop({ drainSec: 10 });
    const moved = newDisk();
    expect(moved.length).toBeGreaterThanOrEqual(4);
    expect(existsSync(ws)).toBe(false);
    expect(existsSync(homeOf(sid))).toBe(false);
    expect(await registry.parkedNode(sid)).toBeNull();

    worker = await startWorker("res-node-b");
    const script = [
      "mkdir -p smoke",
      "($HOME/.local/bin/mytool) > smoke/tool-b 2>&1",
      "(cat node_modules/left-pad/index.js) > smoke/dep-b 2>&1",
      "(cat smoke/plain) > smoke/plain-b 2>&1",
      "(cat smoke/done-a) > smoke/done-a-b 2>&1",
      "(cat /var/tmp/sys-tool) > smoke/sys-b 2>&1",
      "(cat $HOME/.box-seed) > smoke/seed-b 2>&1",
      "echo second > $HOME/second-note",
      "echo done > smoke/done-b",
    ].join("; ");
    await turn(T, "8100.2", bashTurn(script));
    expect(read(ws, "done-b").trim()).toBe("done");
    expect(worker.warmSessions()).toContain(sid);
    expect(read(ws, "tool-b").trim()).toBe("mytool-1.0");
    expect(read(ws, "dep-b").trim()).toBe("module.exports = 1");
    expect(read(ws, "plain-b").trim()).toBe("plain-workspace-file");
    expect(read(ws, "done-a-b").trim()).toBe("done");
    expect(read(ws, "seed-b").trim()).toBe("seeded from the image");
    expect(read(ws, "sys-b")).toMatch(/No such file or directory/);
    // The conversation came with it: node B's transcript of this folder holds the first turn's tool call.
    const transcripts = transcriptDirs(process.env.SLAUDE_HOME!)
      .flatMap((p) => readdirSync(p).map((n) => join(p, n)))
      .flatMap((p) => readdirSync(p).filter((n) => n.endsWith(".jsonl")).map((n) => readFileSync(join(p, n), "utf8")));
    expect(transcripts.some((t) => t.includes("smoke/done-a") && t.includes("smoke/done-b"))).toBe(true);
  }, 300_000);

  test("node B dies with a flush still owed; node C resumes from the last flush and the loss is counted", async () => {
    const sid = await sessionIdOf(T);
    const ws = await workingDirOf(T);
    // The last flush that lands: node B's second-note is in the store before anything goes wrong.
    await until(async () => (await registry.parkedNode(sid)) === "res-node-b", 60_000);
    const flushed = (await latest(units.hm(sid)))!.id;

    // A turn whose edits cannot be stored: the store stops accepting writes while the command runs.
    const script = ["echo never-flushed > $HOME/unflushed-note", "echo never-flushed > smoke/unflushed-ws", "sleep 8", "echo done > smoke/done-lost"].join("; ");
    await emitSlack("message", msg(T, "8100.3", bashTurn(script)));
    await until(() => existsSync(join(homeOf(sid), "unflushed-note")), 120_000);
    renameSync(storeDir, `${storeDir}.away`);
    writeFileSync(storeDir, "not a directory");
    await until(() => reacts.some((r) => r.name === "white_check_mark" && r.timestamp === "8100.3"), 150_000);
    await until(async () => (await redis.get(keys.needsFlush(units.hm(sid)))) !== null, 60_000);
    expect(JSON.parse((await redis.get(keys.needsFlush(units.hm(sid))))!).node).toBe("res-node-b");

    const before = lossCount();
    worker.kill();
    await stopBoxd();
    rmSync(storeDir, { force: true });
    renameSync(`${storeDir}.away`, storeDir);
    newDisk();
    await startBoxd();
    // Nothing reached the store from the dead node.
    expect((await latest(units.hm(sid)))!.id).toBe(flushed);
    await until(async () => !(await registry.nodeAlive("res-node-b")) && (await registry.lookup(sid)) === null, 60_000);

    worker = await startWorker("res-node-c");
    const check = [
      "mkdir -p smoke",
      "($HOME/.local/bin/mytool) > smoke/tool-c 2>&1",
      "(cat $HOME/second-note) > smoke/second-c 2>&1",
      "(cat node_modules/left-pad/index.js) > smoke/dep-c 2>&1",
      "(cat $HOME/unflushed-note) > smoke/unflushed-c 2>&1",
      "(cat smoke/unflushed-ws) > smoke/unflushed-ws-c 2>&1",
      "echo done > smoke/done-c",
    ].join("; ");
    await turn(T, "8100.4", bashTurn(check));
    expect(read(ws, "done-c").trim()).toBe("done");
    expect(worker.warmSessions()).toContain(sid);
    // From the last flush: everything up to it is there.
    expect(read(ws, "tool-c").trim()).toBe("mytool-1.0");
    expect(read(ws, "second-c").trim()).toBe("second");
    expect(read(ws, "dep-c").trim()).toBe("module.exports = 1");
    // The edits the dead node never stored are gone, and that is counted, once per unit that lost something.
    expect(read(ws, "unflushed-c")).toMatch(/No such file or directory/);
    expect(read(ws, "unflushed-ws-c")).toMatch(/No such file or directory/);
    expect(lossCount()).toBeGreaterThan(before);
    expect(await redis.get(keys.needsFlush(units.hm(sid)))).toBeNull();
    // And the session is whole again: node C's own flush lands.
    await until(async () => (await latest(units.hm(sid)))!.id !== flushed || (await registry.parkedNode(sid)) === "res-node-c", 60_000);
  }, 420_000);

  test("the supervisor's log holds no credential", () => {
    expect(boxdLog).not.toContain(REAL_CREDENTIAL);
    expect(boxdLog).not.toContain(NODE_TOKEN);
  });
});
