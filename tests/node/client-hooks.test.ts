/**
 * NodeClient refusal observers (node labels spec §4.6): a label-gate 403 is
 * reported with the job token it was made under (the worker flags that
 * session), and a 401 for the node's own credential is reported so the worker
 * pauses — but a job-token 401 is not a node-credential problem.
 */
import { describe, expect, test } from "bun:test";
import { GateDenied, isNodeUnauthorized, NodeClient } from "../../src/node/client";

const respond = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(fetchImpl: () => Promise<Response>) {
  const seen = { gate: [] as Array<string | undefined>, unauthorized: 0 };
  const c = new NodeClient({ baseUrl: "http://gw", token: "t", attempts: 1, fetchImpl: fetchImpl as unknown as typeof fetch });
  c.setHooks({ onGateDenied: (tok) => seen.gate.push(tok), onNodeUnauthorized: () => seen.unauthorized++ });
  return { c, seen };
}

describe("NodeClient refusal hooks", () => {
  test("a gate 403 reports the job token and still throws GateDenied", async () => {
    const { c, seen } = client(respond(403, { error: "this node may not serve this agent", code: "GATE_DENIED" }));
    const e = await c.postTool("surface", "reply", {}, "job-tok-1").catch((x) => x);
    expect(e).toBeInstanceOf(GateDenied);
    expect(seen.gate).toEqual(["job-tok-1"]);
    expect(seen.unauthorized).toBe(0);
  });

  test("another 403 is not the gate", async () => {
    const { c, seen } = client(respond(403, { error: "job token is not scoped to this tenant" }));
    await c.getSession("S", "job-tok").catch(() => {});
    expect(seen.gate).toEqual([]);
  });

  test("a node-credential 401 (typed, or an older gateway's text) is reported; a job-token 401 is not", async () => {
    const typed = client(respond(401, { error: "invalid or missing bearer token", code: "NODE_UNAUTHORIZED" }));
    await typed.c.getSession("S", "job-tok").catch(() => {});
    expect(typed.seen.unauthorized).toBe(1);
    const old = client(respond(401, { error: "invalid or missing bearer token" }));
    await old.c.whoami().catch(() => {});
    expect(old.seen.unauthorized).toBe(1);
    const job = client(respond(401, { error: "invalid job token: expired" }));
    await job.c.getSession("S", "job-tok").catch(() => {});
    expect(job.seen.unauthorized).toBe(0);
  });

  test("isNodeUnauthorized needs a 401", () => {
    expect(isNodeUnauthorized(403, JSON.stringify({ code: "NODE_UNAUTHORIZED" }))).toBe(false);
    expect(isNodeUnauthorized(401, "not json")).toBe(false);
  });
});
