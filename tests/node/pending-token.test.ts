/**
 * Pending polls carry the turn's job token (node labels and routing spec
 * §4.4): a signed node polling without one gets 401 forever. Each leg reads
 * the live token, so a refreshed token is used on the NEXT poll. A refusal
 * (any 4xx, including a gate 403) stops the poll instead of retrying it every
 * second until the turn is aborted.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { GateDenied, NodeApiError, NodeClient } from "../../src/node/client";
import { pollPending } from "../../src/node/pending";
import { buildShimServers } from "../../src/node/shims";
import { makeNodePermissionResolver } from "../../src/node/shims/permission";
import { surfaceContract } from "../../src/tools/contracts/surface";
import { GATE_DENIED_CODE, JOB_HEADER } from "../../src/gateway/api/auth";

type Leg = Response | (() => Response);

/** Most pending polls any test here needs; more means the loop did not stop. */
const MAX_POLLS = 4;
/** Per-test bound (ms): the shims retry a failed poll after 1 s. */
const BOUND_MS = 10_000;

/** A NodeClient over a stub gateway: records the job token of every pending
 *  poll and lets the test switch the session's live token between legs. */
function stubGateway(opts: { openText: string; pendingLegs: Leg[]; onPoll?: (n: number) => void }) {
  const pendingTokens: (string | null)[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const req = new Request(url, init);
    const path = new URL(req.url).pathname;
    if (path.startsWith("/v1/tools/")) {
      return Response.json({ content: [{ type: "text", text: opts.openText }] });
    }
    if (path.startsWith("/v1/pending/")) {
      pendingTokens.push(req.headers.get(JOB_HEADER));
      // Bound: a poll loop that should have stopped is ended here, so the test
      // fails on its poll count instead of hanging.
      if (pendingTokens.length > MAX_POLLS) return Response.json({ status: "expired", payload: {}, resolvedBy: null });
      opts.onPoll?.(pendingTokens.length);
      const leg = opts.pendingLegs.shift() ?? new Response(null, { status: 204 });
      return typeof leg === "function" ? leg() : leg;
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { client: new NodeClient({ baseUrl: "http://gw", token: "node-cred", fetchImpl, attempts: 1 }), pendingTokens };
}

const timeout = () => new Response(null, { status: 204 });
const settled = (status = "approved") => Response.json({ status, payload: {}, resolvedBy: "U1" });

describe("pollPending", () => {
  test("sends the job token on every leg, read fresh each time", async () => {
    let live = "tok-A";
    const { client, pendingTokens } = stubGateway({
      openText: "",
      pendingLegs: [timeout(), timeout(), settled()],
      onPoll: (n) => {
        if (n === 1) live = "tok-B";
      },
    });
    const out = await pollPending(client, "P1", { jobToken: () => live, retryDelayMs: 1 });
    expect(out).toMatchObject({ status: "approved" });
    expect(pendingTokens).toEqual(["tok-A", "tok-B", "tok-B"]);
  }, BOUND_MS);

  test("a 4xx refusal (gate 403, 401) stops at once; network errors and 5xx are retried", async () => {
    const gate = () => new Response(JSON.stringify({ error: "x", code: GATE_DENIED_CODE }), { status: 403 });
    for (const [leg, kind] of [
      [gate, GateDenied],
      [() => new Response("{}", { status: 401 }), NodeApiError],
    ] as const) {
      const { client, pendingTokens } = stubGateway({ openText: "", pendingLegs: [leg, settled()] });
      const out = await pollPending(client, "P1", { jobToken: () => "t", retryDelayMs: 1 });
      expect(typeof out === "object" && "refused" in out && out.refused).toBeInstanceOf(kind);
      expect(pendingTokens).toHaveLength(1);
    }
    const { client, pendingTokens } = stubGateway({
      openText: "",
      pendingLegs: [() => new Response("down", { status: 503 }), settled()],
    });
    expect(await pollPending(client, "P1", { jobToken: () => "t", retryDelayMs: 1 })).toMatchObject({ status: "approved" });
    expect(pendingTokens).toHaveLength(2);
  }, BOUND_MS);
});

async function callShim(cfg: any, toolName: string, args: Record<string, unknown>): Promise<any> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(serverT);
  const client = new Client({ name: "pending-token", version: "0.0.0" });
  await client.connect(clientT);
  try {
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    await client.close();
  }
}

describe("shims send the live job token on pending polls", () => {
  test("request_approval: token on every poll; a refreshed token on the next one", async () => {
    let live = "tok-A";
    const { client, pendingTokens } = stubGateway({
      openText: JSON.stringify({ pendingId: "P-appr" }),
      pendingLegs: [timeout(), settled()],
      onPoll: (n) => {
        if (n === 1) live = "tok-B";
      },
    });
    const shims = buildShimServers("S1", { client, tokenFor: () => live });
    const res = await callShim(shims[surfaceContract.server], surfaceContract.tools.request_approval.name, { summary: "plan" });
    expect(res.content[0].text).toBe("approved by <@U1>");
    expect(pendingTokens).toEqual(["tok-A", "tok-B"]);
  }, BOUND_MS);

  test("request_approval: a refused poll ends the call with an error, not a retry loop", async () => {
    const { client, pendingTokens } = stubGateway({
      openText: JSON.stringify({ pendingId: "P-appr" }),
      pendingLegs: [() => new Response("{}", { status: 401 })],
    });
    const shims = buildShimServers("S1", { client, tokenFor: () => "tok" });
    const res = await callShim(shims[surfaceContract.server], surfaceContract.tools.request_approval.name, { summary: "plan" });
    expect(res.isError).toBe(true);
    expect(pendingTokens).toHaveLength(1);
  }, BOUND_MS);

  test("permission resolver: token on every poll; a refreshed token on the next one; a refusal denies", async () => {
    let live = "tok-A";
    const { client, pendingTokens } = stubGateway({
      openText: JSON.stringify({ pendingId: "P-perm" }),
      pendingLegs: [timeout(), settled("denied")],
      onPoll: (n) => {
        if (n === 1) live = "tok-B";
      },
    });
    const resolver = makeNodePermissionResolver({ client, tokenFor: () => live });
    const ctx = { toolUseID: "tu1", signal: new AbortController().signal, suggestions: undefined, decisionReason: undefined } as any;
    const d: any = await resolver("S1", "Bash", { command: "ls" }, ctx);
    expect(d.behavior).toBe("deny");
    expect(pendingTokens).toEqual(["tok-A", "tok-B"]);

    const refused = stubGateway({ openText: JSON.stringify({ pendingId: "P-perm" }), pendingLegs: [() => new Response("{}", { status: 403 })] });
    const d2: any = await makeNodePermissionResolver({ client: refused.client, tokenFor: () => "t" })("S1", "Bash", { command: "ls" }, ctx);
    expect(d2.behavior).toBe("deny");
    expect(refused.pendingTokens).toHaveLength(1);
  }, BOUND_MS);
});
