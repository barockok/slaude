/**
 * POST /v1/tools/mcpx/<server>/list|call through the real /v1 router: node
 * bearer + job token + the label gate, context from the verified claims only,
 * a server the token's persona does not mount is a 404 that does not reveal
 * whether it exists elsewhere, and the request size cap.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createV1Api, v1Routes } from "../../../src/gateway/api";
import { __setNodeVerifier, JOB_HEADER, mintJobToken, type JobClaims } from "../../../src/gateway/api/auth";
import { mintNodeCredential, NodeCredentialVerifier } from "../../../src/gateway/auth/node-credential";
import { InMemoryPendingSource } from "../../../src/gateway/api/pending-source";
import { createMcpBridge, NOT_MOUNTED } from "../../../src/gateway/core/mcp-bridge";
import type { ExternalMcp } from "../../../src/gateway/core/external-mcp";
import { TOOLS, startUpstream } from "./upstream";

const up = startUpstream();
const VARS = ["SLAUDE_NODE_KEY", "SLAUDE_NODE_TOKEN", "SLAUDE_JOB_SECRET", "SLAUDE_NODE_LEGACY_TOKEN", "SLAUDE_NODE_LEGACY"];
const saved: Record<string, string | undefined> = {};

// Persona "ana" mounts `example`; persona "bo" mounts `other` only.
const bridge = createMcpBridge({
  servers: (c): ExternalMcp =>
    c.persona === "ana"
      ? { servers: { example: { type: "http", url: up.url } as never, stdio: { command: "x" } as never }, privateServices: [] }
      : { servers: { other: { type: "http", url: up.url } as never }, privateServices: [] },
  accountFor: async () => null,
  credentialsFor: async () => ({}),
  policy: { allowLoopback: true, allowedHosts: [], internalHosts: [] },
  limits: () => ({ timeoutMs: 5000, ownerConcurrency: 4, maxRequestBytes: 2048, maxResultBytes: 1 << 20 }),
});

let v1: ReturnType<typeof createV1Api>;
beforeAll(() => {
  for (const k of VARS) saved[k] = process.env[k];
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_NODE_LEGACY;
  delete process.env.SLAUDE_NODE_LEGACY_TOKEN;
  process.env.SLAUDE_NODE_KEY = "mcpx-node-key";
  process.env.SLAUDE_JOB_SECRET = "mcpx-job-secret";
  __setNodeVerifier(new NodeCredentialVerifier({ revocations: async () => null }));
  v1 = createV1Api({ tools: { mcpBridge: bridge } as never, pendingSource: new InMemoryPendingSource() });
});
afterAll(async () => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __setNodeVerifier(null);
  await bridge.close();
  up.stop();
});

const cred = (labels: string[]) => mintNodeCredential({ id: "mcpx-node", labels }, { key: "mcpx-node-key" });
const token = (c: Partial<JobClaims> = {}) =>
  mintJobToken({
    tenant: "default", persona: "ana", session: "S1", team: "T1", channel: "C1", thread: "1.0",
    initiator: "U1", scope: "turn", runAs: "agent", label: "finance", ...c,
  } as Omit<JobClaims, "exp" | "iat">);

async function post(path: string, body: string, o: { labels?: string[]; job?: string } = {}) {
  const res = (await v1.fetch(
    new Request(`http://gw${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cred(o.labels ?? ["finance"])}`, [JOB_HEADER]: o.job ?? token(), "content-type": "application/json" },
      body,
    }),
  ))!;
  return { status: res.status, body: (await res.json()) as any };
}

describe("the mcpx routes", () => {
  test("are in the route table, label-gated, behind node+job", () => {
    const r = v1Routes({ tools: {} as never }, new InMemoryPendingSource()).find((x) => x.name === "tools.mcpx")!;
    expect(r).toMatchObject({ methods: ["POST"], auth: "node+job", gate: "label" });
  });

  test("list relays the upstream's definitions", async () => {
    const r = await post("/v1/tools/mcpx/example/list", "{}");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body.tools)).toBe(JSON.stringify(TOOLS));
  });

  test("call relays the result", async () => {
    const r = await post("/v1/tools/mcpx/example/call", JSON.stringify({ name: "echo", arguments: { text: "hi" } }));
    expect(r).toEqual({ status: 200, body: { content: [{ type: "text", text: "hi" }] } });
  });

  test("a node without the persona's label is refused by the gate", async () => {
    const r = await post("/v1/tools/mcpx/example/list", "{}", { labels: ["engineering"] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("GATE_DENIED");
  });

  test("a server the token's persona does not mount is 404, identical to an unknown or non-http one", async () => {
    const asBo = { job: token({ persona: "bo" }) };
    const seen = up.paths.length;
    for (const [path, o] of [
      ["/v1/tools/mcpx/example/list", asBo],
      ["/v1/tools/mcpx/nope/call", {}],
      ["/v1/tools/mcpx/stdio/list", {}],
      ["/v1/tools/mcpx/%E0%A4%A/list", {}],
      ["/v1/tools/mcpx/constructor/call", {}],
      ["/v1/tools/mcpx/toString/list", {}],
      ["/v1/tools/mcpx/__proto__/list", {}],
      ["/v1/tools/mcpx/hasOwnProperty/call", {}],
    ] as const) {
      const r = await post(path, JSON.stringify({ name: "echo" }), o);
      expect({ path, ...r }).toEqual({ path, status: 404, body: { error: NOT_MOUNTED } });
    }
    expect(up.paths.length).toBe(seen);
  });

  test("context comes from the claims, never the body", async () => {
    const r = await post(
      "/v1/tools/mcpx/example/call",
      JSON.stringify({ name: "whoami", arguments: {}, persona: "bo", runAs: "user:UX", tenant: "t9" }),
    );
    expect(r.status).toBe(200);
    // A token with no runAs is refused, whatever the body says.
    const noRunAs = await post("/v1/tools/mcpx/example/call", JSON.stringify({ name: "echo", runAs: "agent" }), { job: token({ runAs: undefined }) });
    expect(noRunAs.status).toBe(403);
  });

  test("malformed bodies are 400 and an oversize body 413", async () => {
    expect((await post("/v1/tools/mcpx/example/call", "{nope")).status).toBe(400);
    expect((await post("/v1/tools/mcpx/example/call", "[]")).status).toBe(400);
    expect((await post("/v1/tools/mcpx/example/call", JSON.stringify({ arguments: {} }))).status).toBe(400);
    expect((await post("/v1/tools/mcpx/example/call", JSON.stringify({ name: "echo", arguments: [1] }))).status).toBe(400);
    expect((await post("/v1/tools/mcpx/example/call", JSON.stringify({ name: "echo", arguments: { text: "x".repeat(5000) } }))).status).toBe(413);
  });

  test("without a bridge (a deployment that has none) the routes answer 404", async () => {
    const bare = createV1Api({ tools: {} as never, pendingSource: new InMemoryPendingSource() });
    const res = (await bare.fetch(
      new Request("http://gw/v1/tools/mcpx/example/list", {
        method: "POST",
        headers: { authorization: `Bearer ${cred(["finance"])}`, [JOB_HEADER]: token() },
        body: "{}",
      }),
    ))!;
    expect(res.status).toBe(404);
  });
});
