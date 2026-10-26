/**
 * Feedback on proactive posts (phase E, spec §10.5): replies and reactions are
 * outcomes; "stop" / "not this" mutes that post's topic in the replier's own
 * profile, that topic only; a reaction never mutes; other threads are ignored.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Posts from "../../src/db/proactive-posts";
import { composePage, parseFrontmatter } from "../../src/knowledge/memory-pages";
import { agentSourceId, profileSourceId, userSourceId, type BrainScope } from "../../src/knowledge/scope";
import { onProactiveReaction, onProactiveReply, stopPhrase, type FeedbackDeps } from "../../src/proactive/feedback";
import { prefsFromProfile } from "../../src/proactive/prefs";
import { buildManifest } from "../../src/cli/manifest";
import { fakeBrain } from "../memory/fake-brain";

const AGENT = "U0AGENT";
const TEAM = "T0TEAM";
const NOW = new Date("2026-10-26T12:00:00Z");
const scopeOf = (source: string): BrainScope => ({ clientId: "t", sourceId: source, allowedSources: [source] });

function deps() {
  const brain = fakeBrain();
  const replies: { channel: string; threadTs: string; text: string }[] = [];
  const d: FeedbackDeps = { call: brain.call, now: () => NOW, reply: async (channel, threadTs, text) => void replies.push({ channel, threadTs, text }) };
  return { brain, replies, d };
}

async function post(over: Partial<Parameters<typeof Posts.recordPost>[0]> = {}) {
  const base = { agentId: AGENT, audience: "person" as const, recipient: "U0ALICE", topic: "deploys", textHash: "h", channelId: "D0ALICE", messageTs: "1700000000.000100", teamId: TEAM, postedAt: NOW.getTime() };
  const p = { ...base, ...over };
  return { id: await Posts.recordPost(p), ...p };
}

async function readProfile(b: ReturnType<typeof fakeBrain>, user: string) {
  const r = (await b.call("get_page", { slug: "profile" }, scopeOf(profileSourceId(TEAM, user)))) as { content: string } | null;
  return r ? parseFrontmatter(r.content) : null;
}

beforeEach(async () => {
  await db.run("DELETE FROM proactive_posts");
});

describe("stopPhrase", () => {
  test("stop, not this, mute, no more — after any mention", () => {
    for (const t of ["stop", "Stop pinging me", "not this one", "<@U0AGENT> mute", "no more of these"]) expect(stopPhrase(t)).toBe(true);
    for (const t of ["thanks!", "don't stop", "nonstop", "stopwatch is broken", ""]) expect(stopPhrase(t)).toBe(false);
  });
});

describe("onProactiveReply", () => {
  test('"stop" from the addressed person mutes only that topic and keeps the rest of their profile', async () => {
    const h = deps();
    const src = profileSourceId(TEAM, "U0ALICE");
    const page = composePage({ slug: "profile", content: "Call me Al.", type: "profile", subject: "U0ALICE", fields: { pings: "yes", topics: "deploys, oncall", mutes: "billing" } }, NOW);
    if ("error" in page) throw new Error(page.error);
    await h.brain.call("put_page", { slug: "profile", content: page.content }, scopeOf(src));
    const p = await post();
    const r = await onProactiveReply({ channel: "D0ALICE", threadTs: p.messageTs, userId: "U0ALICE", teamId: TEAM, text: "stop please" }, h.d);
    expect(r).toBe("muted");
    const prof = await readProfile(h.brain, "U0ALICE");
    const prefs = prefsFromProfile(prof!.meta);
    expect(prefs).toMatchObject({ pings: true, topics: ["deploys", "oncall"], mutes: ["billing", "deploys"] });
    expect(prof!.meta.quote).toBe("stop please");
    expect(prof!.meta.source).toBe("told by U0ALICE");
    expect(prof!.body).toBe("Call me Al.");
    expect(h.replies).toEqual([{ channel: "D0ALICE", threadTs: p.messageTs, text: "Got it, I'll stop pinging you about deploys." }]);
    // The outcome is in Alice's own slice, and says only what happened.
    const out = (await h.brain.call("get_page", { slug: `outcomes/proactive-${p.id}` }, scopeOf(userSourceId("U0ALICE")))) as { content: string };
    expect(out.content).toContain("asked to stop");
    expect(out.content).not.toContain("please");
  });

  test('"stop" from someone else on a DM post is ignored', async () => {
    const h = deps();
    const p = await post();
    expect(await onProactiveReply({ channel: "D0ALICE", threadTs: p.messageTs, userId: "U0BOB", teamId: TEAM, text: "stop" }, h.d)).toBe("ignored");
    expect(await readProfile(h.brain, "U0BOB")).toBeNull();
  });

  test('"not this" on a channel post mutes the replier only; the outcome goes to the agent slice', async () => {
    const h = deps();
    const p = await post({ audience: "channel", recipient: "C0TEAMCHAN", channelId: "C0TEAMCHAN", topic: "flaky tests" });
    expect(await onProactiveReply({ channel: "C0TEAMCHAN", threadTs: p.messageTs, userId: "U0BOB", teamId: TEAM, text: "not this" }, h.d)).toBe("muted");
    expect(prefsFromProfile((await readProfile(h.brain, "U0BOB"))!.meta).mutes).toEqual(["flaky tests"]);
    expect(await readProfile(h.brain, "U0ALICE")).toBeNull();
    const out = await h.brain.call("get_page", { slug: `outcomes/proactive-${p.id}` }, scopeOf(agentSourceId(AGENT)));
    expect(out).not.toBeNull();
  });

  test("a plain reply writes an outcome and continues; another thread is ignored", async () => {
    const h = deps();
    const p = await post();
    expect(await onProactiveReply({ channel: "D0ALICE", threadTs: p.messageTs, userId: "U0ALICE", teamId: TEAM, text: "thanks, looking" }, h.d)).toBe("outcome");
    expect(h.replies).toEqual([]);
    expect(await onProactiveReply({ channel: "D0ALICE", threadTs: "1.1", userId: "U0ALICE", teamId: TEAM, text: "stop" }, h.d)).toBe("ignored");
  });

  test("no team id anywhere: a stop cannot mute, so it is recorded as a reply", async () => {
    const h = deps();
    const p = await post({ teamId: null });
    expect(await onProactiveReply({ channel: "D0ALICE", threadTs: p.messageTs, userId: "U0ALICE", teamId: null, text: "stop" }, h.d)).toBe("outcome");
  });
});

describe("onProactiveReaction", () => {
  test("a reaction writes an outcome and never mutes", async () => {
    const h = deps();
    const p = await post();
    expect(await onProactiveReaction({ channel: "D0ALICE", messageTs: p.messageTs, userId: "U0ALICE", reaction: "no_bell" }, h.d)).toBe("outcome");
    expect(await readProfile(h.brain, "U0ALICE")).toBeNull();
    const out = (await h.brain.call("get_page", { slug: `outcomes/proactive-${p.id}` }, scopeOf(userSourceId("U0ALICE")))) as { content: string };
    expect(out.content).toContain("reacted :no_bell:");
    expect(await onProactiveReaction({ channel: "D0ALICE", messageTs: p.messageTs, userId: "U0BOB", reaction: "eyes" }, h.d)).toBe("ignored");
    expect(await onProactiveReaction({ channel: "D0ALICE", messageTs: "9.9", userId: "U0ALICE", reaction: "eyes" }, h.d)).toBe("ignored");
  });
});

test("the manifest subscribes to reaction_added", () => {
  expect(buildManifest({ name: "Helper" } as never).settings.event_subscriptions.bot_events).toContain("reaction_added");
});
