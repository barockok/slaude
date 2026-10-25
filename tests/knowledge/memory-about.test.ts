/**
 * memory_about (phase C, spec §8.3 "what do you know about me?", §8.6): the
 * person's profile plus every note about them the current turn can read,
 * labelled told or inferred with dates, superseded pages left out, and only
 * for the one Slack sender whose own turn this is. Against the fake brain,
 * which scopes reads to `allowedSources` the way gbrain does.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { brainHandlers, formatMemoryAbout, MEMORY_ABOUT_REFUSAL, type BrainToolDeps, type MemoryEntry } from "../../src/knowledge/mcp-tools";
import type { GateInput } from "../../src/knowledge/gated-dispatch";
import { agentSourceId, profileSourceId, resolveBrainScope, SHARED_SOURCE, userSourceId, type BrainScope } from "../../src/knowledge/scope";
import { composePage } from "../../src/knowledge/memory-pages";
import { SUPERSEDED_TAG } from "../../src/knowledge/memory-trail";
import { fakeBrain } from "../memory/fake-brain";

const TEAM = "T0TEAM";
const AGENT = "AGENT1";
const ALICE = { userId: "U0ALICE", teamId: TEAM, origin: "slack" as const };
const BOB = { userId: "U0BOB", teamId: TEAM, origin: "slack" as const };

beforeAll(() => {
  process.env.SLAUDE_AGENT_ID ??= AGENT;
});

const page = (body: string, over: { type: string; confidence?: string }, day: string) => {
  const c = composePage({ slug: "x", content: body, ...over }, new Date(`${day}T12:00:00Z`));
  if ("error" in c) throw new Error(c.error);
  return c.content;
};

type Brain = ReturnType<typeof fakeBrain>;
const put = (b: Brain, source: string, slug: string, content: string) =>
  b.call("put_page", { slug, content }, { clientId: "seed", sourceId: source, allowedSources: [source] });
const tag = (b: Brain, source: string, slug: string) =>
  b.call("add_tag", { slug, tag: SUPERSEDED_TAG }, { clientId: "seed", sourceId: source, allowedSources: [source] });

/** Alice's memory across every source: profile, agent note, /1on1 note, team fact; plus Bob's. */
async function seed(b: Brain) {
  await put(b, profileSourceId(TEAM, "U0ALICE"), "profile", page("Call me Al. Terse answers.", { type: "profile" }, "2026-10-20"));
  await put(b, agentSourceId(AGENT), "people/U0ALICE", page("Prefers a diff over a description.", { type: "person-note" }, "2026-10-21"));
  await put(b, userSourceId("U0ALICE"), "people/U0ALICE", page("Worried about the release date.", { type: "person-note" }, "2026-10-22"));
  await put(b, SHARED_SOURCE, "shared/people/U0ALICE", page("Owns the billing service.", { type: "team-fact", confidence: "told" }, "2026-10-23"));
  await put(b, profileSourceId(TEAM, "U0BOB"), "profile", page("Bob wants no pings after 18:00.", { type: "profile" }, "2026-10-19"));
  await put(b, agentSourceId(AGENT), "people/U0BOB", page("Bob likes tables.", { type: "person-note" }, "2026-10-19"));
}

type Read = { name: string; slug: unknown; scope: BrainScope };

/** A turn: the live ctx (`userId`, lock, trust) builds the scope; `turnSenders` is who the running turn holds. */
function setup(brain: Brain, over: Partial<GateInput> = {}) {
  const reads: Read[] = [];
  const g: GateInput = {
    userId: "U0ALICE", teamId: TEAM, interactive: true, origin: "slack", lockedUser: null,
    channelTrust: "trusted", isManager: false, agentId: AGENT, threadKey: "C0CHAN:1.1",
    turnSenders: [ALICE], ...over,
  };
  const scope = resolveBrainScope({ ...g, kbSources: [] });
  const deps: BrainToolDeps = {
    scope: () => scope,
    gate: () => g,
    managers: () => ["U0MGR"],
    requestApproval: async () => ({ approved: true, by: "U0MGR" }),
    call: async (name, params, s) => {
      reads.push({ name, slug: params.slug, scope: s });
      return brain.call(name, params, s);
    },
  };
  return { deps, reads, scope };
}

const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

describe("memory_about for the person asking", () => {
  test("a channel turn: profile, the agent's note and the team fact, each told or inferred with its date", async () => {
    const b = fakeBrain();
    await seed(b);
    const s = setup(b);
    const r = await brainHandlers.memory_about({ userId: "U0ALICE" }, s.deps);
    expect(r.isError).toBeUndefined();
    const out = text(r);
    expect(out).toContain("[told] profile, from their profile, as of 2026-10-20 (slug profile)\nCall me Al. Terse answers.");
    expect(out).toContain("[inferred] person-note, from the agent's notes, as of 2026-10-21 (slug people/U0ALICE)\nPrefers a diff over a description.");
    expect(out).toContain("[told] team-fact, from the team knowledge base, as of 2026-10-23 (slug shared/people/U0ALICE)\nOwns the billing service.");
    // Nobody else's memory.
    expect(out).not.toContain("Bob");
  });

  test("in a channel turn, a note written into user-<id> during that person's /1on1 is NOT included", async () => {
    const b = fakeBrain();
    await seed(b);
    const s = setup(b);
    const out = text(await brainHandlers.memory_about({ userId: "U0ALICE" }, s.deps));
    expect(out).not.toContain("Worried about the release date.");
    expect(s.reads.some((r) => r.scope.allowedSources.includes(userSourceId("U0ALICE")))).toBe(false);
  });

  test("in their own /1on1 the note from their own slice is included", async () => {
    const b = fakeBrain();
    await seed(b);
    const s = setup(b, { lockedUser: "U0ALICE" });
    const out = text(await brainHandlers.memory_about({ userId: "U0ALICE" }, s.deps));
    expect(out).toContain("[inferred] person-note, from their /1on1 notes, as of 2026-10-22 (slug people/U0ALICE)\nWorried about the release date.");
    expect(out).toContain("Call me Al.");
    expect(out).toContain("Prefers a diff over a description.");
  });

  test("in someone else's /1on1 only the asker's own profile is read, never the lock owner's slice", async () => {
    const b = fakeBrain();
    await seed(b);
    await put(b, userSourceId("U0BOB"), "people/U0ALICE", page("Bob's /1on1 note about Alice.", { type: "person-note" }, "2026-10-22"));
    const s = setup(b, { lockedUser: "U0BOB" });
    const out = text(await brainHandlers.memory_about({ userId: "U0ALICE" }, s.deps));
    expect(out).toContain("Call me Al.");
    expect(out).not.toContain("Bob's /1on1 note");
    expect(out).not.toContain("Prefers a diff"); // the agent slice is not in this turn's scope
  });

  test("every read is limited to one source the turn can already read", async () => {
    const b = fakeBrain();
    await seed(b);
    const s = setup(b, { lockedUser: "U0ALICE" });
    await brainHandlers.memory_about({ userId: "U0ALICE" }, s.deps);
    expect(s.reads.length).toBeGreaterThan(0);
    for (const r of s.reads) {
      expect(["get_page", "list_pages"]).toContain(r.name);
      expect(r.scope.allowedSources).toHaveLength(1);
      expect(s.scope.allowedSources).toContain(r.scope.allowedSources[0]!);
      expect(r.scope.sourceId).toBe(r.scope.allowedSources[0]!);
    }
  });

  test("superseded pages are left out, judged per source", async () => {
    const b = fakeBrain();
    await seed(b);
    await tag(b, agentSourceId(AGENT), "people/U0ALICE");
    // The same slug tagged in the user slice does not hide the shared copy.
    await put(b, SHARED_SOURCE, "people/U0ALICE", page("Shared note on Alice.", { type: "person-note" }, "2026-10-24"));
    await tag(b, userSourceId("U0ALICE"), "people/U0ALICE");
    const s = setup(b, { lockedUser: "U0ALICE" });
    const out = text(await brainHandlers.memory_about({ userId: "U0ALICE" }, s.deps));
    expect(out).not.toContain("Prefers a diff over a description.");
    expect(out).not.toContain("Worried about the release date.");
    expect(out).toContain("Shared note on Alice.");
    expect(out).toContain("Call me Al.");
  });

  test("nothing held: says so", async () => {
    const s = setup(fakeBrain());
    const r = await brainHandlers.memory_about({ userId: "U0ALICE" }, s.deps);
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe("Nothing is recorded about U0ALICE in what this turn can read.");
  });
});

describe("memory_about refuses anyone but the person asking", () => {
  test("userId other than the speaker", async () => {
    const b = fakeBrain();
    await seed(b);
    const s = setup(b);
    const r = await brainHandlers.memory_about({ userId: "U0BOB" }, s.deps);
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(MEMORY_ABOUT_REFUSAL);
    expect(s.reads).toEqual([]);
  });

  test("mono mid-turn flip: the live ctx shows Bob, the running turn is Alice's", async () => {
    // Bob posted while Alice's turn runs: the ctx (and so the scope) is Bob's,
    // the turn's senders are still only Alice.
    const b = fakeBrain();
    await seed(b);
    const s = setup(b, { userId: "U0BOB", turnSenders: [ALICE] });
    const asBob = await brainHandlers.memory_about({ userId: "U0BOB" }, s.deps);
    expect(text(asBob)).toBe(MEMORY_ABOUT_REFUSAL);
    expect(s.reads).toEqual([]);
    // Alice asking still never sees Bob's profile, which is the one in this scope.
    const asAlice = text(await brainHandlers.memory_about({ userId: "U0ALICE" }, s.deps));
    expect(asAlice).not.toContain("Bob wants no pings");
    expect(s.reads.some((r) => r.scope.allowedSources.includes(profileSourceId(TEAM, "U0BOB")))).toBe(false);
  });

  test("unless the turn holds exactly one Slack sender: merged, cron, panel, unknown", async () => {
    const b = fakeBrain();
    await seed(b);
    for (const over of [
      { turnSenders: [ALICE, BOB] },
      { turnSenders: [{ ...ALICE, origin: "cron" as const }] },
      { turnSenders: [{ ...ALICE, origin: "panel" as const }] },
      { turnSenders: undefined },
      { turnSenders: [] },
      { interactive: false, origin: "cron" as const },
    ] satisfies Partial<GateInput>[]) {
      const s = setup(b, over);
      const r = await brainHandlers.memory_about({ userId: "U0ALICE" }, s.deps);
      expect(text(r)).toBe(MEMORY_ABOUT_REFUSAL);
      expect(s.reads).toEqual([]);
    }
  });
});

describe("memory_about reads gbrain's page record", () => {
  test("compiled_truth plus a parsed frontmatter object (as_of as a YAML date) and a superseded tag on the record", async () => {
    const s = setup(fakeBrain());
    const own = profileSourceId(TEAM, "U0ALICE");
    s.deps.call = async (name, params, scope) => {
      s.reads.push({ name, slug: params.slug, scope });
      if (name === "list_pages") return [];
      const src = scope.allowedSources[0];
      if (src === own && params.slug === "profile") {
        return { slug: "profile", compiled_truth: "Call me Al.\n", frontmatter: { type: "profile", as_of: new Date("2026-10-20T00:00:00Z"), confidence: "told" }, tags: [] };
      }
      if (src === agentSourceId(AGENT) && params.slug === "people/U0ALICE") {
        return { slug: "people/U0ALICE", compiled_truth: "Old note.", frontmatter: { type: "person-note", as_of: "2026-10-01", confidence: "inferred" }, tags: [SUPERSEDED_TAG] };
      }
      throw Object.assign(new Error("page not found"), { code: "page_not_found" });
    };
    const out = text(await brainHandlers.memory_about({ userId: "U0ALICE" }, s.deps));
    expect(out).toContain("[told] profile, from their profile, as of 2026-10-20 (slug profile)\nCall me Al.");
    expect(out).not.toContain("Old note.");
  });
});

describe("formatMemoryAbout", () => {
  test("one block per entry, profile first", () => {
    const entries: MemoryEntry[] = [
      { where: "agent", slug: "people/U0ALICE", type: "person-note", confidence: "inferred", as_of: "2026-10-21", body: "Prefers diffs.\n" },
      { where: "profile", slug: "profile", type: "profile", confidence: "told", as_of: "2026-10-20", body: "Call me Al." },
    ];
    expect(formatMemoryAbout(entries)).toBe(
      "[told] profile, from their profile, as of 2026-10-20 (slug profile)\nCall me Al.\n\n" +
        "[inferred] person-note, from the agent's notes, as of 2026-10-21 (slug people/U0ALICE)\nPrefers diffs.",
    );
  });

  test("empty", () => {
    expect(formatMemoryAbout([])).toBe("");
  });
});
