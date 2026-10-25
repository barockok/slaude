/**
 * kb_memoize with typed pages (phase C, spec §8.2, §8.3, §8.6): the profile
 * target, the supersede trail and /1on1 containment, against the fake brain,
 * which scopes writes to `scope.sourceId` and reads to `allowedSources` the
 * way gbrain does.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { brainHandlers, type BrainToolDeps } from "../../src/knowledge/mcp-tools";
import type { GateInput } from "../../src/knowledge/gated-dispatch";
import { resetStandingGrants } from "../../src/knowledge/gated-dispatch";
import { agentSourceId, profileSourceId, resolveBrainScope, SHARED_SOURCE, userSourceId, type BrainScope } from "../../src/knowledge/scope";
import { parseFrontmatter } from "../../src/knowledge/memory-pages";
import { fakeBrain } from "../memory/fake-brain";

const TEAM = "T0TEAM";
const AGENT = "AGENT1";
const PROFILE_REFUSAL = "refused: a profile is written only on that person's own turn";
const SUPERSEDE_REFUSAL = "refused: supersedes must name a page in the same memory";
const LOCK_REFUSAL = "refused: in a /1on1, memory stays with this person; ask them before sharing it";

beforeAll(() => {
  process.env.SLAUDE_AGENT_ID ??= AGENT;
});
beforeEach(() => resetStandingGrants());

type Write = { name: string; slug: string; scope: BrainScope };

function setup(over: Partial<GateInput> = {}) {
  const brain = fakeBrain();
  const writes: Write[] = [];
  let cards = 0;
  const g: GateInput = {
    userId: "U0ALICE", teamId: TEAM, interactive: true, origin: "slack", lockedUser: null,
    channelTrust: "trusted", isManager: false, agentId: AGENT, threadKey: "C0CHAN:1.1", ...over,
  };
  const deps: BrainToolDeps = {
    scope: () => resolveBrainScope({ ...g, kbSources: [] }),
    gate: () => g,
    managers: () => ["U0MGR"],
    requestApproval: async () => { cards++; return { approved: true, by: "U0MGR" }; },
    call: async (name, params, scope) => {
      if (name !== "get_page") writes.push({ name, slug: String(params.slug), scope });
      return brain.call(name, params, scope);
    },
  };
  return { brain, writes, deps, cards: () => cards, gate: g };
}

const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const profilePage = { slug: "profile", content: "Call me Al. Terse answers, no tables.\n", summary: "how Alice wants to be addressed", type: "profile" };

describe("kb_memoize target:\"profile\"", () => {
  test("an interactive Slack turn writes the speaker's profile, slug profile, no card", async () => {
    const s = setup();
    const r = await brainHandlers.kb_memoize({ pages: [profilePage], target: "profile" }, s.deps);
    expect(r.isError).toBeUndefined();
    expect(s.cards()).toBe(0);
    const own = profileSourceId(TEAM, "U0ALICE");
    expect(s.writes.map((w) => [w.name, w.scope.sourceId, w.slug])).toEqual([["put_page", own, "profile"]]);
    const meta = parseFrontmatter(s.brain.contentOf(own, "profile")!).meta;
    expect(meta.type).toBe("profile");
    expect(meta.confidence).toBe("told");
    expect(meta.source).toBe("told by U0ALICE");
  });

  test("only the write scope's sourceId changes: the read union and client are the turn's own", async () => {
    const s = setup();
    const base = resolveBrainScope({ ...s.gate, kbSources: [] });
    await brainHandlers.kb_memoize({ pages: [profilePage], target: "profile" }, s.deps);
    expect(s.writes[0]!.scope).toEqual({ ...base, sourceId: profileSourceId(TEAM, "U0ALICE") });
  });

  test("refused on a cron turn", async () => {
    const s = setup({ interactive: false, origin: "cron" });
    const r = await brainHandlers.kb_memoize({ pages: [profilePage], target: "profile" }, s.deps);
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(PROFILE_REFUSAL);
    expect(s.writes).toEqual([]);
  });

  test("refused on a panel turn and with an unknown origin", async () => {
    for (const over of [{ origin: "panel" as const }, { origin: undefined }]) {
      const s = setup(over);
      const r = await brainHandlers.kb_memoize({ pages: [profilePage], target: "profile" }, s.deps);
      expect(text(r)).toBe(PROFILE_REFUSAL);
      expect(s.writes).toEqual([]);
    }
  });

  test("refused when the subject is not the speaker", async () => {
    const s = setup();
    const r = await brainHandlers.kb_memoize({ pages: [profilePage], target: "profile", subject: "U0BOB" }, s.deps);
    expect(text(r)).toBe(PROFILE_REFUSAL);
    expect(s.writes).toEqual([]);
  });

  test("a subject equal to the speaker is fine", async () => {
    const s = setup();
    const r = await brainHandlers.kb_memoize({ pages: [profilePage], target: "profile", subject: "U0ALICE" }, s.deps);
    expect(r.isError).toBeUndefined();
  });

  test("refused when the team is unknown, or there is no speaker", async () => {
    for (const over of [{ teamId: null }, { userId: null }]) {
      const s = setup(over);
      const r = await brainHandlers.kb_memoize({ pages: [profilePage], target: "profile" }, s.deps);
      expect(text(r)).toBe(PROFILE_REFUSAL);
      expect(s.writes).toEqual([]);
    }
  });

  test("in someone else's /1on1, the speaker's own profile is written, never the lock owner's", async () => {
    const s = setup({ lockedUser: "U0BOB" });
    const r = await brainHandlers.kb_memoize({ pages: [profilePage], target: "profile" }, s.deps);
    expect(r.isError).toBeUndefined();
    expect(s.writes.map((w) => w.scope.sourceId)).toEqual([profileSourceId(TEAM, "U0ALICE")]);
    expect(s.brain.contentOf(profileSourceId(TEAM, "U0BOB"), "profile")).toBeUndefined();
  });

  test("a profile page must use slug \"profile\"; the profile takes profile and correction pages only", async () => {
    const s = setup();
    expect(text(await brainHandlers.kb_memoize({ pages: [{ ...profilePage, slug: "people/alice" }], target: "profile" }, s.deps))).toContain('slug "profile"');
    expect(text(await brainHandlers.kb_memoize({ pages: [{ slug: "notes/x", content: "x", summary: "s", type: "outcome" }], target: "profile" }, s.deps))).toContain("profile or correction");
    expect(text(await brainHandlers.kb_memoize({ pages: [{ slug: "notes/x", content: "x", summary: "s" }], target: "profile" }, s.deps))).toContain("profile or correction");
    const ok = await brainHandlers.kb_memoize({ pages: [{ slug: "corrections/name", content: "Not Alicia.", summary: "s", type: "correction" }], target: "profile" }, s.deps);
    expect(ok.isError).toBeUndefined();
    expect(s.writes.map((w) => w.slug)).toEqual(["corrections/name"]);
  });

  test("a profile page outside target \"profile\" is refused", async () => {
    const s = setup();
    const r = await brainHandlers.kb_memoize({ pages: [profilePage] }, s.deps);
    expect(text(r)).toContain('target "profile"');
    expect(s.writes).toEqual([]);
  });
});

describe("kb_memoize supersedes", () => {
  const mine = agentSourceId(AGENT);

  test("an existing page in the write source: the new page is written, then the old one is marked", async () => {
    const s = setup();
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/old", content: "Old belief.\n", summary: "s", type: "outcome" }] }, s.deps);
    s.writes.length = 0;
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/new", content: "New belief.\n", summary: "s", type: "outcome", supersedes: "notes/old" }] }, s.deps);
    expect(r.isError).toBeUndefined();
    expect(s.writes.map((w) => [w.slug, w.scope.sourceId])).toEqual([["notes/new", mine], ["notes/old", mine]]);
    const old = parseFrontmatter(s.brain.contentOf(mine, "notes/old")!);
    expect(old.meta.superseded_by).toBe("notes/new");
    expect(old.body).toBe("Old belief.\n");
    expect(parseFrontmatter(s.brain.contentOf(mine, "notes/new")!).meta.supersedes).toBe("notes/old");
  });

  test("a missing page is refused, and nothing is written", async () => {
    const s = setup();
    const r = await brainHandlers.kb_memoize({ pages: [
      { slug: "notes/a", content: "A", summary: "s", type: "outcome" },
      { slug: "notes/new", content: "New", summary: "s", type: "outcome", supersedes: "notes/ghost" },
    ] }, s.deps);
    expect(text(r)).toBe(SUPERSEDE_REFUSAL);
    expect(s.writes).toEqual([]);
  });

  test("a page that exists only in another readable source is refused", async () => {
    const s = setup();
    // In the shared KB, which this turn reads, but not in its write source.
    await s.brain.call("put_page", { slug: "team/fact", content: "---\ntype: team-fact\n---\nx" }, { clientId: "x", sourceId: SHARED_SOURCE, allowedSources: [SHARED_SOURCE] });
    expect(resolveBrainScope({ ...s.gate, kbSources: [] }).allowedSources).toContain(SHARED_SOURCE);
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/new", content: "New", summary: "s", type: "outcome", supersedes: "team/fact" }] }, s.deps);
    expect(text(r)).toBe(SUPERSEDE_REFUSAL);
    expect(s.writes).toEqual([]);
    expect(parseFrontmatter(s.brain.contentOf(SHARED_SOURCE, "team/fact")!).meta.superseded_by).toBeUndefined();
  });

  test("a denied card writes neither page", async () => {
    const s = setup();
    await s.brain.call("put_page", { slug: "team/old", content: "old" }, { clientId: "x", sourceId: SHARED_SOURCE, allowedSources: [SHARED_SOURCE] });
    s.deps.requestApproval = async () => ({ approved: false, by: "U0MGR" });
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "team/new", content: "new", summary: "s", type: "team-fact", supersedes: "team/old" }], target: "shared" }, s.deps);
    expect(r.isError).toBe(true);
    expect(s.writes).toEqual([]);
  });
});

describe("kb_memoize in a /1on1", () => {
  test("target:\"shared\" in an own /1on1 is refused, with no card", async () => {
    const s = setup({ lockedUser: "U0ALICE" });
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "team/x", content: "x", summary: "s" }], target: "shared" }, s.deps);
    expect(text(r)).toBe(LOCK_REFUSAL);
    expect(s.cards()).toBe(0);
    expect(s.writes).toEqual([]);
  });

  test("target:\"mine\" in an own /1on1 still lands in user-<id>", async () => {
    const s = setup({ lockedUser: "U0ALICE" });
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/x", content: "x", summary: "s", type: "person-note" }], target: "mine" }, s.deps);
    expect(r.isError).toBeUndefined();
    expect(s.writes.map((w) => w.scope.sourceId)).toEqual([userSourceId("U0ALICE")]);
  });

  test("a manager in someone else's /1on1: the default write (the agent's slice) and shared are refused", async () => {
    for (const target of [undefined, "shared" as const]) {
      const s = setup({ lockedUser: "U0BOB", isManager: true });
      const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/x", content: "x", summary: "s" }], ...(target ? { target } : {}) }, s.deps);
      expect(text(r)).toBe(LOCK_REFUSAL);
      expect(s.writes).toEqual([]);
    }
  });
});

describe("kb_memoize page checks", () => {
  test("a composePage refusal writes nothing from the batch", async () => {
    const s = setup();
    const r = await brainHandlers.kb_memoize({ pages: [
      { slug: "notes/a", content: "fine", summary: "s" },
      { slug: "notes/b", content: "x", summary: "s", type: "commitment", fields: { status: "open" } },
    ] }, s.deps);
    expect(text(r)).toContain("beneficiary");
    expect(s.writes).toEqual([]);
  });

  test("a credential-like value is refused", async () => {
    const s = setup();
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/a", content: "api_key=abcd1234", summary: "s" }] }, s.deps);
    expect(text(r)).toBe("refused: page contains a credential-like value");
    expect(s.writes).toEqual([]);
  });
});
