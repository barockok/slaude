import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createV1Api } from "../../../src/gateway/api";
import { __setNodeVerifier } from "../../../src/gateway/api/auth";
import { mintNodeCredential, NodeCredentialVerifier } from "../../../src/gateway/auth/node-credential";
import { InMemoryPendingSource } from "../../../src/gateway/api/pending-source";
import { guardHttpServer, PLUGIN_REPORT_MAX_BYTES } from "../../../src/gateway/api/node-plugins";
import { STATE_INVALID_URL, STATE_OFFERABLE, STATE_REFUSED_POLICY, STATE_WRITABLE } from "../../../src/config/plugin-inventory";
import type { NodePluginsRow } from "../../../src/db/node-plugins";

const VARS = ["SLAUDE_NODE_KEY", "SLAUDE_NODE_LEGACY_TOKEN", "SLAUDE_NODE_TOKEN", "SLAUDE_NODE_LEGACY"];
const saved: Record<string, string | undefined> = {};
const policy = { resolver: async () => [{ address: "93.184.216.34", family: 4 }] };

let v1: ReturnType<typeof createV1Api>;
let stored: NodePluginsRow[];
let reported = 0;
let token: string;

const http = (name: string, url: string, state: string) => ({ name, url, state });
const report = (over: Record<string, unknown> = {}) => ({
  plugins: [{ name: "toolkit", marketplace: "market", commit: "abcdef0", skills: 1, commands: 0, agents: 0, hooks: 0, stdio: [{ name: "s1", declared: true }], http: [http("web", "https://x.example.com/mcp", STATE_OFFERABLE)] }],
  ...over,
});
const put = (body: string | object, bearer = token) =>
  v1.fetch(new Request("http://gw/v1/node/plugins", { method: "PUT", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));

beforeAll(() => {
  for (const k of VARS) saved[k] = process.env[k];
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_NODE_LEGACY;
  process.env.SLAUDE_NODE_KEY = "plugins-node-key";
  __setNodeVerifier(new NodeCredentialVerifier({ revocations: async () => null }));
  token = mintNodeCredential({ id: "node-1", labels: ["gpu", "default"] });
  stored = [];
  v1 = createV1Api({
    tools: {} as never,
    pendingSource: new InMemoryPendingSource(),
    memory: null,
    nodePlugins: { store: async (r) => void stored.push(r), onReported: () => { reported++; }, policy },
  });
});

afterAll(() => {
  __setNodeVerifier(null);
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("PUT /v1/node/plugins", () => {
  test("node id and labels come from the credential, never the body", async () => {
    stored = [];
    const res = await put({ ...report(), nodeId: "spoofed", node_id: "spoofed", labels: ["evil"], reportedAt: 1 });
    expect(res!.status).toBe(200);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.nodeId).toBe("node-1");
    expect(stored[0]!.labels).toEqual(["default", "gpu"]);
    expect(JSON.stringify(stored[0]!.report)).not.toContain("spoofed");
    expect(JSON.stringify(stored[0]!.report)).not.toContain("evil");
  });

  test("a stored report recomputes the view", async () => {
    reported = 0;
    await put(report());
    expect(reported).toBe(1);
  });

  test("requires a node credential", async () => {
    const res = await put(report(), "wrong");
    expect(res!.status).toBe(401);
  });

  test("an invalid entry is dropped; the rest of the report still counts", async () => {
    stored = [];
    const res = await put({
      plugins: [
        { name: "good", marketplace: "m", commit: null, skills: 0, commands: 0, agents: 0, hooks: 0, stdio: [{ name: "BAD NAME", declared: true }, { name: "ok", declared: false }], http: [http("web", "https://x.example.com/mcp", "bogus-state"), http("web2", "https://x.example.com/mcp", STATE_OFFERABLE)] },
        { name: "../../etc", marketplace: "m", commit: null, skills: 0, commands: 0, agents: 0, hooks: 0, stdio: [], http: [] },
        "nonsense",
      ],
    });
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ accepted: 1, dropped: 4 });
    expect(stored[0]!.report.plugins.map((p) => p.name)).toEqual(["good"]);
    expect(stored[0]!.report.plugins[0]!.stdio).toEqual([{ name: "ok", declared: false }]);
    expect(stored[0]!.report.plugins[0]!.http.map((h) => h.name)).toEqual(["web2"]);
  });

  test("an oversized report is refused with 413", async () => {
    const res = await put("x".repeat(PLUGIN_REPORT_MAX_BYTES + 1));
    expect(res!.status).toBe(413);
  });

  test("malformed JSON is 400, a non-list is 400", async () => {
    expect((await put("{not json"))!.status).toBe(400);
    expect((await put({ plugins: 3 }))!.status).toBe(400);
  });

  test("a private address is refused an offer, whatever the node claimed", async () => {
    stored = [];
    await put({ plugins: [{ name: "p", marketplace: "m", commit: null, skills: 0, commands: 0, agents: 0, hooks: 0, stdio: [], http: [http("web", "https://10.0.0.5/mcp", STATE_OFFERABLE), http("meta", "https://169.254.169.254/latest", STATE_OFFERABLE)] }] });
    expect(stored[0]!.report.plugins[0]!.http.map((h) => h.state)).toEqual([STATE_REFUSED_POLICY, STATE_REFUSED_POLICY]);
  });
});

describe("guardHttpServer", () => {
  test("re-sanitizes the URL and passes an https public host", async () => {
    const out = await guardHttpServer(http("s", "https://u:p@x.example.com/mcp?t=1#f", STATE_OFFERABLE) as never, policy);
    expect(out).toEqual(http("s", "https://x.example.com/mcp", STATE_OFFERABLE) as never);
  });

  test("a host resolving to a private address is refused", async () => {
    const out = await guardHttpServer(http("s", "https://x.example.com/mcp", STATE_OFFERABLE) as never, { resolver: async () => [{ address: "10.1.2.3", family: 4 }] });
    expect(out.state).toBe(STATE_REFUSED_POLICY);
  });

  test("a non-https url is invalid, even when claimed offerable", async () => {
    expect((await guardHttpServer(http("s", "http://x.example.com/mcp", STATE_OFFERABLE) as never, policy)).state).toBe(STATE_INVALID_URL);
    expect((await guardHttpServer(http("s", "ftp://x.example.com/mcp", STATE_OFFERABLE) as never, policy)).state).toBe(STATE_INVALID_URL);
  });

  test("a state that is not offerable is kept, only the url is re-sanitized", async () => {
    const out = await guardHttpServer(http("s", "https://x.example.com/mcp?t=1", STATE_WRITABLE) as never, policy);
    expect(out).toEqual(http("s", "https://x.example.com/mcp", STATE_WRITABLE) as never);
  });
});
