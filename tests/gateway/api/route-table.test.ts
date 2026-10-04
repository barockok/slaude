/**
 * The /v1 route table (node labels and routing spec §4.3, §6):
 *
 *   - every route carries a gate decision, and `none` carries a reason;
 *   - the decisions are the audited ones (flipping a route to `none` fails);
 *   - the gate matrix, over EVERY label-gated route: a node with the job's
 *     label passes, one without gets 403, a legacy node passes only for
 *     `default`, and a job token with no `label` is `default`;
 *   - the table routes exactly as the old if-chain did, for every existing
 *     route and the 404/405 cases around them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createV1Api, matchRoute, v1Routes, type RouteDef } from "../../../src/gateway/api";
import {
  __setNodeVerifier,
  GATE_DENIED_CODE,
  JOB_HEADER,
  mintJobToken,
  type JobClaims,
} from "../../../src/gateway/api/auth";
import { mintNodeCredential, NodeCredentialVerifier } from "../../../src/gateway/auth/node-credential";
import { InMemoryPendingSource } from "../../../src/gateway/api/pending-source";

const stubTools = {
  slackCtx: () => { throw new Error("unused"); },
  surfaceFor: () => { throw new Error("unused"); },
  surfaceOpts: () => { throw new Error("unused"); },
  connect: async () => "unused",
  brainDeps: () => undefined,
} as any;

/** The audited gate decision per route. A change here is a security decision. */
const EXPECTED_GATES: Record<string, "label" | "none"> = {
  "node.whoami": "none",
  sessions: "label",
  "tenants.runtime": "label",
  "tenants.mcp-credentials": "label",
  "tenants.remote-key": "label",
  "tenants.mcp-credentials.refresh": "label",
  "tenants.personas.runtime": "label",
  pending: "label",
  "jobs.event": "none",
  "jobs.token-refresh": "label",
  "jobs.token-reissue": "label",
  "tools.memory": "label",
  tools: "label",
  "tools.mcpx": "label",
};

/** One concrete request per label-gated route, scoped to the matrix's token. */
const SAMPLES: Record<string, { method: string; path: string; body?: string }> = {
  sessions: { method: "GET", path: "/v1/sessions/S-matrix" },
  "tenants.runtime": { method: "GET", path: "/v1/tenants/default/runtime" },
  "tenants.mcp-credentials": { method: "GET", path: "/v1/tenants/default/mcp-credentials" },
  "tenants.remote-key": { method: "GET", path: "/v1/tenants/default/remote-key" },
  "tenants.mcp-credentials.refresh": { method: "POST", path: "/v1/tenants/default/mcp-credentials/refresh", body: "{}" },
  "tenants.personas.runtime": { method: "GET", path: "/v1/tenants/default/personas/default/runtime" },
  pending: { method: "GET", path: "/v1/pending/P-matrix" },
  "jobs.token-refresh": { method: "POST", path: "/v1/jobs/J-matrix/token-refresh" },
  "jobs.token-reissue": { method: "POST", path: "/v1/jobs/J-matrix/token-reissue", body: "{}" },
  "tools.memory": { method: "POST", path: "/v1/tools/memory/prefetch", body: "{}" },
  tools: { method: "POST", path: "/v1/tools/kb/search_kbs", body: JSON.stringify({ query: "x" }) },
  "tools.mcpx": { method: "POST", path: "/v1/tools/mcpx/example/list", body: "{}" },
};

const routes: RouteDef[] = v1Routes({ tools: stubTools }, new InMemoryPendingSource());

describe("route table", () => {
  test("every route has a gate decision; `none` has a written reason", () => {
    for (const r of routes) {
      expect({ route: r.name, gate: r.gate }).toEqual({ route: r.name, gate: expect.stringMatching(/^(label|none)$/) });
      if (r.gate === "none") expect({ route: r.name, reason: (r.reason ?? "").trim().length > 10 }).toEqual({ route: r.name, reason: true });
      expect(["node", "node+job"]).toContain(r.auth);
      // A label gate needs a job token to read the label from.
      if (r.gate === "label") expect({ route: r.name, auth: r.auth }).toEqual({ route: r.name, auth: "node+job" });
    }
  });

  test("the gate decisions are the audited ones, and every route is listed", () => {
    expect(Object.fromEntries(routes.map((r) => [r.name, r.gate]))).toEqual(EXPECTED_GATES);
  });

  test("the gate matrix covers every label-gated route", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(routes.filter((r) => r.gate === "label").map((r) => r.name).sort());
  });
});

describe("gate matrix", () => {
  const VARS = ["SLAUDE_NODE_KEY", "SLAUDE_NODE_LEGACY_TOKEN", "SLAUDE_NODE_TOKEN", "SLAUDE_JOB_SECRET", "SLAUDE_NODE_LEGACY"];
  const saved: Record<string, string | undefined> = {};
  let v1: ReturnType<typeof createV1Api>;
  const origErr = console.error;
  const origWarn = console.warn;
  beforeAll(() => {
    for (const k of VARS) saved[k] = process.env[k];
    delete process.env.SLAUDE_NODE_TOKEN;
    delete process.env.SLAUDE_NODE_LEGACY;
    process.env.SLAUDE_NODE_KEY = "matrix-node-key";
    process.env.SLAUDE_NODE_LEGACY_TOKEN = "matrix-legacy";
    process.env.SLAUDE_JOB_SECRET = "matrix-job-secret";
    __setNodeVerifier(new NodeCredentialVerifier({ revocations: async () => null }));
    v1 = createV1Api({ tools: stubTools, pendingSource: new InMemoryPendingSource(), pending: { timeoutMs: 50, pollMs: 10 } });
    // Handlers past the gate may fail on stub deps; their logs are noise here.
    console.error = () => {};
    console.warn = () => {};
  });
  afterAll(() => {
    console.error = origErr;
    console.warn = origWarn;
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __setNodeVerifier(null);
  });

  const cred = (labels: string[]) => mintNodeCredential({ id: "matrix-node", labels }, { key: "matrix-node-key" });
  const token = (label: string | undefined) => {
    const c: Omit<JobClaims, "exp" | "iat"> = {
      tenant: "default", persona: "default", session: "S-matrix", team: "T1", channel: "C1", thread: "1.0",
      initiator: "U1", scope: "turn", job: "J-matrix", runAs: "agent", ...(label ? { label } : {}),
    };
    return mintJobToken(c);
  };

  async function call(route: string, bearer: string, jobToken: string): Promise<{ status: number; gated: boolean }> {
    const s = SAMPLES[route]!;
    const res = (await v1.fetch(
      new Request(`http://gw${s.path}`, {
        method: s.method,
        headers: { authorization: `Bearer ${bearer}`, [JOB_HEADER]: jobToken, ...(s.body ? { "content-type": "application/json" } : {}) },
        ...(s.body ? { body: s.body } : {}),
      }),
    ))!;
    const text = await res.text();
    let code: unknown;
    try { code = JSON.parse(text).code; } catch { /* not json */ }
    return { status: res.status, gated: res.status === 403 && code === GATE_DENIED_CODE };
  }

  for (const route of Object.keys(SAMPLES)) {
    test(`${route}: label passes, missing label 403, legacy only for default, no label = default`, async () => {
      // A node with the job's label passes the gate.
      expect({ route, ...(await call(route, cred(["finance", "eu"]), token("finance"))) }).toMatchObject({ route, gated: false });
      // One without it is refused with the gate's 403.
      expect({ route, ...(await call(route, cred(["engineering"]), token("finance"))) }).toEqual({ route, status: 403, gated: true });
      // The legacy node is `default` only.
      expect({ route, ...(await call(route, "matrix-legacy", token("default"))) }).toMatchObject({ route, gated: false });
      expect({ route, ...(await call(route, "matrix-legacy", token("finance"))) }).toEqual({ route, status: 403, gated: true });
      // A token minted before labels is `default`.
      expect({ route, ...(await call(route, "matrix-legacy", token(undefined))) }).toMatchObject({ route, gated: false });
      expect({ route, ...(await call(route, cred(["default"]), token(undefined))) }).toMatchObject({ route, gated: false });
      expect({ route, ...(await call(route, cred(["engineering"]), token(undefined))) }).toEqual({ route, status: 403, gated: true });
    });
  }
});

describe("routing is behaviour-identical to the old if-chain", () => {
  /** The pre-table router's matching, transcribed from the old index.ts. */
  function oldRoute(method: string, pathname: string): string | 404 | 405 {
    const seg = pathname.split("/").filter(Boolean);
    const only = (...m: string[]) => (name: string) => (m.includes(method) ? name : 405);
    if (seg.length === 3 && seg[1] === "sessions") return only("GET", "PATCH")("sessions");
    if (seg.length === 4 && seg[1] === "tenants" && seg[3] === "runtime") return only("GET")("tenants.runtime");
    if (seg.length === 4 && seg[1] === "tenants" && seg[3] === "mcp-credentials") return only("GET")("tenants.mcp-credentials");
    if (seg.length === 4 && seg[1] === "tenants" && seg[3] === "remote-key") return only("GET")("tenants.remote-key");
    if (seg.length === 5 && seg[1] === "tenants" && seg[3] === "mcp-credentials" && seg[4] === "refresh") {
      return only("POST")("tenants.mcp-credentials.refresh");
    }
    if (seg.length === 6 && seg[1] === "tenants" && seg[3] === "personas" && seg[5] === "runtime") {
      return only("GET")("tenants.personas.runtime");
    }
    if (seg.length === 3 && seg[1] === "pending") return only("GET")("pending");
    if (seg.length === 4 && seg[1] === "jobs" && (seg[3] === "ack" || seg[3] === "fail")) return only("POST")("jobs.event");
    if (seg.length === 4 && seg[1] === "jobs" && seg[3] === "token-refresh") return only("POST")("jobs.token-refresh");
    if (seg.length === 4 && seg[1] === "tools") return only("POST")("tools");
    return 404;
  }

  function newRoute(method: string, pathname: string): string | 404 | 405 {
    const seg = pathname.split("/").filter(Boolean).slice(1);
    const r = routes.find((x) => matchRoute(x, seg));
    if (!r) return 404;
    return r.methods.includes(method) ? r.name : 405;
  }

  const PATHS = [
    "/v1", "/v1/", "/v1/nope", "/v1/a/b/c/d/e/f/g",
    "/v1/sessions", "/v1/sessions/S1", "/v1/sessions/S1/x", "/v1//sessions//S1",
    "/v1/tenants", "/v1/tenants/t", "/v1/tenants/t/runtime", "/v1/tenants/t/mcp-credentials", "/v1/tenants/t/remote-key",
    "/v1/tenants/t/other", "/v1/tenants/t/mcp-credentials/refresh", "/v1/tenants/t/mcp-credentials/other",
    "/v1/tenants/t/runtime/refresh", "/v1/tenants/t/personas/p/runtime", "/v1/tenants/t/personas/p/other",
    "/v1/tenants/t/personas/p", "/v1/tenants/t/other/p/runtime",
    "/v1/pending", "/v1/pending/P1", "/v1/pending/P1/x",
    "/v1/jobs/J1/ack", "/v1/jobs/J1/fail", "/v1/jobs/J1/token-refresh", "/v1/jobs/J1/other", "/v1/jobs/J1", "/v1/jobs/ack/ack",
    "/v1/tools/kb", "/v1/tools/kb/search_kbs", "/v1/tools/kb/search_kbs/x", "/v1/tools/tools/tools",
    "/v1/runtime/x/y", "/v1/sessions/tools",
  ];
  const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];

  test("every existing route, 404 and 405 matches", () => {
    for (const p of PATHS) {
      for (const m of METHODS) {
        expect({ m, p, r: newRoute(m, p) }).toEqual({ m, p, r: oldRoute(m, p) });
      }
    }
  });

  test("the only new paths are whoami and token-reissue", () => {
    expect(oldRoute("GET", "/v1/node/whoami")).toBe(404);
    expect(newRoute("GET", "/v1/node/whoami")).toBe("node.whoami");
    expect(oldRoute("POST", "/v1/jobs/J1/token-reissue")).toBe(404);
    expect(newRoute("POST", "/v1/jobs/J1/token-reissue")).toBe("jobs.token-reissue");
  });

  test("memory narrows the tools pattern for exactly its two operations", () => {
    expect(newRoute("POST", "/v1/tools/memory/prefetch")).toBe("tools.memory");
    expect(newRoute("POST", "/v1/tools/memory/sync")).toBe("tools.memory");
    expect(newRoute("GET", "/v1/tools/memory/sync")).toBe(405);
    // Anything else under tools/memory falls through to the tool plane (404 there).
    expect(newRoute("POST", "/v1/tools/memory/other")).toBe("tools");
  });

  test("the bridge and memory routes do not shadow each other", () => {
    // A bridged server named "memory" is still the bridge (four segments).
    expect(newRoute("POST", "/v1/tools/mcpx/memory/list")).toBe("tools.mcpx");
    expect(newRoute("POST", "/v1/tools/mcpx/memory/call")).toBe("tools.mcpx");
    // A tool named "prefetch" on a server named "mcpx" is not the bridge (three segments).
    expect(newRoute("POST", "/v1/tools/mcpx/prefetch")).toBe("tools");
    expect(newRoute("POST", "/v1/tools/memory/prefetch")).toBe("tools.memory");
  });
});
