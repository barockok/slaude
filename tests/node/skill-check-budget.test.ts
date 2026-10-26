/**
 * The node's skill-check budget: a REST client of the gateway's
 * /v1/background/skill-check routes, on the session's job token. It sends
 * nothing the gateway should decide (no persona, no cost) and throws on every
 * failure, so the manager fails closed.
 */
import { describe, expect, test } from "bun:test";
import { NodeClient } from "../../src/node/client";
import { makeNodeSkillCheckBudget } from "../../src/node/background";
import { JOB_HEADER } from "../../src/gateway/api/auth";

type Seen = { url: string; method: string; job: string | null; body: unknown };

function setup(answer: (s: Seen) => Response) {
  const seen: Seen[] = [];
  const client = new NodeClient({
    baseUrl: "http://gw",
    token: "node-t",
    attempts: 3,
    baseDelayMs: 1,
    fetchImpl: (async (url: string, init: RequestInit) => {
      const s: Seen = {
        url: String(url),
        method: String(init.method),
        job: (init.headers as Record<string, string>)[JOB_HEADER] ?? null,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      seen.push(s);
      return answer(s);
    }) as unknown as typeof fetch,
  });
  const tokens: string[] = [];
  const budget = makeNodeSkillCheckBudget({
    client,
    withToken: (_id, call) => {
      tokens.push("job-t");
      return call("job-t");
    },
  });
  return { seen, budget, tokens };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("node skill-check budget", () => {
  test("start posts an empty body on the job token; the persona is never sent", async () => {
    const { seen, budget } = setup(() => json(200, { ok: true, runId: "r1" }));
    expect(await budget.start("S1", "ana")).toEqual({ ok: true, runId: "r1" });
    expect(seen).toEqual([{ url: "http://gw/v1/background/skill-check/start", method: "POST", job: "job-t", body: {} }]);
  });

  test("a refusal is ok:false", async () => {
    const { budget } = setup(() => json(200, { ok: false, reason: "budget" }));
    expect(await budget.start("S1", "default")).toEqual({ ok: false });
  });

  test("an older gateway (404) and a 5xx throw; start is not retried", async () => {
    const old = setup(() => json(404, { error: "not found" }));
    await expect(old.budget.start("S1", "default")).rejects.toThrow();
    const down = setup(() => json(503, { error: "x" }));
    await expect(down.budget.start("S1", "default")).rejects.toThrow();
    expect(down.seen).toHaveLength(1);
  });

  test("finish posts run id, outcome and per-model tokens, never a cost", async () => {
    const { seen, budget } = setup(() => json(200, { ok: true }));
    const usage = { "claude-test-1": { input: 3, output: 4, cache_read: 0, cache_write: 0 } };
    await budget.finish("S1", "r1", { outcome: "ok", usage });
    expect(seen).toEqual([{ url: "http://gw/v1/background/skill-check/finish", method: "POST", job: "job-t", body: { runId: "r1", outcome: "ok", usage } }]);
  });

  test("a refused finish (409) throws", async () => {
    const { budget } = setup(() => json(409, { error: "no open run" }));
    await expect(budget.finish("S1", "r1", { outcome: "ok", usage: {} })).rejects.toThrow();
  });
});
