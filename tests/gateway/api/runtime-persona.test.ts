/**
 * The runtime bundle used to be resolved per TENANT: buildBundle took whichever
 * persona sorted first and NodeClient cached on the tenant alone, so with more
 * than one persona in a tenant every session on a node received the first
 * persona's bundle. These pin the per-persona contract and the token scoping
 * that guards it.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { createV1Api } from "../../../src/gateway/api/index";
import { mintJobToken, JOB_HEADER } from "../../../src/gateway/api/auth";

const NODE_TOKEN = "test-node-token";
const JOB_SECRET = "test-job-secret";

const api = () => createV1Api({ tools: {} as any });

function token(opts: { tenant?: string; persona?: string } = {}): string {
  return mintJobToken({
    tenant: opts.tenant ?? "default",
    persona: opts.persona ?? "default",
    session: "S1",
    team: "T1",
    channel: "C1",
    thread: "1.1",
    initiator: "UTESTUSER1",
    scope: "turn",
  });
}

function get(path: string, jobToken: string): Request {
  return new Request(`http://gw${path}`, {
    headers: { authorization: `Bearer ${NODE_TOKEN}`, [JOB_HEADER]: jobToken },
  });
}

beforeAll(() => {
  process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
  process.env.SLAUDE_JOB_SECRET = JOB_SECRET;
});

describe("per-persona runtime route", () => {
  test("serves the persona named in the path", async () => {
    const res = await api().fetch(get("/v1/tenants/default/personas/default/runtime", token()));
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).personaId).toBe("default");
  });

  test("a job token for one persona cannot fetch another persona's bundle", async () => {
    const res = await api().fetch(
      get("/v1/tenants/default/personas/aria/runtime", token({ persona: "other" })),
    );
    expect(res!.status).toBe(403);
    expect(await res!.text()).toContain("persona");
  });

  test("a job token for one tenant cannot fetch another tenant's bundle", async () => {
    const res = await api().fetch(
      get("/v1/tenants/tenant-two/personas/default/runtime", token({ tenant: "tenant-one" })),
    );
    expect(res!.status).toBe(403);
    expect(await res!.text()).toContain("tenant");
  });

  test("the legacy tenant route still resolves the default persona", async () => {
    const res = await api().fetch(get("/v1/tenants/default/runtime", token()));
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).personaId).toBe("default");
  });

  test("an unknown persona is a 404 rather than a silent fallback to another one", async () => {
    const res = await api().fetch(
      get("/v1/tenants/default/personas/no-such-persona/runtime", token({ persona: "no-such-persona" })),
    );
    expect(res!.status).toBe(404);
  });

  test("the bundle is ETag-revalidatable", async () => {
    const first = await api().fetch(get("/v1/tenants/default/personas/default/runtime", token()));
    const etag = first!.headers.get("etag")!;
    expect(etag).toBeTruthy();

    const second = await api().fetch(
      new Request("http://gw/v1/tenants/default/personas/default/runtime", {
        headers: {
          authorization: `Bearer ${NODE_TOKEN}`,
          [JOB_HEADER]: token(),
          "if-none-match": etag,
        },
      }),
    );
    expect(second!.status).toBe(304);
  });
});
