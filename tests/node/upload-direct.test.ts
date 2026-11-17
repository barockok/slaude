/**
 * The node's direct upload: an `upload` tool call on a node asks the gateway
 * for Slack's presigned URL (upload_begin), sends the bytes straight to Slack,
 * checks Slack's answer, and only then tells the gateway to finish
 * (upload_complete). A real in-process gateway, a real NodeClient and the real
 * shims, with a fake Slack API (the three files.* calls) and a fake Slack
 * upload host that hashes what it receives.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, renameSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

process.env.SLAUDE_BRAIN_DISABLED = "1";

import { createGateway, type GatewayHandle } from "../../src/gateway/core/gateway";
import { AgentManager } from "../../src/agent/manager";
import type { Transport } from "../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../src/gateway/sim/soul-fixture";
import { mintJobToken, type JobClaims } from "../../src/gateway/api/auth";
import { NodeClient } from "../../src/node/client";
import { buildShimServers, __resetUploadFallbackLogs, type ShimDeps } from "../../src/node/shims";
import { ensureHome } from "../../src/config/home";
import { __setUploadLimiter, localUploadLimiter } from "../../src/gateway/upload/limiter";
import { VOICE_SUPPRESSED_RESULT } from "../../src/voice/turn-flags";
import { mustReplyEffect } from "../../src/agent/must-reply";
import { __clearGuardrailsForTests, applyGuardrailChange } from "../../src/db/guardrails";
import { __resetGuardrailSnapshotsForTests, refreshGuardrails } from "../../src/guardrails/snapshot";
import { __resetHeldDecisionsForTests, setOutboundApprover } from "../../src/gateway/slack/outbound";
import { ensureGuardrailKeyForPg } from "../guardrails/helpers";

ensureGuardrailKeyForPg();

const NODE_TOKEN = "upl-node-token";
const JOB_SECRET = "upl-job-secret";
const SESSION = "S-upl";
const sha = (b: Uint8Array | Buffer) => createHash("sha256").update(b).digest("hex");

// ---- fake Slack: the Web API calls and the upload host ----
type Mode = "ok" | "redirect" | "http500" | "wrong-count" | "junk" | "drop" | "slow";
let mode: Mode = "ok";
const apiCalls: Array<{ name: string; args: any }> = [];
const received: Array<{ id: string; sha: string; n: number; contentLength: string | null; contentType: string | null }> = [];
let onBegin: ((args: any) => void) | undefined;
let uploadsBase = "";
let dropBase = "";
let dropServer: NetServer;
let uploadHost: ReturnType<typeof Bun.serve>;
let seq = 0;

function recordingTransport(): Transport {
  return {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({ members: [] }), replies: async () => ({ messages: [] }) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({ messages: { matches: [], total: 0 } }) },
      files: {
        uploadV2: async () => { throw new Error("uploadV2 must not be used by a node upload"); },
        getUploadURLExternal: async (a: any) => {
          apiCalls.push({ name: "getUploadURLExternal", args: a });
          onBegin?.(a);
          const id = `F${++seq}`;
          return { ok: true, upload_url: `${mode === "drop" ? dropBase : uploadsBase}/upload/${id}?secret=UPLOADURLSECRET`, file_id: id };
        },
        completeUploadExternal: async (a: any) => {
          apiCalls.push({ name: "completeUploadExternal", args: a });
          return { ok: true, files: [{ id: a.files[0].id }] };
        },
      },
    } as any,
    action: () => {}, event: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
  };
}

let handle: GatewayHandle;
let server: ReturnType<typeof Bun.serve>;
let nodeClient: NodeClient;
let work = "";
let scratch = "";
let outside = "";
let gatewayHits: string[] = [];
let blockBegin: "none" | "old-gateway" | "no-capability" = "none";

const tokenWith = (over: Partial<JobClaims> = {}) =>
  mintJobToken({ tenant: "default", persona: "default", session: SESSION, team: "T1", channel: "C0TEAM", thread: "600.0", initiator: WORLD.manager, scope: "turn", ...over });

beforeAll(async () => {
  process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
  process.env.SLAUDE_JOB_SECRET = JOB_SECRET;
  process.env.SLAUDE_UPLOAD_ALLOWED_HOSTS = "127.0.0.1";
  ensureHome();
  writeSoulFixture(WORLD);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "slaude-upl-")));
  work = join(root, "work"); scratch = join(root, "scratch"); outside = join(root, "outside");
  for (const d of [work, scratch, outside]) mkdirSync(d);

  uploadHost = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const id = new URL(req.url).pathname.split("/").pop()!;
      if (req.method !== "POST") return new Response("no", { status: 405 });
      if (mode === "slow") await Bun.sleep(300);
      if (mode === "redirect") return new Response("", { status: 307, headers: { location: "http://127.0.0.1:1/elsewhere" } });
      const buf = new Uint8Array(await req.arrayBuffer());
      received.push({ id, sha: sha(buf), n: buf.byteLength, contentLength: req.headers.get("content-length"), contentType: req.headers.get("content-type") });
      if (mode === "http500") return new Response("<Error><Code>s3_upload</Code></Error>", { status: 500 });
      if (mode === "wrong-count") return new Response(`OK - ${buf.byteLength + 1}`);
      if (mode === "junk") return new Response("<html>maintenance</html>");
      return new Response(`OK - ${buf.byteLength}`);
    },
  });
  uploadsBase = `http://127.0.0.1:${uploadHost.port}`;
  // A host that reads part of the body and cuts the connection.
  dropServer = createServer((sock) => {
    let got = 0;
    sock.on("data", (c) => { got += c.length; if (got > 70_000) sock.destroy(); });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => dropServer.listen(0, "127.0.0.1", r));
  dropBase = `http://127.0.0.1:${(dropServer.address() as any).port}`;

  handle = createGateway(new AgentManager(), recordingTransport());
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      gatewayHits.push(path);
      // A gateway that predates the tools, or has no upload capability.
      if (path.endsWith("/surface/upload_begin") && blockBegin === "old-gateway") return Response.json({ error: "unknown tool 'surface/upload_begin'" }, { status: 404 });
      if (path.endsWith("/surface/upload_begin") && blockBegin === "no-capability") return Response.json({ error: "tool 'surface/upload_begin' is not mounted in this deployment" }, { status: 404 });
      return (await handle.fetchV1(req)) ?? new Response("nf", { status: 404 });
    },
  });
  nodeClient = new NodeClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: NODE_TOKEN, baseDelayMs: 1 });
});

afterAll(() => {
  server?.stop(true);
  uploadHost?.stop(true);
  dropServer?.close();
  setOutboundApprover(undefined);
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_JOB_SECRET;
  delete process.env.SLAUDE_UPLOAD_ALLOWED_HOSTS;
  delete process.env.SLAUDE_BRAIN_DISABLED;
  delete process.env.SLAUDE_UPLOAD_MAX_BYTES;
});

let logs: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];
beforeEach(() => {
  mode = "ok"; apiCalls.length = 0; received.length = 0; gatewayHits = []; onBegin = undefined; blockBegin = "none";
  delete process.env.SLAUDE_UPLOAD_MAX_BYTES;
  __setUploadLimiter(localUploadLimiter());
  __resetUploadFallbackLogs();
  logs = [];
  for (const m of ["log", "warn", "error", "info", "debug"] as const) {
    spies.push(spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
  }
});
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); __setUploadLimiter(undefined); });

function shims(over: Partial<ShimDeps> & { token?: () => string } = {}) {
  const { token, ...rest } = over;
  const deps: ShimDeps = {
    client: nodeClient,
    tokenFor: token ?? (() => tokenWith()),
    workingDirFor: async () => work,
    scratchDirFor: () => scratch,
    ...rest,
  } as ShimDeps;
  return buildShimServers(SESSION, deps);
}

async function callTool(cfg: McpSdkServerConfigWithInstance, toolName: string, args: Record<string, unknown>): Promise<any> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(serverT);
  const client = new Client({ name: "upl", version: "0.0.0" });
  await client.connect(clientT);
  try { return await client.callTool({ name: toolName, arguments: args }); } finally { await client.close(); }
}
const upload = (args: Record<string, unknown>, over: Parameters<typeof shims>[0] = {}) => callTool(shims(over).slaude_surface as any, "upload", args);
const text = (r: any) => r.content[0].text as string;
const begins = () => apiCalls.filter((c) => c.name === "getUploadURLExternal");
const completes = () => apiCalls.filter((c) => c.name === "completeUploadExternal");

function bytesOf(n: number): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

/** No Slack URL or handle in a result or a log line. */
function expectNoSecrets(results: string[]) {
  const all = [...results, ...logs].join("\n");
  expect(all).not.toContain("UPLOADURLSECRET");
  expect(all).not.toContain("/upload/F");
  expect(all).not.toMatch(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/); // a handle or job token shape
}

describe("a file made on the node reaches Slack with identical bytes", () => {
  test("from the scratch directory: begin, raw POST with Content-Length, complete, same hash", async () => {
    const data = bytesOf(3_000_001);
    const f = join(scratch, "big.bin");
    writeFileSync(f, data);
    const r = await upload({ path: f, title: "Big", initial_comment: "here **it** is", alt_text: "alt" });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe("uploaded");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ sha: sha(data), n: data.length, contentLength: String(data.length), contentType: "application/octet-stream" });
    expect(begins()[0]!.args).toEqual({ filename: "big.bin", length: data.length, alt_text: "alt" });
    expect(completes()).toHaveLength(1);
    expect(completes()[0]!.args).toMatchObject({ files: [{ id: begins().length ? "F" + seq : "", title: "Big" }], channel_id: "C0TEAM", thread_ts: "600.0" });
    expect(completes()[0]!.args.initial_comment).toContain("here");
    expectNoSecrets([text(r)]);
  });

  test("from the working directory, in a subfolder, with a unicode name", async () => {
    mkdirSync(join(work, "out"), { recursive: true });
    const f = join(work, "out", "résumé 日本.txt");
    writeFileSync(f, "hello");
    const r = await upload({ path: f });
    expect(text(r)).toBe("uploaded");
    expect(begins()[0]!.args.filename).toBe("résumé 日本.txt");
    expect(received[0]!.sha).toBe(sha(Buffer.from("hello")));
    expect(completes()[0]!.args.files[0].title).toBe("résumé 日本.txt");
  });

  test("a relative path is read from the working directory", async () => {
    writeFileSync(join(work, "rel.txt"), "rel");
    const r = await upload({ path: "rel.txt" });
    expect(text(r)).toBe("uploaded");
    expect(received[0]!.n).toBe(3);
  });

  test("a symlink that stays inside the allowed places uploads", async () => {
    writeFileSync(join(scratch, "real.txt"), "linked");
    symlinkSync(join(scratch, "real.txt"), join(work, "alias.txt"));
    expect(text(await upload({ path: join(work, "alias.txt") }))).toBe("uploaded");
    expect(received[0]!.n).toBe(6);
  });

  test("the tool name the Stop guard counts is the same", () => {
    expect(mustReplyEffect("mcp__slaude_surface__upload")).toBe("spoke");
    const s = shims().slaude_surface as any;
    expect(Object.keys(s.instance._registeredTools)).toContain("upload");
  });
});

describe("what the node refuses before anything leaves it", () => {
  test("a missing file", async () => {
    const r = await upload({ path: join(work, "nope.txt") });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(`file not found on this node: ${join(work, "nope.txt")}`);
    expect(apiCalls).toHaveLength(0);
    expect(gatewayHits.filter((p) => p.includes("upload"))).toHaveLength(0);
  });

  test("a symlink out of the allowed places, a file elsewhere and a traversal, naming the allowed places and the base name only", async () => {
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(work, "escape.txt"));
    for (const [p, name] of [[join(work, "escape.txt"), "escape.txt"], [join(outside, "secret.txt"), "secret.txt"], [join(work, "..", "outside", "secret.txt"), "secret.txt"], ["/etc/hosts", "hosts"]] as const) {
      const r = await upload({ path: p });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(`upload refused: ${name} is not a regular file under this session's working directory or scratch directory`);
      expect(text(r)).toContain("Copy the file into one of them");
      expect(text(r)).not.toContain(outside);
    }
    expect(apiCalls).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  test("the rest of the temp area is not an allowed place", async () => {
    const stray = join(tmpdir(), `slaude-stray-${process.pid}.txt`);
    writeFileSync(stray, "x");
    const r = await upload({ path: stray });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("upload refused");
    expect(apiCalls).toHaveLength(0);
  });

  test("a path that does not exist outside the allowed places is refused like one that does, so refusals do not reveal what exists", async () => {
    const a = await upload({ path: "/etc/hosts" });
    const b = await upload({ path: "/etc/slaude-no-such-file-zz/hosts" });
    const c = await upload({ path: join(outside, "no-such-zz.txt") });
    for (const r of [a, b, c]) expect(text(r)).toContain("not a regular file under this session's working directory or scratch directory");
    expect(text(b)).not.toContain("not found");
    expect(text(upload === undefined ? a : await upload({ path: join(work, "missing-zz.txt") }))).toContain("file not found on this node");
  });

  test("an over-long title or alt text is refused before any byte is sent", async () => {
    writeFileSync(join(scratch, "long.txt"), "x");
    for (const extra of [{ title: "t".repeat(1025) }, { alt_text: "a".repeat(4001) }]) {
      const r = await upload({ path: join(scratch, "long.txt"), ...extra });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/title|alt text/);
    }
    expect(apiCalls).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  test("a directory and an empty file", async () => {
    mkdirSync(join(work, "adir"), { recursive: true });
    writeFileSync(join(work, "empty.txt"), "");
    for (const p of [join(work, "adir"), join(work, "empty.txt")]) {
      const r = await upload({ path: p });
      expect(r.isError).toBe(true);
    }
    expect(text(await upload({ path: join(work, "empty.txt") }))).toContain("empty");
    expect(apiCalls).toHaveLength(0);
  });

  test("a remote-environment turn is refused before any stat", async () => {
    const remote = { addr: "10.0.0.1", dir: "/home/u" } as any;
    const r = await upload({ path: join(work, "never-statted-because-remote.txt") }, { token: () => tokenWith({ remote }) });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("remote environment");
    expect(text(r)).toContain("on the user's machine");
    expect(text(r)).not.toContain("file not found");
    expect(apiCalls).toHaveLength(0);
    expect(gatewayHits.filter((p) => p.includes("upload"))).toHaveLength(0);
  });

  test("an oversize file is refused at begin and nothing is sent", async () => {
    process.env.SLAUDE_UPLOAD_MAX_BYTES = "100";
    writeFileSync(join(work, "big2.bin"), bytesOf(200));
    const r = await upload({ path: join(work, "big2.bin") });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("200 bytes");
    expect(text(r)).toContain("100 bytes");
    expect(received).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);
  });

  test("voice-quiet behavior is unchanged: a voice turn drops the upload locally", async () => {
    writeFileSync(join(work, "v.txt"), "v");
    const r = await upload({ path: join(work, "v.txt") }, { voiceActive: () => true });
    expect(r).toEqual(expect.objectContaining({ content: VOICE_SUPPRESSED_RESULT.content }));
    expect(gatewayHits).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);
  });
});

describe("what the bytes can and cannot do after the file is open", () => {
  test("a file replaced after it was opened cannot change what is sent", async () => {
    const original = bytesOf(5000);
    const f = join(scratch, "swap.bin");
    writeFileSync(f, original);
    // Begin runs after the open: replace the path with different content right then.
    onBegin = () => { writeFileSync(f + ".new", Buffer.alloc(5000, 9)); renameSync(f + ".new", f); };
    const r = await upload({ path: f });
    expect(text(r)).toBe("uploaded");
    expect(received[0]!.sha).toBe(sha(original));
  });

  test("a file that grows after it was opened sends only the declared size", async () => {
    const original = bytesOf(5000);
    const f = join(scratch, "grow.bin");
    writeFileSync(f, original);
    onBegin = () => appendFileSync(f, "MORE");
    const r = await upload({ path: f });
    expect(text(r)).toBe("uploaded");
    expect(received[0]).toMatchObject({ n: 5000, sha: sha(original) });
  });

  test("a file truncated after it was opened fails and complete is not called", async () => {
    const f = join(scratch, "shrink.bin");
    writeFileSync(f, bytesOf(200_000));
    onBegin = () => truncateSync(f, 10);
    const r = await upload({ path: f });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/changed|short|sent/);
    expect(completes()).toHaveLength(0);
    expectNoSecrets([text(r)]);
  });
});

describe("Slack's answer to the transfer is checked before complete", () => {
  const cases: Array<[Mode, RegExp]> = [
    ["http500", /HTTP 500/],
    ["wrong-count", /stored 5001 bytes but 5000/],
    ["junk", /not understood/],
    ["drop", /connection to Slack/],
  ];
  for (const [m, re] of cases) {
    test(`${m}: a clear error, complete is not called, no URL or handle shown or logged`, async () => {
      mode = m;
      const f = join(scratch, `fail-${m}.bin`);
      writeFileSync(f, bytesOf(m === "drop" ? 4_000_000 : 5000));
      const r = await upload({ path: f });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(re);
      expect(completes()).toHaveLength(0);
      expectNoSecrets([text(r)]);
    });
  }

  test("a redirect from the upload host is not followed", async () => {
    mode = "redirect";
    writeFileSync(join(scratch, "redir.bin"), bytesOf(100));
    const r = await upload({ path: join(scratch, "redir.bin") });
    expect(r.isError).toBe(true);
    expect(completes()).toHaveLength(0);
    expectNoSecrets([text(r)]);
  });

  test("the node checks the upload URL again and sends no byte to a host the gateway should not have named", async () => {
    writeFileSync(join(scratch, "evil.bin"), bytesOf(100));
    const real = nodeClient.postTool.bind(nodeClient);
    const spy = spyOn(nodeClient, "postTool").mockImplementation(async (seg: string, name: string, body: any, tok: string, sig?: AbortSignal) =>
      name === "upload_begin"
        ? { content: [{ type: "text", text: JSON.stringify({ uploadUrl: "http://169.254.169.254/latest", fileId: "F1", handle: "h.h.h" }) }] }
        : real(seg, name, body, tok, sig));
    const fetched: string[] = [];
    try {
      const r = await upload({ path: join(scratch, "evil.bin") }, { uploadFetch: (async (u: any) => { fetched.push(String(u)); return new Response("OK - 100"); }) as any });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("not an expected Slack host");
      expect(text(r)).not.toContain("169.254");
      expect(fetched).toEqual([]);
      expect(completes()).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("Slack's answer is read only up to a few hundred bytes", async () => {
    writeFileSync(join(scratch, "endless.bin"), bytesOf(50));
    const endless = (async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode("x".repeat(65536))); } }), { status: 200 })) as any;
    const t = Date.now();
    const r = await upload({ path: join(scratch, "endless.bin") }, { uploadFetch: endless });
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r.isError).toBe(true);
    expect(completes()).toHaveLength(0);
  });

  test("a failing complete is a clean error that never carries the raw message", async () => {
    writeFileSync(join(scratch, "cfail.bin"), bytesOf(50));
    const real = nodeClient.postTool.bind(nodeClient);
    const spy = spyOn(nodeClient, "postTool").mockImplementation(async (seg: string, name: string, body: any, tok: string, sig?: AbortSignal) => {
      if (name === "upload_complete") throw new Error(`connect ECONNREFUSED handle=${body.handle} url=UPLOADURLSECRET`);
      return real(seg, name, body, tok, sig);
    });
    try {
      const r = await upload({ path: join(scratch, "cfail.bin") });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("could not be completed");
      expect(text(r)).not.toContain("ECONNREFUSED");
      expectNoSecrets([text(r)]);
    } finally {
      spy.mockRestore();
    }
  });

  test("the turn's abort stops the transfer and complete is not called", async () => {
    mode = "slow";
    const f = join(scratch, "abort.bin");
    writeFileSync(f, bytesOf(5000));
    const ac = new AbortController();
    const p = upload({ path: f }, { signalFor: () => ac.signal });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("stopped");
    expect(completes()).toHaveLength(0);
  });

  test("upload has no time limit of its own (a slow host still completes)", async () => {
    mode = "slow";
    writeFileSync(join(scratch, "slow.bin"), bytesOf(10));
    expect(text(await upload({ path: join(scratch, "slow.bin") }))).toBe("uploaded");
  });
});

describe("the handle and the tokens", () => {
  test("a begin shortly before the job token expires still completes with the refreshed token", async () => {
    writeFileSync(join(scratch, "tok.txt"), "tok");
    const now = Math.floor(Date.now() / 1000);
    const tokens = [tokenWith({ exp: now + 5 }), tokenWith({ exp: now + 900, iat0: now })];
    let i = 0;
    // tokenFor is read at the start, at begin and at complete: the refreshed token arrives for the last.
    const r = await upload({ path: join(scratch, "tok.txt") }, { token: () => tokens[Math.min(i++, 1)]! });
    expect(text(r)).toBe("uploaded");
    expect(completes()).toHaveLength(1);
  });

  test("a channel-session root turn is honored: complete posts at the channel root", async () => {
    writeFileSync(join(scratch, "root.txt"), "root");
    const r = await upload({ path: join(scratch, "root.txt") }, { token: () => tokenWith({ thread: "7.7", post: "channel" }) });
    expect(text(r)).toBe("uploaded");
    expect(completes()[0]!.args.channel_id).toBe("C0TEAM");
    expect(completes()[0]!.args).not.toHaveProperty("thread_ts");
  });

  test("a wake turn cannot begin an upload", async () => {
    writeFileSync(join(scratch, "wake.txt"), "w");
    const r = await upload({ path: join(scratch, "wake.txt") }, { token: () => tokenWith({ wake: true, bgRun: "run1" }) });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not available when you woke");
    expect(apiCalls).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  test("upload_begin and upload_complete are not visible to the model on a node session", async () => {
    const s = shims().slaude_surface as any;
    const names = Object.keys(s.instance._registeredTools);
    expect(names).toContain("upload");
    expect(names).not.toContain("upload_begin");
    expect(names).not.toContain("upload_complete");
  });
});

describe("an older gateway", () => {
  for (const kind of ["old-gateway", "no-capability"] as const) {
    test(`${kind}: begin is unavailable, the node falls back to the path call once and logs once`, async () => {
      blockBegin = kind;
      writeFileSync(join(work, "fb.txt"), "fb");
      const calls: string[] = [];
      const real = nodeClient.postTool.bind(nodeClient);
      const spy = spyOn(nodeClient, "postTool").mockImplementation(async (seg: string, name: string, body: any, tok: string, sig?: AbortSignal) => {
        calls.push(`${seg}/${name}`);
        if (name === "upload") return { content: [{ type: "text", text: "uploaded" }] };
        return real(seg, name, body, tok, sig);
      });
      try {
        const r1 = await upload({ path: join(work, "fb.txt") });
        const r2 = await upload({ path: join(work, "fb.txt") });
        expect(text(r1)).toBe("uploaded");
        expect(text(r2)).toBe("uploaded");
        expect(calls.filter((c) => c === "surface/upload")).toHaveLength(2);
        expect(received).toHaveLength(0);
        expect(logs.filter((l) => l.includes("[node] upload") && l.includes(kind === "old-gateway" ? "predates" : "no upload capability"))).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });
  }
});

describe("a held caption at complete", () => {
  const RULES = [
    "---\nname: replies\n---\n```rules",
    "- id: prices\n  on: reply\n  match: { text: '(?i)price is \\$\\d+' }\n  action: approve\n  message: Prices need an approver.",
    "```",
  ].join("\n");
  let approve = true;
  const asked: any[] = [];

  beforeAll(async () => {
    await __clearGuardrailsForTests();
    __resetGuardrailSnapshotsForTests();
    await applyGuardrailChange("default", { upsert: [{ slug: "replies", md: RULES, source: "file" }], by: "t" });
    await refreshGuardrails("default");
  });
  afterAll(async () => { await __clearGuardrailsForTests(); __resetGuardrailSnapshotsForTests(); });
  beforeEach(() => {
    asked.length = 0;
    __resetHeldDecisionsForTests();
    setOutboundApprover({ approvers: async () => ["UAPPROVER"], ask: async (r) => { asked.push(r); await Bun.sleep(50); return { approved: approve, by: "UAPPROVER" }; } });
  });

  test("approved: the bytes are already at Slack, the caption is held, then the file completes once", async () => {
    approve = true;
    writeFileSync(join(scratch, "held.txt"), "held");
    const r = await upload({ path: join(scratch, "held.txt"), initial_comment: "The price is $40" });
    expect(text(r)).toBe("uploaded");
    expect(asked).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(completes()).toHaveLength(1);
  });

  test("denied: the agent hears why and Slack's upload is never completed", async () => {
    approve = false;
    writeFileSync(join(scratch, "held2.txt"), "held");
    const r = await upload({ path: join(scratch, "held2.txt"), initial_comment: "The price is $40" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Not posted");
    expect(completes()).toHaveLength(0);
    expect(received).toHaveLength(1);
  });
});
