/**
 * POST /v1/background/skill-check/start|finish (spec §9.3): the gateway keeps
 * a node's skill-check budget on its own ledger. Persona, agent, session and
 * scope come from the job token; the usage is priced with the gateway's own
 * table; finish is refused for a run that is not open or not this agent's.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../../src/db/schema";
import * as Runs from "../../../src/db/background-runs";
import * as Sessions from "../../../src/db/sessions";
import { handleSkillCheck, handleSkillUsage } from "../../../src/gateway/api/background";
import * as SkillUsage from "../../../src/db/skill-usage";
import { createV1Api } from "../../../src/gateway/api";
import { JOB_HEADER, mintJobToken, type JobClaims } from "../../../src/gateway/api/auth";
import { InMemoryPendingSource } from "../../../src/gateway/api/pending-source";
import { resetAgentId, setAgentId } from "../../../src/knowledge/agent-identity";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../../src/persona/registry";
import type { Persona } from "../../../src/persona/types";
import type { PriceTable } from "../../../src/background/prices";
import type { SkillCheckDeps } from "../../../src/background/skill-check";

const MODEL = "claude-test-1";
const TABLE: PriceTable = { [MODEL]: { input: 1, output: 10, cache_read: 0.1, cache_write: 2 } };
const NOW = new Date("2026-10-26T12:00:00Z");
const deps = (limitUsd = 1): SkillCheckDeps => ({ priceTable: TABLE, now: () => NOW, budget: () => ({ limitUsd, timeZone: "UTC" }) });
const M = (input: number, output: number) => ({ input, output, cache_read: 0, cache_write: 0 });

let seq = 0;
async function session(model = MODEL, persona: string | null = null) {
  seq++;
  const row = await Sessions.createForThread({
    thread: { team_id: "T0TEAM", channel_id: "C0TEAM", thread_ts: `${Date.now()}.${seq}` },
    model,
    working_dir: "/tmp",
  });
  if (persona) await db.run("UPDATE sessions SET persona_id = ? WHERE id = ?", [persona, row.id]);
  return row.id;
}

const claims = (session: string, over: Partial<JobClaims> = {}): JobClaims =>
  ({
    tenant: "default", persona: "default", session, team: "T0TEAM", channel: "C0TEAM", thread: "1.0",
    initiator: "U0ALICE", scope: "turn", runAs: "agent", exp: 0, iat: 0, ...over,
  }) as JobClaims;

const body = async (r: Response) => ({ status: r.status, json: (await r.json()) as any });

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
  __resetPersonaRegistry();
});

describe("start", () => {
  test("opens a skill-check run for the token's agent, scope from runAs, model from the session row", async () => {
    const s = await session();
    const r = await body(await handleSkillCheck("start", {}, claims(s, { runAs: "user:U0ALICE" }), deps()));
    expect(r).toMatchObject({ status: 200, json: { ok: true } });
    const run = await Runs.get(r.json.runId);
    expect(run).toMatchObject({ agentId: "U0AGENT", pass: "skill-check", scope: "user:U0ALICE", model: MODEL, outcome: null, day: "2026-10-26" });
  });

  test("a refused budget records skipped-budget and opens nothing", async () => {
    const s = await session();
    const r = await body(await handleSkillCheck("start", {}, claims(s), deps(0)));
    expect(r).toEqual({ status: 200, json: { ok: false, reason: "budget" } });
    const rows = await Runs.listBetween("U0AGENT", "2026-10-26", "2026-10-26");
    expect(rows.map((x) => [x.pass, x.outcome])).toEqual([["skill-check", "skipped-budget"]]);
  });

  test("an unpriced model refuses to start (an error row, never priced at zero)", async () => {
    const s = await session("claude-unknown-9");
    const r = await body(await handleSkillCheck("start", {}, claims(s), deps()));
    expect(r).toEqual({ status: 200, json: { ok: false, reason: "model" } });
    const rows = await Runs.listBetween("U0AGENT", "2026-10-26", "2026-10-26");
    expect(rows.map((x) => [x.outcome, x.model])).toEqual([["error", "claude-unknown-9"]]);
  });

  test("a body with any field is a 400 (nothing comes from the node but the token)", async () => {
    const s = await session();
    const r = await handleSkillCheck("start", { persona: "other" }, claims(s), deps());
    expect(r.status).toBe(400);
    expect(await Runs.listBetween("U0AGENT", "2026-10-26", "2026-10-26")).toEqual([]);
  });

  test("a named persona's run is keyed on its Slack user id", async () => {
    const ana: Persona = { name: "ana", slackUserId: "U0ANA", soulMd: "s", config: { slackUserId: "U0ANA", name: "ana" }, outClient: null };
    const reg: PersonaRegistry = {
      lookupByUserId: () => null,
      lookupByName: (n) => (n === "ana" ? ana : null),
      list: () => [ana],
      isMultiPersonaMode: () => true,
      isManaged: () => true,
      tombstonedPersonaFor: () => null,
      defaultPersona: () => ({ model: null, mcp: null, background: null }),
    };
    setPersonaRegistry(reg);
    const s = await session(MODEL, "ana");
    const r = await body(await handleSkillCheck("start", {}, claims(s, { persona: "ana" }), deps()));
    expect((await Runs.get(r.json.runId))?.agentId).toBe("U0ANA");
    // Another persona's token cannot finish it.
    const other = await handleSkillCheck("finish", { runId: r.json.runId, outcome: "ok", usage: {} }, claims(s), deps());
    expect(other.status).toBe(409);
  });
});

describe("finish", () => {
  async function open() {
    const s = await session();
    const r = await body(await handleSkillCheck("start", {}, claims(s), deps()));
    return { s, runId: r.json.runId as string };
  }

  test("prices the reported tokens with the gateway's table and ends the run", async () => {
    const { s, runId } = await open();
    const r = await body(await handleSkillCheck("finish", { runId, outcome: "ok", usage: { [MODEL]: M(1000, 100) } }, claims(s), deps()));
    expect(r).toEqual({ status: 200, json: { ok: true } });
    const run = (await Runs.get(runId))!;
    expect(run.outcome).toBe("ok");
    expect(run.tokens).toEqual(M(1000, 100));
    // 1000 × 1/1e6 + 100 × 10/1e6
    expect(run.costUsd).toBeCloseTo(0.002, 9);
  });

  test("a node-supplied cost is refused (400)", async () => {
    const { s, runId } = await open();
    const r = await handleSkillCheck("finish", { runId, outcome: "ok", usage: {}, costUsd: 0 }, claims(s), deps());
    expect(r.status).toBe(400);
    expect((await Runs.get(runId))!.outcome).toBeNull();
  });

  test("a run that is not open is refused: unknown id, already finished, another agent's, another pass", async () => {
    const { s, runId } = await open();
    const fin = (id: string) => handleSkillCheck("finish", { runId: id, outcome: "ok", usage: { [MODEL]: M(1, 1) } }, claims(s), deps());
    expect((await fin("no-such-run")).status).toBe(409);
    expect((await fin(runId)).status).toBe(200);
    expect((await fin(runId)).status).toBe(409);
    const theirs = await Runs.start({ agentId: "U0OTHER", pass: "skill-check", scope: "agent", day: "2026-10-26", model: MODEL });
    expect((await fin(theirs)).status).toBe(409);
    expect((await Runs.get(theirs))!.outcome).toBeNull();
    const nightly = await Runs.start({ agentId: "U0AGENT", pass: "nightly-review", scope: "agent", day: "2026-10-26", model: MODEL });
    expect((await fin(nightly)).status).toBe(409);
    expect((await Runs.get(nightly))!.outcome).toBeNull();
  });

  test("an unpriced model is priced at the run's model and ends the run as error", async () => {
    const { s, runId } = await open();
    await handleSkillCheck("finish", { runId, outcome: "ok", usage: { "claude-unknown-9": M(1000, 0) } }, claims(s), deps());
    const run = (await Runs.get(runId))!;
    expect(run.outcome).toBe("error");
    expect(run.costUsd).toBeCloseTo(0.001, 9);
  });

  test('"" stands for the run\'s own model', async () => {
    const { s, runId } = await open();
    await handleSkillCheck("finish", { runId, outcome: "error", usage: { "": M(0, 1000) } }, claims(s), deps());
    const run = (await Runs.get(runId))!;
    expect(run).toMatchObject({ outcome: "error", tokens: M(0, 1000) });
    expect(run.costUsd).toBeCloseTo(0.01, 9);
  });
});

describe("over /v1", () => {
  test("job-token authenticated and label-gated like every persona route", async () => {
    const saved = { node: process.env.SLAUDE_NODE_TOKEN, job: process.env.SLAUDE_JOB_SECRET };
    process.env.SLAUDE_NODE_TOKEN = "bg-node-token";
    process.env.SLAUDE_JOB_SECRET = "bg-job-secret";
    try {
      const v1 = createV1Api({ tools: {} as any, pendingSource: new InMemoryPendingSource(), memory: null });
      // The route uses the process's price table: a model the built-in table lists.
      const s = await session("claude-sonnet-5-5");
      const call = (headers: Record<string, string>) =>
        v1.fetch(new Request("http://gw/v1/background/skill-check/start", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }));
      expect((await call({ authorization: "Bearer bg-node-token" }))!.status).toBe(401);
      const { exp: _e, iat: _i, ...c } = claims(s);
      const ok = (await call({ authorization: "Bearer bg-node-token", [JOB_HEADER]: mintJobToken(c) }))!;
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as any).ok).toBe(true);
    } finally {
      for (const [k, v] of [["SLAUDE_NODE_TOKEN", saved.node], ["SLAUDE_JOB_SECRET", saved.job]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("POST /v1/background/skill-usage", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM skill_usage");
  });

  test("counts one use for the token persona's agent, the name normalised", async () => {
    const r = await body(await handleSkillUsage({ skill: " /greet " }, claims("S-usage"), () => 1234));
    expect(r).toEqual({ status: 200, json: { ok: true } });
    await handleSkillUsage({ skill: "greet" }, claims("S-usage"), () => 2000);
    expect((await SkillUsage.forAgent("U0AGENT")).get("greet")).toEqual({ skill: "greet", uses: 2, lastUsedAt: 2000, firstSeenAt: 1234 });
  });

  test("a named persona's use counts for that persona's agent", async () => {
    const ana: Persona = { name: "ana", slackUserId: "U0ANA", soulMd: "s", config: { slackUserId: "U0ANA", name: "ana" }, outClient: null };
    setPersonaRegistry({
      lookupByUserId: () => null,
      lookupByName: (n) => (n === "ana" ? ana : null),
      list: () => [ana],
      isMultiPersonaMode: () => true,
      isManaged: () => true,
      tombstonedPersonaFor: () => null,
      defaultPersona: () => ({ model: null, mcp: null, background: null }),
    });
    await handleSkillUsage({ skill: "greet" }, claims("S-usage", { persona: "ana" }));
    expect((await SkillUsage.forAgent("U0ANA")).get("greet")?.uses).toBe(1);
    expect((await SkillUsage.forAgent("U0AGENT")).size).toBe(0);
  });

  test("a bad body is 400 and counts nothing", async () => {
    for (const b of [{}, { skill: "" }, { skill: "a b" }, { skill: "x".repeat(300) }, { skill: "greet", persona: "ana" }]) {
      expect((await handleSkillUsage(b, claims("S-usage"))).status).toBe(400);
    }
    expect((await SkillUsage.forAgent("U0AGENT")).size).toBe(0);
  });

  test("a database failure propagates to the router (500), never a silent 200", async () => {
    const spy = spyOn(SkillUsage, "record").mockRejectedValueOnce(new Error("db gone"));
    await expect(handleSkillUsage({ skill: "greet" }, claims("S-usage"))).rejects.toThrow("db gone");
    spy.mockRestore();
  });
});
