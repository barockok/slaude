import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Proposals from "../../src/db/proposals";
import {
  createPassMcpServer,
  LESSONS_REFUSAL,
  passHandlers,
  passReadSources,
  passToolId,
  READ_ONLY_PASS_TOOLS,
  PROFILE_SCOPE_REFUSAL,
  QUOTE_REFUSAL,
  NO_PROFILE_REFUSAL,
  CORRECTION_SLUG_REFUSAL,
  USER_PROPOSAL_KIND_REFUSAL,
  holdsCredential,
  SHARED_REFUSAL,
  SOURCE_REFUSAL,
  type PassToolContext,
  type TranscriptTurn,
} from "../../src/background/pass-tools";
import { CREDENTIAL_REFUSAL } from "../../src/knowledge/memory-pages";
import { SLUG_SEGMENT_REFUSAL } from "../../src/background/proposal-payload";
import { agentSourceId, profileSourceId, userSourceId } from "../../src/knowledge/scope";
import { fakeBrain } from "./fake-brain";

const TEAM = "T0TEAM";
const ALICE = "U0ALICE";
const BOB = "U0BOB";
const AGENT = "U0AGENT";
const NOW = new Date("2026-10-26T03:00:00Z");
const KB = "kb-handbook";

const ALICE_PROFILE = profileSourceId(TEAM, ALICE);
const BOB_PROFILE = profileSourceId(TEAM, BOB);

const transcripts: TranscriptTurn[] = [
  { at: "2026-10-25T10:00:00Z", author: ALICE, text: "Please   call me Ali from now on, thanks." },
  { at: "2026-10-25T10:00:05Z", author: "agent", text: "Sure, I will use short replies with tables." },
  { at: "2026-10-25T10:01:00Z", author: BOB, text: "I prefer tables over prose." },
];

function ctxFor(scope: PassToolContext["scope"], brain = fakeBrain()) {
  const ctx: PassToolContext = { scope, agentId: AGENT, kbSources: [KB, "user-u0bob"], transcripts, call: brain.call, now: () => NOW };
  return { ctx, brain };
}
const alice = () => ctxFor({ kind: "user", userId: ALICE, teamId: TEAM });
const agent = () => ctxFor({ kind: "agent" });
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

/** No call touched a private slice other than `allowed`. */
function expectNoOtherPrivate(touched: Set<string>, allowed: string[]) {
  for (const s of touched) {
    if (s.startsWith("user-") || s.startsWith("profile-")) expect(allowed).toContain(s);
  }
}

beforeEach(async () => {
  await db.run("DELETE FROM proposals");
});

describe("read sources", () => {
  test("user scope: the person's user- and profile sources plus agent/shared/public/kb; kb list filtered to kb-*", () => {
    expect(passReadSources({ kind: "user", userId: ALICE, teamId: TEAM }, AGENT, [KB, "user-u0bob", BOB_PROFILE])).toEqual([
      userSourceId(ALICE), ALICE_PROFILE, agentSourceId(AGENT), "agent", "shared", "public", KB,
    ]);
  });
  test("agent scope: no user-* or profile-* source; the legacy agent source is read", () => {
    expect(passReadSources({ kind: "agent" }, AGENT, [KB, "user-u0bob"])).toEqual([agentSourceId(AGENT), "agent", "shared", "public", KB]);
  });
  test("an empty team id leaves the profile out of reads and refuses profile writes", async () => {
    const scope = { kind: "user" as const, userId: ALICE, teamId: "" };
    expect(passReadSources(scope, AGENT, [])).toEqual([userSourceId(ALICE), agentSourceId(AGENT), "agent", "shared", "public"]);
    const { ctx, brain } = ctxFor(scope);
    const r = await passHandlers.memoize({ pages: [{ slug: "profile", type: "profile", content: "x", quote: "call me Ali from now on" }] }, ctx);
    expect(text(r)).toBe(NO_PROFILE_REFUSAL);
    expect(brain.calls).toHaveLength(0);
  });

  test("an unusable user id throws", () => {
    expect(() => passReadSources({ kind: "user", userId: "", teamId: TEAM }, AGENT, [])).toThrow();
  });
});

describe("pass tools in user scope (U0ALICE)", () => {
  test("reading user-u0bob or Bob's profile is refused, without a brain call", async () => {
    const { ctx, brain } = alice();
    for (const source of ["user-u0bob", BOB_PROFILE]) {
      for (const r of [
        await passHandlers.read_pages({ slugs: ["profile"], source }, ctx),
        await passHandlers.list_pages({ source }, ctx),
        await passHandlers.search({ query: "x", source }, ctx),
      ]) {
        expect(r.isError).toBe(true);
        expect(text(r)).toBe(SOURCE_REFUSAL);
      }
    }
    expect(brain.calls).toHaveLength(0);
  });

  test("reads over every source never touch another person's slice", async () => {
    const { ctx, brain } = alice();
    brain.seed("user-u0bob", "profile", "bob secret");
    brain.seed(BOB_PROFILE, "profile", "bob profile");
    brain.seed(ALICE_PROFILE, "profile", "---\ntype: profile\n---\nname: Ali");
    const r = await passHandlers.read_pages({ slugs: ["profile"] }, ctx);
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("name: Ali");
    expect(text(r)).not.toContain("bob");
    await passHandlers.list_pages({ type: "profile" }, ctx);
    await passHandlers.search({ query: "bob" }, ctx);
    expectNoOtherPrivate(brain.touched(), [userSourceId(ALICE), ALICE_PROFILE]);
  });

  test("a memoize to shared is refused with a hint to propose", async () => {
    const { ctx, brain } = alice();
    for (const page of [
      { slug: "people/x", content: "x", type: "person-note" as const, target: "shared" as const },
      { slug: "shared/people/x", content: "x owns billing", type: "team-fact" as const },
    ]) {
      const r = await passHandlers.memoize({ pages: [page] }, ctx);
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(SHARED_REFUSAL);
      expect(text(r)).toContain("propose");
    }
    expect(brain.calls.filter((c) => c.name === "put_page")).toHaveLength(0);
  });

  test("a slug with a '.' or '..' segment or a backslash is refused before anything is written", async () => {
    const { ctx, brain } = alice();
    for (const slug of ["people/../conversations/s1", "x/../self/lessons", "./profile", "notes/./x", "notes\\x", ".."]) {
      const r = await passHandlers.memoize({ pages: [{ slug, content: "x", type: "person-note" }] }, ctx);
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(SLUG_SEGMENT_REFUSAL);
    }
    expect(brain.calls.filter((c) => c.name === "put_page")).toHaveLength(0);
    // A dot inside a segment is fine.
    expect((await passHandlers.memoize({ pages: [{ slug: "people/a.b", content: "x", type: "person-note" }] }, ctx)).isError).toBeUndefined();
  });

  test("a profile page quoting Alice's own turn is written to Alice's profile", async () => {
    const { ctx, brain } = alice();
    const r = await passHandlers.memoize(
      { pages: [{ slug: "profile", type: "profile", content: "name to use: Ali", quote: "call me Ali from now on" }] },
      ctx,
    );
    expect(r.isError).toBeUndefined();
    const put = brain.calls.find((c) => c.name === "put_page")!;
    expect(put.scope.sourceId).toBe(ALICE_PROFILE);
    expect(put.scope.allowedSources).toEqual([ALICE_PROFILE]);
    const content = put.params.content as string;
    expect(content).toContain("type: profile");
    expect(content).toContain("confidence: told");
    expect(content).toContain(`subject: "${ALICE}"`);
    expect(content).toContain(`quote: "call me Ali from now on"`);
    expect(content).toContain("name to use: Ali");
  });

  test("a correction page with Alice's quote also goes to her profile", async () => {
    const { ctx, brain } = alice();
    const r = await passHandlers.memoize(
      { pages: [{ slug: "corrections/name", type: "correction", content: "use Ali, not Alice", quote: "Please call me Ali" }] },
      ctx,
    );
    expect(r.isError).toBeUndefined();
    expect(brain.calls.find((c) => c.name === "put_page")!.scope.sourceId).toBe(ALICE_PROFILE);
  });

  test("the quote in Bob's turn, the agent's turn, or absent is refused", async () => {
    const { ctx, brain } = alice();
    for (const quote of ["I prefer tables over prose", "use short replies with tables", undefined, "Ali", "never said this at all"]) {
      const r = await passHandlers.memoize({ pages: [{ slug: "profile", type: "profile", content: "prefers tables", quote }] }, ctx);
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(QUOTE_REFUSAL);
      expect(text(r)).toBe("refused: a profile entry must quote that person's own words");
    }
    expect(brain.calls).toHaveLength(0);
  });

  test("a quote spanning two of Alice's turns, or only whitespace, is refused", async () => {
    const { ctx } = ctxFor({ kind: "user", userId: ALICE, teamId: TEAM });
    ctx.transcripts = [
      { at: "t1", author: ALICE, text: "Please call me" },
      { at: "t2", author: ALICE, text: "Ali from now on" },
    ];
    for (const quote of ["Please call me Ali from now on", "me Ali", "            ", "\n\t \n"]) {
      const r = await passHandlers.memoize({ pages: [{ slug: "profile", type: "profile", content: "x", quote }] }, ctx);
      expect(text(r)).toBe(QUOTE_REFUSAL);
    }
  });

  test("a correction page may not use slug profile", async () => {
    const { ctx } = alice();
    const r = await passHandlers.memoize({ pages: [{ slug: "profile", type: "correction", content: "x", quote: "call me Ali from now on" }] }, ctx);
    expect(text(r)).toBe(CORRECTION_SLUG_REFUSAL);
  });

  test("a profile page about someone else is refused", async () => {
    const { ctx } = alice();
    const r = await passHandlers.memoize(
      { pages: [{ slug: "profile", type: "profile", content: "x", quote: "call me Ali from now on", subject: BOB }] },
      ctx,
    );
    expect(text(r)).toBe(QUOTE_REFUSAL);
  });

  test("an ordinary page lands in user-u0alice; one refusal stops the whole batch", async () => {
    const { ctx, brain } = alice();
    const okR = await passHandlers.memoize({ pages: [{ slug: `people/${ALICE}`, type: "person-note", content: "likes tables" }] }, ctx);
    expect(okR.isError).toBeUndefined();
    // Slack ids are upper case. gbrain stores a lowercased slug but chunks under the
    // one it is sent, so a mixed-case slug fails there: memoize must send it lowercased.
    expect(brain.calls.filter((c) => c.name === "put_page").map((c) => c.params.slug)).toEqual([`people/${ALICE.toLowerCase()}`]);
    expect(brain.pages.get(userSourceId(ALICE))?.has(`people/${ALICE.toLowerCase()}`)).toBe(true);
    const bad = await passHandlers.memoize(
      { pages: [{ slug: "a", type: "outcome", content: "ok" }, { slug: "b", type: "outcome", content: "x", target: "shared" }] },
      ctx,
    );
    expect(bad.isError).toBe(true);
    expect(brain.pages.get(userSourceId(ALICE))?.has("a")).toBe(false);
  });

  test("a credential-like value is refused; read results are redacted", async () => {
    const { ctx, brain } = alice();
    const r = await passHandlers.memoize({ pages: [{ slug: "n", type: "outcome", content: "password=hunter2hunter2" }] }, ctx);
    expect(text(r)).toBe(CREDENTIAL_REFUSAL);
    brain.seed(userSourceId(ALICE), "old", "password=hunter2hunter2");
    const read = await passHandlers.read_pages({ slugs: ["old"] }, ctx);
    expect(text(read)).not.toContain("hunter2");
    const p = await passHandlers.propose({ kind: "promote", payload: { note: "password=hunter2hunter2" }, to: "person" }, ctx);
    expect(text(p)).toBe(CREDENTIAL_REFUSAL);
  });

  test("a proposal payload holding a credential as a JSON key/value, or nested, is refused", async () => {
    const { ctx } = alice();
    const payloads: Array<Record<string, unknown>> = [
      { password: "hunter2hunter2" },
      { api_key: "abcd1234efgh5678ijkl" },
      { page: { notes: [{ ok: "fine" }, { client_secret: "zz9plural9zalpha" }] } },
      { list: ["fine", "token=abcdef0123456789"] },
    ];
    for (const payload of payloads) {
      expect(holdsCredential(payload)).toBe(true);
      expect(text(await passHandlers.propose({ kind: "promote", payload, to: "person" }, ctx))).toBe(CREDENTIAL_REFUSAL);
    }
    expect(holdsCredential({ slug: "people/x", why: "owns billing", count: 3 })).toBe(false);
    expect(await Proposals.listOpen(AGENT, "person", ALICE)).toEqual([]);
  });

  test("a pass running as a person proposes only kind promote", async () => {
    const { ctx } = alice();
    for (const kind of ["team-fact", "skill-removal", "lesson-promotion"] as const) {
      expect(text(await passHandlers.propose({ kind, payload: { x: "y" }, to: "person" }, ctx))).toBe(USER_PROPOSAL_KIND_REFUSAL);
    }
  });

  test("supersede tags the older page in the same memory only", async () => {
    const { ctx, brain } = alice();
    brain.seed(userSourceId(ALICE), "people/old", "---\ntype: person-note\n---\nold");
    const r = await passHandlers.memoize({ pages: [{ slug: "people/new", type: "person-note", content: "new", supersedes: "people/old" }] }, ctx);
    expect(r.isError).toBeUndefined();
    expect(brain.pages.get(userSourceId(ALICE))!.get("people/old")!.tags.has("superseded")).toBe(true);
    const miss = await passHandlers.memoize({ pages: [{ slug: "people/n2", type: "person-note", content: "n", supersedes: "people/nope" }] }, ctx);
    expect(miss.isError).toBe(true);
  });

  test("propose with to: manager is stored as to the person", async () => {
    const { ctx } = alice();
    const r = await passHandlers.propose({ kind: "promote", payload: { slug: "people/x", content: "c", why: "useful to the team" }, to: "manager" }, ctx);
    expect(r.isError).toBeUndefined();
    const id = JSON.parse(text(r)).proposed as string;
    const row = (await Proposals.get(id))!;
    expect(row).toMatchObject({ agentId: AGENT, kind: "promote", toKind: "person", toUser: ALICE, scope: `user:${ALICE}`, status: "open" });
    expect(row.payload).toEqual({ slug: "people/x", content: "c", why: "useful to the team" });
    expect(row.createdAt).toBe(NOW.getTime());
    expect(row.expiresAt).toBe(NOW.getTime() + 14 * 24 * 60 * 60 * 1000);
  });
});

describe("pass tools in agent scope", () => {
  test("a profile write is refused", async () => {
    const { ctx, brain } = agent();
    for (const page of [
      { slug: "profile", type: "profile" as const, content: "x", quote: "call me Ali from now on" },
      { slug: "c", type: "correction" as const, content: "x", target: "profile" as const },
      { slug: "c", type: "outcome" as const, content: "x", target: "profile" as const },
    ]) {
      const r = await passHandlers.memoize({ pages: [page] }, ctx);
      expect(text(r)).toBe(PROFILE_SCOPE_REFUSAL);
    }
    expect(brain.calls).toHaveLength(0);
  });

  test("a correction page is a lesson candidate in the agent's slice, no quote needed", async () => {
    const { ctx, brain } = agent();
    const r = await passHandlers.memoize({ pages: [{ slug: "self/lesson-candidates/terse", type: "correction", content: "was told to keep replies short" }] }, ctx);
    expect(r.isError).toBeUndefined();
    const put = brain.calls.find((c) => c.name === "put_page")!;
    expect(put.scope.sourceId).toBe(agentSourceId(AGENT));
    expect(put.params.content as string).toContain("type: correction");
  });

  test("writes land in the agent's slice; reads touch no user-* or profile-* source", async () => {
    const { ctx, brain } = agent();
    const r = await passHandlers.memoize({ pages: [{ slug: "self/lesson-proposals", type: "lessons", content: "- one" }] }, ctx);
    expect(r.isError).toBeUndefined();
    expect(brain.pages.get(agentSourceId(AGENT))?.has("self/lesson-proposals")).toBe(true);
    await passHandlers.read_pages({ slugs: ["profile"] }, ctx);
    await passHandlers.list_pages({}, ctx);
    await passHandlers.search({ query: "x" }, ctx);
    expectNoOtherPrivate(brain.touched(), []);
    expect(text(await passHandlers.read_pages({ slugs: ["x"], source: userSourceId(ALICE) }, ctx))).toBe(SOURCE_REFUSAL);
  });

  test("a lessons page over 40 lines is refused; 40 is fine", async () => {
    const { ctx } = agent();
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `- lesson ${i + 1}`).join("\n");
    expect(text(await passHandlers.memoize({ pages: [{ slug: "self/lessons", type: "lessons", content: lines(41) }] }, ctx))).toBe(LESSONS_REFUSAL);
    expect((await passHandlers.memoize({ pages: [{ slug: "self/lessons", type: "lessons", content: lines(40) + "\n" }] }, ctx)).isError).toBeUndefined();
  });

  test("propose goes to the manager; to: person is refused", async () => {
    const { ctx } = agent();
    const r = await passHandlers.propose({ kind: "team-fact", payload: { slug: "shared/services/billing", content: "c", owner: ALICE }, to: "manager" }, ctx);
    const row = (await Proposals.get(JSON.parse(text(r)).proposed))!;
    expect(row).toMatchObject({ toKind: "manager", toUser: null, scope: "agent" });
    expect((await passHandlers.propose({ kind: "team-fact", payload: {}, to: "person" }, ctx)).isError).toBe(true);
  });
});

describe("slaude_pass server", () => {
  test("mounts the five pass tools plus extras, by mcp__slaude_pass__ name", () => {
    const { ctx } = agent();
    const { server, toolIds } = createPassMcpServer(ctx);
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("slaude_pass");
    expect(toolIds).toEqual(["read_pages", "list_pages", "search", "memoize", "propose"].map(passToolId));
    expect(passToolId("memoize")).toBe("mcp__slaude_pass__memoize");
  });

  test("a pass can mount only the read tools", () => {
    const { ctx } = agent();
    expect(createPassMcpServer(ctx, [], READ_ONLY_PASS_TOOLS).toolIds).toEqual(["read_pages", "list_pages", "search"].map(passToolId));
  });
});
