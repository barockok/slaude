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
import { SUPERSEDED_TAG, supersededSlugs } from "../../src/knowledge/memory-trail";
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
    channelTrust: "trusted", isManager: false, agentId: AGENT, threadKey: "C0CHAN:1.1",
    turnSenders: [{ userId: "U0ALICE", teamId: TEAM, origin: "slack" }], ...over,
  };
  const deps: BrainToolDeps = {
    scope: () => resolveBrainScope({ ...g, kbSources: [] }),
    gate: () => g,
    managers: () => ["U0MGR"],
    requestApproval: async () => { cards++; return { approved: true, by: "U0MGR" }; },
    call: async (name, params, scope) => {
      if (name !== "get_page" && name !== "list_pages") writes.push({ name, slug: String(params.slug), scope });
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

  test("refused unless the turn holds exactly the speaker's own Slack messages", async () => {
    const alice = { userId: "U0ALICE", teamId: TEAM, origin: "slack" };
    for (const turnSenders of [
      undefined, // unknown
      [], // nothing recorded
      [alice, { userId: "U0BOB", teamId: TEAM, origin: "slack" }], // a merged job: two initiators
      [{ userId: "U0ALICE", teamId: TEAM, origin: "cron" }, alice], // cron then Slack
      [{ ...alice, origin: "panel" }],
    ]) {
      const s = setup({ turnSenders });
      const r = await brainHandlers.kb_memoize({ pages: [profilePage], target: "profile" }, s.deps);
      expect(text(r)).toBe(PROFILE_REFUSAL);
      expect(s.writes).toEqual([]);
    }
  });

  test("the profile written is the sole sender's, not the live ctx speaker's", async () => {
    // Mono: Bob's input is running while the ctx already shows Alice's later message.
    const s = setup({ turnSenders: [{ userId: "U0BOB", teamId: TEAM, origin: "slack" }] });
    const r = await brainHandlers.kb_memoize({ pages: [profilePage], target: "profile" }, s.deps);
    expect(r.isError).toBeUndefined();
    const bob = profileSourceId(TEAM, "U0BOB");
    expect(s.writes.map((w) => w.scope.sourceId)).toEqual([bob]);
    expect(parseFrontmatter(s.brain.contentOf(bob, "profile")!).meta.source).toBe("told by U0BOB");
    expect(s.brain.contentOf(profileSourceId(TEAM, "U0ALICE"), "profile")).toBeUndefined();
    // subject is checked against the sender too
    expect(text(await brainHandlers.kb_memoize({ pages: [profilePage], target: "profile", subject: "U0ALICE" }, s.deps))).toBe(PROFILE_REFUSAL);
  });

  test("a merged job of one sender's messages may write the profile", async () => {
    const s = setup({ turnSenders: [{ userId: "U0ALICE", teamId: TEAM, origin: "slack" }] });
    const r = await brainHandlers.kb_memoize({ pages: [profilePage], target: "profile" }, s.deps);
    expect(r.isError).toBeUndefined();
  });

  test("a subject equal to the speaker is fine", async () => {
    const s = setup();
    const r = await brainHandlers.kb_memoize({ pages: [profilePage], target: "profile", subject: "U0ALICE" }, s.deps);
    expect(r.isError).toBeUndefined();
  });

  test("refused when the team is unknown, or there is no speaker", async () => {
    for (const over of [{ teamId: null, turnSenders: [{ userId: "U0ALICE", teamId: null, origin: "slack" }] }, { userId: null }]) {
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

  test("an existing page in the write source: the new page is written, then the old one is tagged, its content untouched", async () => {
    const s = setup();
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/old", content: "Old belief.\n", summary: "s", type: "outcome" }] }, s.deps);
    const before = s.brain.contentOf(mine, "notes/old");
    s.writes.length = 0;
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/new", content: "New belief.\n", summary: "s", type: "outcome", supersedes: "notes/old" }] }, s.deps);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(text(r)).superseded).toEqual(["notes/old"]);
    expect(s.writes.map((w) => [w.name, w.slug, w.scope.sourceId])).toEqual([["put_page", "notes/new", mine], ["add_tag", "notes/old", mine]]);
    expect(s.brain.contentOf(mine, "notes/old")).toBe(before);
    expect(s.brain.tagsOf(mine, "notes/old")).toEqual([SUPERSEDED_TAG]);
    expect(s.brain.tagsOf(mine, "notes/new")).toEqual([]);
    expect(parseFrontmatter(s.brain.contentOf(mine, "notes/new")!).meta.supersedes).toBe("notes/old");
  });

  test("supersededSlugs reads the tag one source at a time", async () => {
    const s = setup();
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/old", content: "Old", summary: "s", type: "outcome" }] }, s.deps);
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/new", content: "New", summary: "s", type: "outcome", supersedes: "notes/old" }] }, s.deps);
    const scope = resolveBrainScope({ ...s.gate, kbSources: [] });
    expect([...(await supersededSlugs(s.brain.call, scope, [mine]))]).toEqual(["notes/old"]);
    expect([...(await supersededSlugs(s.brain.call, scope, [SHARED_SOURCE]))]).toEqual([]);
  });

  test("a page cannot supersede itself, or a page the same call writes", async () => {
    const s = setup();
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/x", content: "x", summary: "s", type: "outcome" }] }, s.deps);
    s.writes.length = 0;
    expect(text(await brainHandlers.kb_memoize({ pages: [{ slug: "notes/x", content: "y", summary: "s", type: "outcome", supersedes: "notes/x" }] }, s.deps)))
      .toBe("refused: a page cannot supersede itself");
    expect(text(await brainHandlers.kb_memoize({ pages: [
      { slug: "notes/x", content: "y", summary: "s", type: "outcome" },
      { slug: "notes/z", content: "z", summary: "s", type: "outcome", supersedes: "notes/x" },
    ] }, s.deps))).toBe("refused: a page cannot supersede a page written in the same call");
    expect(s.writes).toEqual([]);
    expect(s.brain.tagsOf(mine, "notes/x")).toEqual([]);
  });

  test("writing a superseded slug again makes it current: its superseded tag is removed", async () => {
    const s = setup();
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/old", content: "Old", summary: "s", type: "outcome" }] }, s.deps);
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/new", content: "New", summary: "s", type: "outcome", supersedes: "notes/old" }] }, s.deps);
    expect(s.brain.tagsOf(mine, "notes/old")).toEqual([SUPERSEDED_TAG]);
    s.writes.length = 0;
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/old", content: "Rewritten", summary: "s", type: "outcome" }] }, s.deps);
    expect(r.isError).toBeUndefined();
    expect(s.writes.map((w) => [w.name, w.slug])).toEqual([["put_page", "notes/old"], ["remove_tag", "notes/old"]]);
    expect(s.brain.tagsOf(mine, "notes/old")).toEqual([]);
    const scope = resolveBrainScope({ ...s.gate, kbSources: [] });
    expect([...(await supersededSlugs(s.brain.call, scope, [mine]))]).toEqual([]);
    // A page that was never tagged gets no remove_tag call.
    s.writes.length = 0;
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/new", content: "Newer", summary: "s", type: "outcome" }] }, s.deps);
    expect(s.writes.map((w) => w.name)).toEqual(["put_page"]);
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
    expect(s.brain.tagsOf(SHARED_SOURCE, "team/fact")).toEqual([]);
  });

  test("a shared write that supersedes says so on the card; a denied card writes and tags nothing", async () => {
    const s = setup();
    await s.brain.call("put_page", { slug: "team/old", content: "old" }, { clientId: "x", sourceId: SHARED_SOURCE, allowedSources: [SHARED_SOURCE] });
    const asked: string[] = [];
    s.deps.requestApproval = async (r) => { asked.push(r.summary); return { approved: false, by: "U0MGR" }; };
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "team/new", content: "new", summary: "newer fact", type: "team-fact", supersedes: "team/old" }], target: "shared" }, s.deps);
    expect(r.isError).toBe(true);
    expect(asked).toEqual([`KB write → shared: team/new — newer fact (and tags team/old as ${SUPERSEDED_TAG})`]);
    expect(s.writes).toEqual([]);
    expect(s.brain.tagsOf(SHARED_SOURCE, "team/old")).toEqual([]);
  });

  test("a tag step that fails after the new page landed names both slugs", async () => {
    const s = setup();
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/old", content: "Old", summary: "s", type: "outcome" }] }, s.deps);
    const inner = s.deps.call!;
    s.deps.call = async (name, params, scope) => {
      if (name === "add_tag") throw new Error("engine went away");
      return inner(name, params, scope);
    };
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/new", content: "New", summary: "s", type: "outcome", supersedes: "notes/old" }] }, s.deps);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("kb_memoize wrote notes/new, but tagging notes/old as superseded failed (engine went away)");
    expect(s.brain.contentOf(mine, "notes/new")).toBeDefined();
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

  test("a background turn in a locked thread is refused too", async () => {
    const s = setup({ lockedUser: "U0ALICE", userId: null });
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/x", content: "x", summary: "s" }] }, s.deps);
    expect(text(r)).toBe(LOCK_REFUSAL);
    expect(s.writes).toEqual([]);
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
    expect(text(r)).toBe("refused: page contains a credential-like value; remove that value and try again");
    expect(s.writes).toEqual([]);
  });
});
