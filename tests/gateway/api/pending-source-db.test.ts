import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { db } from "../../../src/db/schema";
import * as PendingGates from "../../../src/db/pending-gates";
import { DbPendingSource, defaultPendingSource } from "../../../src/gateway/api/pending-source";
import { createV1Api } from "../../../src/gateway/api";

const NODE_TOKEN = "pending-db-test-token";

const stubTools = {
  slackCtx: () => { throw new Error("unused"); },
  surfaceFor: () => { throw new Error("unused"); },
  surfaceOpts: () => { throw new Error("unused"); },
  connect: async () => "unused",
  brainDeps: () => undefined,
} as any;

beforeEach(async () => {
  await db.run("DELETE FROM pending_gates");
});

describe("DbPendingSource (durable seam adapter)", () => {
  test("defaultPendingSource is the durable adapter", () => {
    expect(defaultPendingSource()).toBeInstanceOf(DbPendingSource);
  });

  test("seam create lands a durable repo row stamped with this instance", async () => {
    const s = new DbPendingSource();
    const row = await s.create("mcp_connect", "S2", { url: "https://example.test" }, Date.now() + 60_000);
    const repoRow = await PendingGates.get(row.id);
    expect(repoRow?.status).toBe("pending");
    expect(repoRow?.payload).toEqual({ url: "https://example.test" });
    expect(repoRow?.instanceId).toBe(PendingGates.INSTANCE_ID);
  });

  test("repo rows read back through the seam; null expires_at never reads as expired", async () => {
    const s = new DbPendingSource();
    await PendingGates.create({ id: "tu_seam", kind: "perm", sessionId: "S1", payload: { toolName: "Bash" } });
    const row = await s.get("tu_seam");
    expect(row).toMatchObject({
      id: "tu_seam",
      sessionId: "S1",
      kind: "perm",
      status: "pending",
      payload: { toolName: "Bash" },
    });
    // Repo rows without a deadline map to Infinity so handlePending's
    // `expiresAt <= now` check can never misreport them as expired.
    expect(row!.expiresAt).toBe(Infinity);

    // One-winner resolve semantics pass through; "pending" is refused.
    expect(await s.resolve("tu_seam", "pending", "U9")).toBeNull();
    expect((await s.resolve("tu_seam", "approved", "U9"))?.resolvedBy).toBe("U9");
    expect(await s.resolve("tu_seam", "denied", "U9")).toBeNull();
  });

  test("sweepExpired counts repo-side sweeps", async () => {
    const s = new DbPendingSource();
    await s.create("perm", "S1", {}, Date.now() - 5);
    await s.create("perm", "S1", {}, Date.now() + 60_000);
    expect(await s.sweepExpired()).toBe(1);
  });
});

describe("GET /v1/pending/:id over the durable store", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => {
    server?.stop(true);
    server = undefined;
    delete process.env.SLAUDE_NODE_TOKEN;
  });

  test("long-poll sees a repo-side resolution (another replica's click)", async () => {
    process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
    const v1 = createV1Api({
      tools: stubTools,
      pendingSource: new DbPendingSource(),
      pending: { timeoutMs: 5_000, pollMs: 25 },
    });
    server = Bun.serve({ port: 0, fetch: async (req) => (await v1.fetch(req)) ?? new Response(null, { status: 404 }) });

    const gate = await PendingGates.create({
      kind: "approval",
      sessionId: "S1",
      payload: { plan: "deploy" },
      expiresAt: Date.now() + 60_000,
    });
    const poll = fetch(`http://127.0.0.1:${server.port}/v1/pending/${gate.id}`, {
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    // Settle the row straight through the repo — the endpoint must observe it.
    setTimeout(() => { void PendingGates.resolve(gate.id, "approved", "U7"); }, 100);

    const r = await poll;
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "approved", resolvedBy: "U7", payload: { plan: "deploy" } });
  });
});
