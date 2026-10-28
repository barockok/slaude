/**
 * POST /v1/background/turn/finish (phase E): a node finishes the background
 * turn run its job carries (a promise check, a heartbeat ask/act turn). Only
 * the run id signed into the job token as `bgRun` is finished, only while it
 * is an open `commitment` or `heartbeat-turn` run of the token persona's
 * agent, priced with the gateway's own table.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../../src/db/schema";
import * as Runs from "../../../src/db/background-runs";
import { handleTurnRun } from "../../../src/gateway/api/background";
import { mintJobToken, verifyJobToken, type JobClaims } from "../../../src/gateway/api/auth";
import { resetAgentId, setAgentId } from "../../../src/knowledge/agent-identity";
import { ledgerTurnRun, startSkillCheck, type SkillCheckDeps } from "../../../src/background/skill-check";
import type { PriceTable } from "../../../src/background/prices";

const MODEL = "claude-test-1";
const TABLE: PriceTable = { [MODEL]: { input: 1, output: 10, cache_read: 0.1, cache_write: 2 } };
const NOW = new Date("2026-10-26T12:00:00Z");
const deps: SkillCheckDeps = { priceTable: TABLE, now: () => NOW, budget: () => ({ limitUsd: 1, timeZone: "UTC" }) };
const M = (input: number, output: number) => ({ input, output, cache_read: 0, cache_write: 0 });

const claims = (over: Partial<JobClaims> = {}): JobClaims =>
  ({
    tenant: "default", persona: "default", session: "s1", team: "T0TEAM", channel: "C0TEAM", thread: "1.0",
    initiator: "U0ALICE", scope: "turn", runAs: "agent", exp: 0, iat: 0, ...over,
  }) as JobClaims;

const body = async (r: Response) => ({ status: r.status, json: (await r.json()) as any });

async function openRun(pass: "commitment" | "skill-check" | "heartbeat-turn" = "commitment"): Promise<string> {
  const r = await startSkillCheck({ personaId: "default", model: MODEL, scope: "agent", pass }, deps);
  if (!r.ok) throw new Error("run did not open");
  return r.runId;
}

let errSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  await db.run("DELETE FROM background_runs");
  setAgentId("U0AGENT");
  errSpy = spyOn(console, "error").mockImplementation(() => {});
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  logSpy.mockRestore();
  resetAgentId();
});

describe("background turn finish", () => {
  test("a commitment run opens under its own pass, with the floor as its estimate", async () => {
    const r = await startSkillCheck({ personaId: "default", model: MODEL, scope: "user:U0ALICE", pass: "commitment" }, deps);
    expect(r).toMatchObject({ ok: true, estimate: 0.03 });
    const run = await Runs.get((r as { runId: string }).runId);
    expect(run).toMatchObject({ pass: "commitment", scope: "user:U0ALICE", outcome: null, costUsd: 0.03 });
  });

  test("finishes the token's own run with the gateway's price", async () => {
    const runId = await openRun();
    const r = await body(await handleTurnRun("finish", { runId, outcome: "ok", usage: { [MODEL]: M(1_000, 100) } }, claims({ bgRun: runId }), deps));
    expect(r).toEqual({ status: 200, json: { ok: true } });
    const run = await Runs.get(runId);
    // 1000 input × $1/M + 100 output × $10/M.
    expect(run).toMatchObject({ outcome: "ok", pass: "commitment" });
    expect(run!.costUsd).toBeCloseTo(0.002, 9);
  });

  test("a token without bgRun, or naming another run, is refused", async () => {
    const runId = await openRun();
    const b = { runId, outcome: "ok", usage: {} };
    expect((await handleTurnRun("finish", b, claims(), deps)).status).toBe(409);
    expect((await handleTurnRun("finish", b, claims({ bgRun: "other" }), deps)).status).toBe(409);
    expect((await Runs.get(runId))!.outcome).toBeNull();
  });

  test("a heartbeat ask/act run finishes under its own pass", async () => {
    const runId = await openRun("heartbeat-turn");
    const r = await body(await handleTurnRun("finish", { runId, outcome: "ok", usage: { [MODEL]: M(1_000, 100) } }, claims({ bgRun: runId }), deps));
    expect(r).toEqual({ status: 200, json: { ok: true } });
    expect(await Runs.get(runId)).toMatchObject({ outcome: "ok", pass: "heartbeat-turn" });
  });

  test("a skill-check run cannot be finished through this route", async () => {
    const runId = await openRun("skill-check");
    expect((await handleTurnRun("finish", { runId, outcome: "ok", usage: {} }, claims({ bgRun: runId }), deps)).status).toBe(409);
  });

  test("a second finish is refused; bad bodies and ops are rejected", async () => {
    const runId = await openRun();
    const ok = { runId, outcome: "ok", usage: { [MODEL]: M(1, 1) } };
    expect((await handleTurnRun("finish", ok, claims({ bgRun: runId }), deps)).status).toBe(200);
    expect((await handleTurnRun("finish", ok, claims({ bgRun: runId }), deps)).status).toBe(409);
    expect((await handleTurnRun("finish", { runId }, claims({ bgRun: runId }), deps)).status).toBe(400);
    expect((await handleTurnRun("start", ok, claims({ bgRun: runId }), deps)).status).toBe(404);
  });

  test("mono: ledgerTurnRun finishes on the ledger and throws for a run that is not open", async () => {
    const runId = await openRun();
    const run = ledgerTurnRun({ runId, agentId: "U0AGENT", pass: "commitment", ...deps });
    await run.finish({ [MODEL]: M(10, 1) }, "ok");
    expect((await Runs.get(runId))!.outcome).toBe("ok");
    await expect(run.finish({}, "ok")).rejects.toThrow("is not open");
  });
});

describe("bgRun claim", () => {
  test("survives a mint/verify round trip; an empty or non-string bgRun is refused", () => {
    const secret = "s".repeat(32);
    const base = { tenant: "default", persona: "default", session: "s1", team: "T", channel: "C", thread: "1", initiator: "U", scope: "turn" };
    const ok = verifyJobToken(mintJobToken({ ...base, bgRun: "run-1" }, { secret }), { secret });
    expect(ok).toMatchObject({ ok: true, claims: { bgRun: "run-1" } });
    expect(verifyJobToken(mintJobToken({ ...base, bgRun: "" }, { secret }), { secret })).toEqual({ ok: false, reason: "bad_claims" });
    expect(verifyJobToken(mintJobToken({ ...base, bgRun: 5 as never }, { secret }), { secret })).toEqual({ ok: false, reason: "bad_claims" });
  });
});
