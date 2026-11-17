/**
 * The upload tool is confined to the session's working directory on both
 * paths that reach SlackSurface.upload: the /v1 tool plane (a node-claimed
 * session, folder read from the gateway's session row) and mono (the surface
 * built over a SlackContext through bindingFor).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SLAUDE_BRAIN_DISABLED = "1";

import { createGateway, bindingFor, type GatewayHandle } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { mintJobToken, JOB_HEADER } from "../../../src/gateway/api/auth";
import { ensureHome } from "../../../src/config/home";
import * as Sessions from "../../../src/db/sessions";
import { SlackSurface } from "../../../src/gateway/slack/surface";
import { surfaceTools } from "../../../src/gateway/core/surface-mcp";

const NODE_TOKEN = "confine-node-token";
const JOB_SECRET = "confine-job-secret";

const sent: any[] = [];

function fakeTransport(): Transport {
  return {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
      files: {
        uploadV2: async (a: any) => {
          if (a.file && typeof a.file.on === "function") for await (const _ of a.file) { /* consume */ }
          sent.push(a);
          return { files: [{ id: "F1" }] };
        },
      },
    } as any,
    action: () => {}, event: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
  };
}

let handle: GatewayHandle;
let server: ReturnType<typeof Bun.serve>;
let base = "";
let root = "";
let work = "";
let outside = "";
let sessionId = "";

beforeAll(async () => {
  process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
  process.env.SLAUDE_JOB_SECRET = JOB_SECRET;
  ensureHome();
  writeSoulFixture(WORLD);
  root = realpathSync(mkdtempSync(join(tmpdir(), "slaude-v1-confine-")));
  work = join(root, "work");
  outside = join(root, "outside");
  mkdirSync(work);
  mkdirSync(outside);
  writeFileSync(join(work, "ok.txt"), "ok");
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(work, "escape.txt"));
  const row = await Sessions.createForThread({
    thread: { team_id: "T1", channel_id: "C0CONF", thread_ts: "400.0", persona_id: "default" },
    model: "m",
    working_dir: work,
  });
  sessionId = row.id;
  handle = createGateway(new AgentManager(), fakeTransport());
  server = Bun.serve({ port: 0, fetch: async (req) => (await handle.fetchV1(req)) ?? new Response("not found", { status: 404 }) });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_JOB_SECRET;
  delete process.env.SLAUDE_BRAIN_DISABLED;
});

async function upload(session: string, path: string) {
  const token = mintJobToken({
    tenant: "default", persona: "default", session, team: "T1", channel: "C0CONF", thread: "400.0",
    initiator: WORLD.manager, scope: "turn",
  });
  const r = await fetch(`${base}/v1/tools/surface/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${NODE_TOKEN}`, [JOB_HEADER]: token },
    body: JSON.stringify({ path }),
  });
  return { status: r.status, body: (await r.json()) as any };
}

describe("v1 tool plane, node-claimed session", () => {
  test("a file in the session folder uploads", async () => {
    sent.length = 0;
    const r = await upload(sessionId, join(work, "ok.txt"));
    expect(r.status).toBe(200);
    expect(r.body.isError).not.toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel_id: "C0CONF", filename: "ok.txt" });
  });

  for (const [label, path, name] of [
    ["a gateway proc file", "/proc/self/environ", "environ"],
    ["a file outside the folder", join(outside, "secret.txt"), "secret.txt"],
    ["dot-dot traversal", join(work, "..", "outside", "secret.txt"), "secret.txt"],
    ["a symlink that leaves the folder", join(work, "escape.txt"), "escape.txt"],
  ] as const) {
    test(`${label} is a tool error, not a 500`, async () => {
      sent.length = 0;
      const r = await upload(sessionId, path);
      expect(r.status).toBe(200);
      expect(r.body.isError).toBe(true);
      expect(r.body.content[0].text).toBe(`upload refused: ${name} is not a regular file under this session's working directory. Copy the file into your working directory and upload it from there.`);
      expect(r.body.content[0].text).not.toContain(root);
      expect(sent).toHaveLength(0);
    });
  }

  test("a session with no row (folder unknown) is refused", async () => {
    sent.length = 0;
    const r = await upload("S-no-such-session", join(work, "ok.txt"));
    expect(r.status).toBe(200);
    expect(r.body.isError).toBe(true);
    expect(r.body.content[0].text).toContain("upload refused: ok.txt");
    expect(sent).toHaveLength(0);
  });
});

describe("mono: the surface built over a SlackContext", () => {
  function monoUpload(sid: string | undefined) {
    const ctx: any = { client: fakeTransport().client, channel: "C0CONF", threadTs: "400.0", inboundTs: "400.0", sessionId: sid };
    const surface = new SlackSurface(ctx.client, bindingFor(ctx));
    return surfaceTools(surface).find((d) => d.name === "upload")!;
  }

  test("bindingFor reads the folder from the session row", async () => {
    const b = bindingFor({ channel: "C", inboundTs: "1", sessionId } as any);
    expect(await b.workingDir!()).toBe(work);
    expect(await bindingFor({ channel: "C", inboundTs: "1" } as any).workingDir!()).toBeUndefined();
  });

  test("a folder file uploads, anything else is refused", async () => {
    sent.length = 0;
    const up = monoUpload(sessionId);
    expect((await up.handler({ path: join(work, "ok.txt") })).content[0]!.text).toBe("uploaded");
    const bad = await up.handler({ path: "/proc/self/environ" });
    expect((bad as any).isError).toBe(true);
    expect(bad.content[0]!.text).toContain("upload refused: environ");
    const esc = await up.handler({ path: join(work, "escape.txt") });
    expect((esc as any).isError).toBe(true);
    expect(sent).toHaveLength(1);
  });

  test("a context with no session id refuses", async () => {
    const bad = await monoUpload(undefined).handler({ path: join(work, "ok.txt") });
    expect((bad as any).isError).toBe(true);
  });
});
