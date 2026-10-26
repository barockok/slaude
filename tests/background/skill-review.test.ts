/**
 * The weekly skill review (spec §9.1 "Skill retirement scope", §7a.5): with a
 * fake model, the review retires an agent-authored skill unused for 30 days,
 * only proposes removal of an installed one, never lists a built-in, retires
 * at most three per run, and records each retirement for the digest.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, paths } from "../../src/config/home";
import { db } from "../../src/db/schema";
import * as Proposals from "../../src/db/proposals";
import * as Runs from "../../src/db/background-runs";
import * as SkillUsage from "../../src/db/skill-usage";
import { runPass, type PassSpec, type RunnerDeps } from "../../src/background/runner";
import type { PriceTable } from "../../src/background/prices";
import type { NightlyDeps } from "../../src/background/passes/nightly-review";
import {
  BUILTIN_REFUSAL,
  LIST_SKILLS_TOOL,
  MAX_RETIREMENTS,
  NOT_AGENT_REFUSAL,
  RETIRE_CAP_REFUSAL,
  RETIRE_SKILL_TOOL,
  reviewSkills,
  runSkillReview,
  type ReviewedSkill,
} from "../../src/background/passes/skill-review";
import { createBackgroundScheduler, passHandlers } from "../../src/background/scheduler";
import { CREDENTIAL_REFUSAL } from "../../src/knowledge/memory-pages";
import { skillOps } from "../../src/skills/mcp-tools";
import { personaSkillsRoot, RETIRED_DIR } from "../../src/skills/loader";
import { fakeBrain } from "./fake-brain";

const MODEL = "test-model";
const TABLE: PriceTable = { [MODEL]: { input: 1, output: 0, cache_read: 0, cache_write: 0 } };
const TURN = { input_tokens: 10_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const AGENT = "U0AGENT";
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-01T04:30:00Z"); // a Sunday, past 04:00 UTC
const LOCK = () => join(paths.home, "slaude.lock");

type Tools = Record<string, { handler: Function }>;
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

/** A fake query that runs `onPass` against the pass's tools, then ends ok. */
function harness(onPass: (tools: Tools, spec: PassSpec) => Promise<void>) {
  const seen: PassSpec[] = [];
  let current: PassSpec | null = null;
  let t = NOW;
  const query = ((args: { prompt: AsyncIterable<unknown>; options: { mcpServers: Record<string, { instance: { _registeredTools: Tools } }> } }) =>
    (async function* () {
      for await (const _ of args.prompt) void _;
      seen.push(current!);
      await onPass(args.options.mcpServers.slaude_pass!.instance._registeredTools, current!);
      yield { type: "assistant", parent_tool_use_id: null, message: { id: `m${seen.length}`, usage: TURN, content: [] } };
      yield { type: "result", subtype: "success", is_error: false, usage: TURN };
    })()) as unknown as RunnerDeps["query"];
  const runner: RunnerDeps = {
    query,
    brainCall: fakeBrain().call,
    now: () => new Date((t += 1000)),
    priceTable: TABLE,
    model: () => MODEL,
    budget: () => ({ limitUsd: 5, timeZone: "UTC" }),
    kbSources: () => [],
    provider: async () => null,
  };
  const deps: NightlyDeps = {
    runner,
    call: runner.brainCall,
    listSources: async () => [],
    run: (spec, d) => {
      current = spec;
      return runPass(spec, d);
    },
  };
  return { deps, seen };
}

const listed = async (tools: Tools): Promise<ReviewedSkill[]> => JSON.parse(text(await tools[LIST_SKILLS_TOOL]!.handler({}, {})));
const retire = async (tools: Tools, slug: string, reason = "unused for 30 days") => tools[RETIRE_SKILL_TOOL]!.handler({ slug, reason }, {});
const propose = async (tools: Tools, s: ReviewedSkill) =>
  tools.propose!.handler({ kind: "skill-removal", to: "manager", payload: { slug: s.slug, provenance: s.provenance, reason: "unused", uses: s.uses, last_used_at: s.last_used_at } }, {});

/** What a sensible model does: retire idle agent skills, propose idle installed ones. */
async function sensible(tools: Tools, results: string[] = []) {
  for (const s of await listed(tools)) {
    if (s.idle_days < 30) continue;
    if (s.provenance === "agent") results.push(text(await retire(tools, s.slug)));
    else {
      const r = await retire(tools, s.slug);
      results.push(`${s.slug}: ${text(r)}`);
      results.push(text(await propose(tools, s)));
    }
  }
}

const group = (personaId = "default") => ({ agentId: AGENT, personaId, personaIds: [personaId], timeZone: "UTC" });
const run = (deps: NightlyDeps, personaId = "default") => runSkillReview({ ...group(personaId), slot: "2026-W44" }, deps);

const placed = (slug: string, root = paths.skills, name = slug) => {
  mkdirSync(join(root, slug), { recursive: true });
  writeFileSync(join(root, slug, "SKILL.md"), `---\nname: ${name}\ndescription: placed\n---\nBODY-MARKER\n`);
};
const old = new Date(NOW - 40 * DAY);

let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  ensureHome();
  for (const dir of [paths.skills, join(paths.personas, "alpha")]) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(paths.skills, { recursive: true });
  rmSync(LOCK(), { force: true });
  for (const t of ["skill_usage", "proposals", "background_runs", "background_slots"]) await db.run(`DELETE FROM ${t}`);
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(LOCK(), { force: true });
  logSpy.mockRestore();
  errSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("the weekly review", () => {
  async function fixture() {
    skillOps.write("old-helper", "old-helper", "an agent skill nobody loads", "BODY-MARKER", undefined, old);
    skillOps.write("busy", "busy", "an agent skill in use", "b", undefined, old);
    placed("from-git");
    writeFileSync(LOCK(), JSON.stringify({ version: 1, generated_at: old.toISOString(), skills: { "from-git": {} } }));
    placed("how-slaude-works"); // bundled with the release
    placed("memory"); // a built-in's name, placed by hand
    await SkillUsage.noteSeen(AGENT, ["old-helper", "busy", "from-git", "how-slaude-works"], old.getTime());
    await SkillUsage.record(AGENT, "busy", NOW - 2 * DAY);
  }

  test("retires an agent skill with 0 uses in 30 days and only proposes for an installed one", async () => {
    await fixture();
    const results: string[] = [];
    let seenList: ReviewedSkill[] = [];
    const { deps, seen } = harness(async (tools) => {
      seenList = await listed(tools);
      await sensible(tools, results);
    });
    const res = await run(deps);

    expect(seen.map((s) => [s.pass, s.scope])).toEqual([["skill-review", { kind: "agent" }]]);
    expect(res!.outcome).toBe("ok");
    expect(res!.retired.map((r) => r.slug)).toEqual(["old-helper"]);
    // The listing: metadata only, provenance per the lock / seed / stamp, built-ins left out.
    expect(seenList.map((s) => [s.slug, s.provenance, s.uses, s.idle_days])).toEqual([
      ["busy", "agent", 1, 2],
      ["from-git", "installed", 0, 40],
      ["how-slaude-works", "bundled", 0, 40],
      ["old-helper", "agent", 0, 40],
    ]);
    expect(JSON.stringify(seenList)).not.toContain("BODY-MARKER");

    // old-helper moved aside, restorable; the rest stay.
    expect(existsSync(join(paths.skills, "old-helper"))).toBe(false);
    expect(skillOps.listRetired()).toEqual([res!.retired[0]!.retiredId]);
    for (const slug of ["busy", "from-git", "how-slaude-works"]) expect(existsSync(join(paths.skills, slug))).toBe(true);

    // The installed and bundled skills were refused and proposed to the manager instead.
    expect(results.filter((r) => r.endsWith(NOT_AGENT_REFUSAL)).map((r) => r.split(":")[0])).toEqual(["from-git", "how-slaude-works"]);
    const open = await Proposals.listOpen(AGENT, "manager");
    expect(open.map((p) => [p.kind, p.payload.slug])).toEqual([["skill-removal", "from-git"], ["skill-removal", "how-slaude-works"]]);

    // The retirement is a settled event the digest can read.
    const events = await Proposals.listSkillRetirements(AGENT, 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "skill-retired", status: "approved", toKind: "manager", decidedBy: "skill-review", scope: "agent" });
    expect(events[0]!.payload).toEqual({ slug: "old-helper", retiredId: res!.retired[0]!.retiredId, persona: "default", reason: "unused for 30 days", uses: 0, lastUsedAt: null });

    const runs = await Runs.listOpenAll(Number.MAX_SAFE_INTEGER);
    expect(runs).toEqual([]);
    const row = await db.one<{ pass: string; outcome: string }>("SELECT pass, outcome FROM background_runs");
    expect(row).toEqual({ pass: "skill-review", outcome: "ok" });

    // Restoring brings it back as it was.
    expect(skillOps.restore(res!.retired[0]!.retiredId).slug).toBe("old-helper");
    expect(skillOps.read("old-helper")).toContain('authored_by: "agent"');
  });

  test("at most three retirements per run", async () => {
    for (const n of [1, 2, 3, 4, 5]) skillOps.write(`idle-${n}`, `idle-${n}`, "d", "b", undefined, old);
    await SkillUsage.noteSeen(AGENT, [1, 2, 3, 4, 5].map((n) => `idle-${n}`), old.getTime());
    const results: string[] = [];
    const { deps } = harness(async (tools) => sensible(tools, results));
    const res = await run(deps);
    expect(res!.retired).toHaveLength(MAX_RETIREMENTS);
    expect(results.slice(MAX_RETIREMENTS)).toEqual([RETIRE_CAP_REFUSAL, RETIRE_CAP_REFUSAL]);
    expect((await Proposals.listSkillRetirements(AGENT, 0)).map((e) => e.payload.slug)).toEqual(["idle-1", "idle-2", "idle-3"]);
  });

  test("retire_skill refuses built-ins, unknown slugs and bad reasons, and re-reads provenance at the call", async () => {
    skillOps.write("mine", "mine", "d", "b", undefined, old);
    placed("memory");
    const results: string[] = [];
    const { deps } = harness(async (tools) => {
      results.push(text(await retire(tools, "memory")));
      results.push(text(await retire(tools, "skill-authoring")));
      results.push(text(await retire(tools, "nope")));
      results.push(text(await retire(tools, "mine", "  ")));
      results.push(text(await retire(tools, "mine", "x".repeat(501))));
      results.push(text(await retire(tools, "mine", "api_key: placeholder-not-a-real-key-123")));
      // The skill lands in slaude.lock after the listing: the call reads the lock again.
      writeFileSync(LOCK(), JSON.stringify({ version: 1, skills: { mine: {} } }));
      results.push(text(await retire(tools, "mine")));
    });
    const res = await run(deps);
    expect(results).toEqual([
      BUILTIN_REFUSAL,
      BUILTIN_REFUSAL,
      'refused: "nope" is not a skill in this agent\'s skills root',
      "refused: a retirement needs a reason",
      "refused: the reason is over 500 characters",
      CREDENTIAL_REFUSAL,
      NOT_AGENT_REFUSAL,
    ]);
    expect(res!.retired).toEqual([]);
    expect(existsSync(join(paths.skills, "mine"))).toBe(true);
  });

  test("a retire that fails on disk is reported to the model, nothing recorded", async () => {
    skillOps.write("idle", "idle", "d", "b", undefined, old);
    const spy = spyOn(skillOps, "retire").mockImplementationOnce(() => {
      throw new Error("EXDEV");
    });
    const results: string[] = [];
    const { deps } = harness(async (tools) => void results.push(text(await retire(tools, "idle"))));
    const res = await run(deps);
    spy.mockRestore();
    expect(results).toEqual(["could not retire idle: EXDEV"]);
    expect(res!.retired).toEqual([]);
    expect(await Proposals.listSkillRetirements(AGENT, 0)).toEqual([]);
  });

  test("a failure to record the retirement leaves the skill retired and is logged", async () => {
    skillOps.write("idle", "idle", "d", "b", undefined, old);
    await SkillUsage.noteSeen(AGENT, ["idle"], old.getTime());
    const spy = spyOn(Proposals, "recordSkillRetired").mockRejectedValueOnce(new Error("db gone"));
    const { deps } = harness(async (tools) => sensible(tools));
    const res = await run(deps);
    spy.mockRestore();
    expect(res!.retired.map((r) => r.slug)).toEqual(["idle"]);
    expect(errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("could not record it: db gone"))).toBe(true);
  });

  test("a persona with no skills of its own, or a shutdown, runs nothing", async () => {
    const { deps, seen } = harness(async () => {});
    expect(await run(deps)).toBeNull();
    skillOps.write("x", "x", "d", "b");
    const ac = new AbortController();
    ac.abort();
    expect(await runSkillReview({ ...group(), slot: "2026-W44", signal: ac.signal }, deps)).toBeNull();
    expect(seen).toEqual([]);
    expect(await db.one("SELECT 1 FROM background_runs")).toBeNull();
  });
});

describe("what the review sees", () => {
  test("a skill is idle only since its usage was tracked: a fresh row starts now", async () => {
    skillOps.write("legacy", "legacy", "d", "b", undefined, old);
    // No usage row yet (the feature just shipped, or the counts were lost).
    const at = new Date(NOW);
    const [s] = await reviewSkills("default", AGENT, at);
    expect(s).toMatchObject({ slug: "legacy", uses: 0, last_used_at: null, tracked_since: at.toISOString(), idle_days: 0 });
    // A week later it has been idle a week.
    const [later] = await reviewSkills("default", AGENT, new Date(NOW + 7 * DAY));
    expect(later!.idle_days).toBe(7);
    expect(later!.tracked_since).toBe(at.toISOString());
  });

  test("a base skill counts every agent's uses, by slug and by CLI name", async () => {
    skillOps.write("greet", "Greet Me", "d", "b", undefined, old);
    await SkillUsage.noteSeen(AGENT, ["greet"], old.getTime());
    await SkillUsage.record("U0OTHER", "Greet-Me", NOW - DAY);
    await SkillUsage.record(AGENT, "greet", NOW - 3 * DAY);
    const [s] = await reviewSkills("default", AGENT, new Date(NOW));
    expect(s).toMatchObject({ uses: 2, last_used_at: new Date(NOW - DAY).toISOString(), idle_days: 1 });
  });

  test("a named persona sees only its overlay, with its own agent's usage; its retirement stays in the overlay", async () => {
    skillOps.write("base-skill", "base-skill", "d", "b", undefined, old);
    skillOps.write("own-idle", "own-idle", "d", "b", "alpha", old);
    skillOps.write("own-used", "own-used", "d", "b", "alpha", old);
    await SkillUsage.noteSeen(AGENT, ["own-idle", "own-used"], old.getTime());
    await SkillUsage.record("U0OTHER", "own-used", NOW - DAY); // another agent's use: not alpha's
    const lists: ReviewedSkill[][] = [];
    const { deps } = harness(async (tools) => {
      lists.push(await listed(tools));
      await sensible(tools);
    });
    const res = await run(deps, "alpha");
    expect(lists[0]!.map((s) => [s.slug, s.uses])).toEqual([["own-idle", 0], ["own-used", 0]]);
    expect(res!.retired.map((r) => r.slug).sort()).toEqual(["own-idle", "own-used"]);
    expect(skillOps.listRetired("alpha")).toHaveLength(2);
    expect(existsSync(join(personaSkillsRoot("alpha"), RETIRED_DIR))).toBe(true);
    expect(existsSync(join(paths.skills, "base-skill"))).toBe(true);
    expect((await Proposals.listSkillRetirements(AGENT, 0))[0]!.payload.persona).toBe("alpha");
  });

  test("a root emptied after the start lists nothing", async () => {
    skillOps.write("x", "x", "d", "b");
    const outputs: string[] = [];
    const h = harness(async (tools) => {
      rmSync(join(paths.skills, "x"), { recursive: true, force: true });
      outputs.push(text(await tools[LIST_SKILLS_TOOL]!.handler({}, {})));
    });
    await run(h.deps);
    expect(outputs).toEqual(["(no skills in this agent's skills root)"]);
  });
});

test("the scheduler runs the review in the Sunday 04:00 slot, once per ISO week", async () => {
  skillOps.write("idle", "idle", "d", "b", undefined, old);
  await SkillUsage.noteSeen(AGENT, ["idle"], old.getTime());
  const { deps, seen } = harness(async (tools) => sensible(tools));
  const handlers = passHandlers(deps);
  const tick = (at: number) =>
    createBackgroundScheduler({
      now: () => new Date(at),
      brainReady: () => true,
      agents: async () => [group()],
      handlers: { "skill-review": handlers["skill-review"] },
      sweep: async () => 0,
    }).tick();
  await tick(Date.parse("2026-11-01T03:59:00Z")); // Sunday, before 04:00
  expect(seen).toEqual([]);
  await tick(NOW);
  await tick(NOW + 3600_000); // a second scheduler, same week: already claimed
  expect(seen.map((s) => s.pass)).toEqual(["skill-review"]);
  expect(existsSync(join(paths.skills, "idle"))).toBe(false);
});
