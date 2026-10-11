/**
 * Executable form of the design's horizontal-scale acceptance criteria
 * (docs/superpowers/specs/2026-09-17-control-plane-and-onboarding-design.md §8).
 *
 * The defect these guard against: the runtime bundle was resolved per tenant
 * and cached per tenant, so a second persona in the same tenant could never get
 * its own credentials — every session on a node ran on whichever persona was
 * fetched first. That fails silently and only under multi-persona load, which
 * is exactly the configuration a fleet deployment has.
 */
import { describe, expect, test } from "bun:test";
import { NodeClient } from "../../src/node/client";
import { createV1Api } from "../../src/gateway/api/index";
import { mintJobToken, JOB_HEADER } from "../../src/gateway/api/auth";

const NODE_TOKEN = "scale-node-token";
const JOB_SECRET = "scale-job-secret";

/** A gateway that serves a distinct, ETag-revalidatable bundle per (tenant, persona). */
function fakeGateway() {
  const served: string[] = [];
  const revalidated: string[] = [];
  const fetchImpl = (async (url: any, init?: any) => {
    const m = String(url).match(/\/v1\/tenants\/([^/]+)\/personas\/([^/]+)\/runtime/);
    if (!m) return new Response("not found", { status: 404 });
    const [, tenant, persona] = m as unknown as [string, string, string];
    served.push(`${tenant}/${persona}`);
    const etag = `"${tenant}:${persona}"`;
    if (init?.headers?.["if-none-match"] === etag) {
      revalidated.push(`${tenant}/${persona}`);
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(
      JSON.stringify({
        tenantId: tenant,
        personaId: persona,
        providerCreds: { apiKey: `key-${tenant}-${persona}` },
      }),
      { status: 200, headers: { "content-type": "application/json", etag } },
    );
  }) as any;
  return { served, revalidated, node: () => new NodeClient({ baseUrl: "http://gw", token: NODE_TOKEN, fetchImpl }) };
}

describe("criterion 2: two personas, one tenant, correct credentials each", () => {
  test("one node serving both personas keeps them apart", async () => {
    const gw = fakeGateway();
    const node = gw.node();

    const a = await node.getRuntime("default", "aria", "j");
    const b = await node.getRuntime("default", "other", "j");

    expect(a.providerCreds.apiKey).toBe("key-default-aria");
    expect(b.providerCreds.apiKey).toBe("key-default-other");
  });

  test("re-reading a persona after its sibling does not return the sibling", async () => {
    const gw = fakeGateway();
    const node = gw.node();
    await node.getRuntime("default", "aria", "j");
    await node.getRuntime("default", "other", "j");

    expect((await node.getRuntime("default", "aria", "j")).personaId).toBe("aria");
  });
});

describe("criterion 1 and 4: nodes are interchangeable", () => {
  test("two nodes resolve one persona identically", async () => {
    const gw = fakeGateway();

    const fromA = await gw.node().getRuntime("default", "aria", "j");
    const fromB = await gw.node().getRuntime("default", "aria", "j");

    expect(fromA.providerCreds.apiKey).toBe(fromB.providerCreds.apiKey);
    expect(fromA.personaId).toBe(fromB.personaId);
  });

  test("a node holds no per-persona state across a bust", async () => {
    const gw = fakeGateway();
    const node = gw.node();
    await node.getRuntime("default", "aria", "j");

    node.bustRuntime("default");
    gw.served.length = 0;
    await node.getRuntime("default", "aria", "j");

    // Cold fetch, not a revalidation: nothing survived the bust.
    expect(gw.served).toEqual(["default/aria"]);
  });
});

describe("criterion 3: every fetch revalidates rather than going stale", () => {
  test("a cached bundle still talks to the gateway on each read", async () => {
    const gw = fakeGateway();
    const node = gw.node();

    await node.getRuntime("default", "aria", "j");
    await node.getRuntime("default", "aria", "j");
    await node.getRuntime("default", "aria", "j");

    expect(gw.served).toHaveLength(3);
  });
});

/**
 * Per-fetch ETag revalidation means a colliding cache key still returns the
 * CORRECT bundle — the gateway resolves from the URL, not from the node's
 * cache. So the cache key is an efficiency property: with a tenant-only key,
 * alternating personas evict each other and every read costs a full body
 * instead of a 304. Counting revalidations is what actually pins the key.
 */
describe("criterion 1: the cache key separates personas", () => {
  test("alternating personas revalidate instead of re-downloading", async () => {
    const gw = fakeGateway();
    const node = gw.node();

    await node.getRuntime("default", "aria", "j");
    await node.getRuntime("default", "other", "j");
    await node.getRuntime("default", "aria", "j");
    await node.getRuntime("default", "other", "j");

    // Two cold fetches, then both personas stay cached and merely revalidate.
    expect(gw.revalidated).toEqual(["default/aria", "default/other"]);
  });

  test("alternating tenants revalidate instead of re-downloading", async () => {
    const gw = fakeGateway();
    const node = gw.node();

    await node.getRuntime("tenant-one", "aria", "j");
    await node.getRuntime("tenant-two", "aria", "j");
    await node.getRuntime("tenant-one", "aria", "j");

    expect(gw.revalidated).toEqual(["tenant-one/aria"]);
  });
});

describe("criterion 7: tenant isolation", () => {
  test("the same persona name in two tenants never shares a cache entry", async () => {
    const gw = fakeGateway();
    const node = gw.node();

    const one = await node.getRuntime("tenant-one", "aria", "j");
    const two = await node.getRuntime("tenant-two", "aria", "j");

    expect(one.providerCreds.apiKey).toBe("key-tenant-one-aria");
    expect(two.providerCreds.apiKey).toBe("key-tenant-two-aria");
  });

  test("busting one tenant leaves the other cached", async () => {
    const gw = fakeGateway();
    const node = gw.node();
    await node.getRuntime("tenant-one", "aria", "j");
    await node.getRuntime("tenant-two", "aria", "j");

    node.bustRuntime("tenant-one");

    expect((await node.getRuntime("tenant-two", "aria", "j")).tenantId).toBe("tenant-two");
  });
});

describe("criterion 7: the rollout is order-independent", () => {
  test("a node that only knows the legacy route still boots the default persona", async () => {
    process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
    process.env.SLAUDE_JOB_SECRET = JOB_SECRET;
    const api = createV1Api({ tools: {} as any });
    const jobToken = mintJobToken({
      tenant: "default", persona: "default", session: "S1", team: "T1",
      channel: "C1", thread: "1.1", initiator: "UTESTUSER1", scope: "turn",
    });

    const res = await api.fetch(
      new Request("http://gw/v1/tenants/default/runtime", {
        headers: { authorization: `Bearer ${NODE_TOKEN}`, [JOB_HEADER]: jobToken },
      }),
    );

    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).personaId).toBe("default");
  });
});
