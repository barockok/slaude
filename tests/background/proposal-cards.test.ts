/**
 * Proposal cards (spec §9.1 "Approvals in background passes"; Task 9 rulings
 * A, C, D): who may decide, one decision across clicks and replicas, the
 * write through the gated brain path with the approver as the actor, a
 * person's proposals only in that person's DM, and Restore for a retired skill.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, paths } from "../../src/config/home";
import { db } from "../../src/db/schema";
import * as Proposals from "../../src/db/proposals";
import {
  approveActionId,
  cardActionsBlockId,
  cardPoster,
  decideProposal,
  NO_APP_REFUSAL,
  proposalBlocks,
  postPersonProposals,
  proposalWrite,
  registerProposalActions,
  rejectActionId,
  restoreActionId,
  restoreRetiredSkill,
  type Block,
  type CardPost,
  type DecideDeps,
} from "../../src/background/proposal-cards";
import { deliverRunProposals, runNightlyReview, type NightlyDeps } from "../../src/background/passes/nightly-review";
import type { ActionHandler } from "../../src/gateway/core/transport";
import { agentSourceId, SHARED_SOURCE, userSourceId } from "../../src/knowledge/scope";
import * as Sessions from "../../src/db/sessions";
import { conversationSlug } from "../../src/memory/brain-provider";
import { skillOps } from "../../src/skills/mcp-tools";
import { discoverSkills } from "../../src/skills/loader";
import { fakeBrain } from "./fake-brain";
import { runDigest } from "../../src/background/digest";
import { passHandlers } from "../../src/background/pass-tools";
import { CONVERSATION_REFUSAL, LESSONS_PAGE_REFUSAL, LESSONS_REFUSAL, PROFILE_PAGE_REFUSAL, SLUG_SEGMENT_REFUSAL } from "../../src/background/proposal-payload";
import { CREDENTIAL_REFUSAL } from "../../src/knowledge/memory-pages";

const AGENT = "U0AGENT";
const MANAGER = "U0MANAGER";
const BACKUP = "U0BACKUP";
const ALICE = "U0ALICE";
const BOB = "U0BOB";
const NOW = Date.parse("2026-10-26T10:00:00Z");
const DAY = 86_400_000;

let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  ensureHome();
  if (existsSync(paths.skills)) rmSync(paths.skills, { recursive: true, force: true });
  mkdirSync(paths.skills, { recursive: true });
  await db.run("DELETE FROM proposals");
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  warnSpy.mockRestore();
});

const fact = { summary: "Who owns deploys", pages: [{ slug: "team/deploys", content: "The platform team owns deploys.", type: "team-fact", confidence: "told", source: "thread" }] };

const teamFact = () => Proposals.insert({ agentId: AGENT, kind: "team-fact", toKind: "manager", toUser: null, scope: "agent", payload: fact, createdAt: NOW - DAY });
const promote = (user = ALICE, payload: Record<string, unknown> = { summary: "Share the runbook", pages: [{ slug: "runbooks/db", content: "Restart the replica first.", type: "investigation" }] }) =>
  Proposals.insert({ agentId: AGENT, kind: "promote", toKind: "person", toUser: user, scope: `user:${user}`, payload, createdAt: NOW - DAY });

function setup(over: Partial<DecideDeps> = {}) {
  const brain = fakeBrain();
  const deps: DecideDeps = { managers: () => [MANAGER, BACKUP], call: brain.call, now: () => new Date(NOW), ...over };
  const puts = (source: string) => brain.calls.filter((c) => c.name === "put_page" && c.scope.sourceId === source);
  return { brain, deps, puts };
}

describe("approving and rejecting", () => {
  test("approving a team-fact writes shared once; a second click is a no-op", async () => {
    const { deps, puts, brain } = setup();
    const id = await teamFact();
    const first = await decideProposal({ id, verb: "approve", by: MANAGER }, deps);
    expect(first).toEqual({ ok: true, line: `Approved by <@${MANAGER}>; written to shared memory` });
    expect(puts(SHARED_SOURCE).map((c) => c.params.slug)).toEqual(["team/deploys"]);
    expect(brain.pages.get(SHARED_SOURCE)!.get("team/deploys")!.content).toContain("The platform team owns deploys.");
    const p = (await Proposals.get(id))!;
    expect([p.status, p.decidedBy]).toEqual(["approved", MANAGER]);

    const second = await decideProposal({ id, verb: "approve", by: BACKUP }, deps);
    expect(second.ok).toBe(false);
    expect(puts(SHARED_SOURCE).length).toBe(1);
    expect((await Proposals.get(id))!.decidedBy).toBe(MANAGER);
  });

  test("two replicas clicking at once: one decision, one write", async () => {
    const { deps, puts } = setup();
    const id = await teamFact();
    const r = await Promise.all([decideProposal({ id, verb: "approve", by: MANAGER }, deps), decideProposal({ id, verb: "approve", by: BACKUP }, deps)]);
    expect(r.filter((x) => x.ok).length).toBe(1);
    expect(puts(SHARED_SOURCE).length).toBe(1);
  });

  test("only the manager or backup decides a manager proposal", async () => {
    const { deps, puts } = setup();
    const id = await teamFact();
    const r = await decideProposal({ id, verb: "approve", by: ALICE }, deps);
    expect(r.ok).toBe(false);
    expect((await Proposals.get(id))!.status).toBe("open");
    expect(puts(SHARED_SOURCE).length).toBe(0);
    expect((await decideProposal({ id, verb: "approve", by: BACKUP }, deps)).ok).toBe(true);
  });

  test("someone other than the person clicking a promote proposal is refused, the manager included", async () => {
    const { deps, puts } = setup();
    const id = await promote();
    for (const by of [BOB, MANAGER, BACKUP]) {
      const r = await decideProposal({ id, verb: "approve", by }, deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.text).toContain("only the person it is for");
      expect((await decideProposal({ id, verb: "reject", by }, deps)).ok).toBe(false);
    }
    expect((await Proposals.get(id))!.status).toBe("open");
    expect(puts(SHARED_SOURCE).length).toBe(0);
    // The person approves: nothing is written; it becomes the manager's proposal.
    const r = await decideProposal({ id, verb: "approve", by: ALICE }, deps);
    expect(r).toEqual({ ok: true, line: `Approved by <@${ALICE}>; sent to the manager, who decides whether it goes into shared memory` });
    expect(puts(SHARED_SOURCE).length).toBe(0);
    expect((await Proposals.get(id))!.decidedBy).toBe(ALICE);
  });

  test("a person's shared promotion needs the manager too: forwarded with the same pages, written only on the manager's approval", async () => {
    const { deps, puts } = setup();
    const id = await promote();
    expect((await decideProposal({ id, verb: "approve", by: ALICE }, deps)).ok).toBe(true);
    const [fwd] = await Proposals.listOpen(AGENT, "manager");
    expect(fwd).toMatchObject({ kind: "promote", toKind: "manager", toUser: null, scope: `user:${ALICE}` });
    expect(fwd!.payload).toMatchObject({ target: "shared", promotedFrom: id, pages: [{ slug: "runbooks/db", content: "Restart the replica first.", type: "investigation" }] });
    expect(await Proposals.listOpen(AGENT, "person", ALICE)).toEqual([]);
    // The person cannot approve the forwarded one; the manager writes shared.
    expect((await decideProposal({ id: fwd!.id, verb: "approve", by: ALICE }, deps)).ok).toBe(false);
    expect(puts(SHARED_SOURCE).length).toBe(0);
    expect((await decideProposal({ id: fwd!.id, verb: "approve", by: MANAGER }, deps)).ok).toBe(true);
    expect(puts(SHARED_SOURCE).map((c) => c.params.slug)).toEqual(["runbooks/db"]);
    // A second click on the person's card changes nothing and forwards nothing more.
    expect((await decideProposal({ id, verb: "approve", by: ALICE }, deps)).ok).toBe(false);
    expect((await Proposals.listOpen(AGENT, "manager")).length).toBe(0);
  });

  test("the card names whose consent a forwarded promotion carries", async () => {
    const { deps } = setup();
    const id = await promote();
    await decideProposal({ id, verb: "approve", by: ALICE }, deps);
    const [fwd] = await Proposals.listOpen(AGENT, "manager");
    expect(JSON.stringify(proposalBlocks(fwd!))).toContain(`<@${ALICE}> agreed to share this`);
    // A pass's own manager proposal (scope agent) claims no one's consent.
    const own = (await Proposals.get(await teamFact()))!;
    expect(JSON.stringify(proposalBlocks(own))).not.toContain("agreed to share");
  });

  test("a promote naming the agent's slice writes there, never a person's slice or profile", async () => {
    const { deps, brain } = setup();
    const id = await promote(ALICE, { summary: "s", target: "agent", pages: [{ slug: "notes/x", content: "x", type: "outcome" }] });
    expect((await decideProposal({ id, verb: "approve", by: ALICE }, deps)).ok).toBe(true);
    const writes = brain.calls.filter((c) => c.name === "put_page").map((c) => c.scope.sourceId);
    expect(writes).toEqual([agentSourceId(AGENT)]);
  });

  test("reject marks the row rejected and writes nothing", async () => {
    const { deps, brain } = setup();
    const id = await teamFact();
    expect(await decideProposal({ id, verb: "reject", by: MANAGER }, deps)).toEqual({ ok: true, line: `Rejected by <@${MANAGER}>` });
    expect((await Proposals.get(id))!.status).toBe("rejected");
    expect(brain.calls.length).toBe(0);
    expect((await decideProposal({ id, verb: "approve", by: MANAGER }, deps)).ok).toBe(false);
  });

  test("skill-removal and lesson-promotion only record the decision", async () => {
    const { deps, brain } = setup();
    for (const kind of ["skill-removal", "lesson-promotion"] as const) {
      const id = await Proposals.insert({ agentId: AGENT, kind, toKind: "manager", toUser: null, scope: "agent", payload: { slug: "from-git", lesson: "l" }, createdAt: NOW - DAY });
      const r = await decideProposal({ id, verb: "approve", by: MANAGER }, deps);
      expect(r).toEqual({ ok: true, line: `Approved by <@${MANAGER}>; the operator makes the change in git` });
      expect((await Proposals.get(id))!.status).toBe("approved");
    }
    expect(brain.calls.length).toBe(0);
  });

  test("an expired proposal cannot be decided", async () => {
    const { deps } = setup({ now: () => new Date(NOW + 14 * DAY) });
    const id = await teamFact();
    const r = await decideProposal({ id, verb: "approve", by: MANAGER }, deps);
    expect(r).toEqual({ ok: false, text: ":hourglass: this proposal expired" });
  });

  test("a write that fails puts the proposal back to open", async () => {
    const brain = fakeBrain();
    const deps: DecideDeps = {
      managers: () => [MANAGER],
      now: () => new Date(NOW),
      call: async (name, params, scope) => {
        if (name === "put_page") throw new Error("disk full");
        return brain.call(name, params, scope);
      },
    };
    const id = await teamFact();
    const r = await decideProposal({ id, verb: "approve", by: MANAGER }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.text).toContain("open again");
    expect((await Proposals.get(id))!.status).toBe("open");
  });

  test("with the brain not open nothing is decided", async () => {
    const { deps } = setup({ ready: () => false });
    const id = await teamFact();
    expect((await decideProposal({ id, verb: "approve", by: MANAGER }, deps)).ok).toBe(false);
    expect((await Proposals.get(id))!.status).toBe("open");
  });

  test("a payload with no page cannot be approved, only rejected", async () => {
    const { deps } = setup();
    const id = await Proposals.insert({ agentId: AGENT, kind: "team-fact", toKind: "manager", toUser: null, scope: "agent", payload: { note: "free text" }, createdAt: NOW - DAY });
    expect((await decideProposal({ id, verb: "approve", by: MANAGER }, deps)).ok).toBe(false);
    expect((await Proposals.get(id))!.status).toBe("open");
    expect(proposalWrite({ kind: "team-fact", payload: { slug: "a", content: "b" } })).toEqual({ pages: [{ slug: "a", content: "b", summary: "a", type: "team-fact" }], target: "shared" });
  });
});

describe("a person's proposals go to their DM only", () => {
  test("posted once to that person, batched; another person's proposal never rides along", async () => {
    const mine1 = await promote(ALICE);
    const mine2 = await promote(ALICE);
    const bobs = await promote(BOB, { summary: "BOB-PRIVATE", pages: [{ slug: "x", content: "y" }] });
    const managers = await teamFact();
    const sent: Array<{ channel: string; blocks: Block[] }> = [];
    const post: CardPost = async (m) => void sent.push(m);
    const n = await postPersonProposals({ agentId: AGENT, userId: ALICE, app: { apiAppId: "A0ONE", teamId: "T0TEAM" }, ids: [mine1, bobs, mine2, managers], post });
    expect(n).toBe(2);
    expect(sent.map((m) => m.channel)).toEqual([ALICE]);
    const all = JSON.stringify(sent[0]!.blocks);
    expect(all).not.toContain("BOB-PRIVATE");
    expect(all).toContain(approveActionId(mine1));
    expect(all).toContain(approveActionId(mine2));
    expect(all).not.toContain(approveActionId(bobs));
    expect(all).not.toContain(approveActionId(managers));
    // The posted cards are bound to the app they went out as; others are untouched.
    expect((await Proposals.get(mine1))!.slackAppId).toBe("A0ONE");
    expect((await Proposals.get(bobs))!.slackAppId).toBeNull();
  });

  test("the nightly review delivers each run-as pass's proposals after that pass, never an agent pass's", async () => {
    const delivered: Array<{ userId: string; ids: string[] }> = [];
    await deliverRunProposals(async (a) => void delivered.push(a), { agentId: AGENT, scope: { kind: "agent" }, proposed: ["p1"], tag: "t" });
    await deliverRunProposals(async (a) => void delivered.push(a), { agentId: AGENT, scope: { kind: "user", userId: ALICE, teamId: "T0TEAM" }, proposed: [], tag: "t" });
    await deliverRunProposals(async (a) => void delivered.push(a), { agentId: AGENT, scope: { kind: "user", userId: ALICE, teamId: "T0TEAM" }, app: { apiAppId: "A0ONE", teamId: "T0TEAM" }, proposed: ["p2", "p3"], tag: "t" });
    expect(delivered).toEqual([{ agentId: AGENT, userId: ALICE, app: { apiAppId: "A0ONE", teamId: "T0TEAM" }, ids: ["p2", "p3"] } as never]);
    // A failing delivery is logged, never thrown.
    await deliverRunProposals(async () => { throw new Error("slack down"); }, { agentId: AGENT, scope: { kind: "user", userId: ALICE, teamId: "" }, proposed: ["p4"], tag: "t" });
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain("slack down");
  });

  test("runNightlyReview hands the user pass's proposal ids to deliver", async () => {
    const brain = fakeBrain();
    const s = await Sessions.createForThread({ thread: { team_id: "T0TEAM", channel_id: "D0ALICE", thread_ts: "1.1", persona_id: "default" }, model: "m", working_dir: "/tmp" });
    await db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [NOW - DAY, s.id]);
    await Sessions.setSlackApp(s.id, "A0ONE");
    await db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [NOW - DAY, s.id]);
    const source = userSourceId(ALICE);
    const slug = conversationSlug(s.id);
    brain.seed(source, slug, "---\ntype: conversation\n---\n# c\n");
    brain.seedTimeline(source, slug, [
      { id: 1, date: "2026-10-25", created_at: "2026-10-25T12:00:00Z", summary: "s", detail: `<user><channel source="slack" user_id="${ALICE}">hello there</channel></user>\n<assistant>hi</assistant>` },
    ]);
    const delivered: unknown[] = [];
    const deps: NightlyDeps = {
      runner: {} as never,
      call: brain.call,
      listSources: async () => [source],
      run: async (spec) => ({ outcome: "ok", costUsd: 0, runId: "r", proposed: spec.scope.kind === "user" ? ["pp"] : ["pa"] }),
      deliver: async (a) => void delivered.push(a),
    };
    try {
      await runNightlyReview({ agentId: AGENT, personaId: "default", personaIds: ["default"], timeZone: "UTC", slot: "2026-10-26" }, deps);
      // Posted as the app of the run's own session.
      expect(delivered).toEqual([{ agentId: AGENT, userId: ALICE, app: { apiAppId: "A0ONE", teamId: "T0TEAM" }, ids: ["pp"] }]);
    } finally {
      await db.run("DELETE FROM sessions WHERE id = ?", [s.id]);
    }
  });
});

/** A transport that keeps registered handlers, and a click that carries the message it was on. */
function fakeTransport() {
  const handlers: Array<{ id: string | RegExp; h: ActionHandler }> = [];
  return {
    action: (id: string | RegExp, h: ActionHandler) => void handlers.push({ id, h }),
    async click(actionId: string, by: string, message?: { text: string; blocks: Block[] }, extra: Record<string, unknown> = {}) {
      const e = handlers.find((x) => (typeof x.id === "string" ? x.id === actionId : x.id.test(actionId)));
      if (!e) throw new Error(`no handler for ${actionId}`);
      const responses: Array<Record<string, unknown>> = [];
      await e.h({ ack: async () => {}, action: { action_id: actionId }, body: { user: { id: by }, ...extra, ...(message ? { message } : {}) }, respond: async (m) => void responses.push(m as Record<string, unknown>) });
      return responses;
    },
  };
}

describe("the Slack buttons", () => {
  test("the clicker is the interaction's user; a decision replaces only that card's buttons", async () => {
    const { deps, puts } = setup();
    const t = fakeTransport();
    registerProposalActions(t, deps);
    const a = await teamFact();
    const b = await teamFact();
    const message = {
      text: "digest",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "a" } },
        { type: "actions", block_id: cardActionsBlockId(a), elements: [{ type: "button", action_id: approveActionId(a) }] },
        { type: "actions", block_id: cardActionsBlockId(b), elements: [{ type: "button", action_id: approveActionId(b) }] },
      ],
    };
    const refused = await t.click(approveActionId(a), ALICE, message);
    expect(refused).toEqual([expect.objectContaining({ response_type: "ephemeral", replace_original: false })]);
    expect((await Proposals.get(a))!.status).toBe("open");

    const [r] = await t.click(approveActionId(a), MANAGER, message);
    expect(r!.replace_original).toBe(true);
    const blocks = r!.blocks as Block[];
    expect(blocks[1]).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: `Approved by <@${MANAGER}>; written to shared memory` }] });
    expect(blocks[2]!.block_id).toBe(cardActionsBlockId(b));
    expect(puts(SHARED_SOURCE).length).toBe(1);

    const again = await t.click(approveActionId(a), MANAGER, message);
    expect(again[0]!.response_type).toBe("ephemeral");
    expect(puts(SHARED_SOURCE).length).toBe(1);
    const [rej] = await t.click(rejectActionId(b), BACKUP);
    expect(rej!.response_type).toBe("ephemeral"); // no message at hand: told, not edited
    expect((await Proposals.get(b))!.status).toBe("rejected");
  });
});

describe("Restore a retired skill", () => {
  const place = (slug: string, name = slug) => {
    mkdirSync(join(paths.skills, slug), { recursive: true });
    writeFileSync(join(paths.skills, slug, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  };
  const retired = async (slug: string, name = slug) => {
    place(slug, name);
    const { id } = skillOps.retire(slug, undefined, new Date(NOW - DAY));
    return Proposals.recordSkillRetired({ agentId: AGENT, payload: { slug, retiredId: id, persona: "default", reason: "unused", uses: 0, lastUsedAt: null }, at: NOW - DAY });
  };
  const deps = { managers: () => [MANAGER, BACKUP], now: () => new Date(NOW) };

  test("the manager restores once; a second click is a no-op; nobody else can", async () => {
    const row = await retired("old-helper");
    expect((await restoreRetiredSkill({ id: row, by: ALICE }, deps)).ok).toBe(false);
    expect(discoverSkills().some((s) => s.slug === "old-helper")).toBe(false);
    expect(await restoreRetiredSkill({ id: row, by: MANAGER }, deps)).toEqual({ ok: true, line: `Restored \`old-helper\` (by <@${MANAGER}>)` });
    expect(discoverSkills().some((s) => s.slug === "old-helper")).toBe(true);
    expect((await Proposals.get(row))!.status).toBe("rejected");
    expect(await restoreRetiredSkill({ id: row, by: BACKUP }, deps)).toEqual({ ok: false, text: ":lock: this skill was already restored" });
  });

  test("refused while a live skill holds the slug; the retirement stays restorable", async () => {
    const row = await retired("greet");
    place("greet");
    const r = await restoreRetiredSkill({ id: row, by: MANAGER }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.text).toContain("a live skill");
    expect((await Proposals.get(row))!.status).toBe("approved");
    rmSync(join(paths.skills, "greet"), { recursive: true, force: true });
    expect((await restoreRetiredSkill({ id: row, by: MANAGER }, deps)).ok).toBe(true);
  });

  test("refused when the copy's frontmatter name is a built-in's (invariant 9)", async () => {
    const row = await retired("notes", "skill-authoring");
    const r = await restoreRetiredSkill({ id: row, by: MANAGER }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.text).toContain("built-in");
    expect(discoverSkills().some((s) => s.slug === "notes")).toBe(false);
    expect((await Proposals.get(row))!.status).toBe("approved");
  });

  test("the Restore button routes to it", async () => {
    const row = await retired("old-helper");
    const t = fakeTransport();
    registerProposalActions(t, { ...deps, call: fakeBrain().call });
    const [r] = await t.click(restoreActionId(row), MANAGER);
    expect(String(r!.text)).toContain("Restored");
  });
});

describe("the pass's write guards hold for proposals", () => {
  const w = (payload: Record<string, unknown>, kind: "team-fact" | "promote" = "promote") => proposalWrite({ kind, payload });
  const errorOf = (r: ReturnType<typeof w>) => ("error" in r ? r.error : null);
  test("conversation pages, the lessons pages, an over-long lessons page, a profile and a credential are refused", () => {
    expect(errorOf(w({ pages: [{ slug: "conversations/s2", content: "x" }] }))).toBe(CONVERSATION_REFUSAL);
    expect(errorOf(w({ pages: [{ slug: "/conversations/s2/summary", content: "x" }] }))).toBe(CONVERSATION_REFUSAL);
    expect(errorOf(w({ target: "agent", pages: [{ slug: "self/lessons", content: "- a", type: "lessons" }] }))).toBe(LESSONS_PAGE_REFUSAL);
    expect(errorOf(w({ target: "agent", pages: [{ slug: "self/lesson-proposals", content: "- a" }] }))).toBe(LESSONS_PAGE_REFUSAL);
    const long = Array.from({ length: 41 }, (_, i) => `- ${i}`).join("\n");
    expect(errorOf(w({ pages: [{ slug: "notes/lessons-copy", content: long, type: "lessons" }] }))).toBe(LESSONS_REFUSAL);
    expect(errorOf(w({ pages: [{ slug: "profile", content: "x", type: "profile" }] }))).toBe(PROFILE_PAGE_REFUSAL);
    expect(errorOf(w({ pages: [{ slug: "notes/x", content: "password=hunter2hunter2" }] }))).toBe(CREDENTIAL_REFUSAL);
    expect(errorOf(w({ pages: [{ slug: "notes/x", content: "fine" }] }))).toBeNull();
  });

  test("a slug with a '.' or '..' segment or a backslash is refused", () => {
    for (const slug of ["people/../conversations/s2", "x/../self/lessons", "a/./profile", "a\\b"]) {
      expect(errorOf(w({ target: "agent", pages: [{ slug, content: "x" }] }))).toBe(SLUG_SEGMENT_REFUSAL);
    }
    expect(errorOf(w({ pages: [{ slug: "notes/v1.2", content: "x" }] }))).toBeNull();
  });

  test("an approval of a stored row carrying one is refused and the row stays open", async () => {
    const { deps, brain } = setup();
    const id = await promote(ALICE, { target: "agent", pages: [{ slug: "self/lessons", content: "- a", type: "lessons" }] });
    const r = await decideProposal({ id, verb: "approve", by: ALICE }, deps);
    expect(r.ok).toBe(false);
    expect((await Proposals.get(id))!.status).toBe("open");
    expect(brain.calls.filter((c) => c.name === "put_page")).toEqual([]);
  });

  test("propose refuses it at creation, so it never becomes a card", async () => {
    const ctx = { scope: { kind: "user" as const, userId: ALICE, teamId: "T0TEAM" }, agentId: AGENT, kbSources: [], transcripts: [], call: fakeBrain().call, now: () => new Date(NOW) };
    const r = await passHandlers.propose({ kind: "promote", to: "person", payload: { pages: [{ slug: "conversations/s9", content: "x" }] } }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(CONVERSATION_REFUSAL);
    expect(await Proposals.listOpen(AGENT, "person", ALICE)).toEqual([]);
  });
});

describe("posting as the right Slack app", () => {
  function twoApps() {
    const posted: Array<{ app: string; channel: string }> = [];
    const client = (app: string) => ({ chat: { postMessage: async (m: { channel: string }) => void posted.push({ app, channel: m.channel }) } });
    const t = {
      client: client("oldest") as never,
      clientFor: (ref: { apiAppId?: string; teamId?: string }) => {
        if (ref.apiAppId === "A0ONE" && ref.teamId === "T0TEAM") return client("A0ONE") as never;
        if (ref.apiAppId === "A0TWO" && ref.teamId === "T0TEAM") return client("A0TWO") as never;
        throw new Error("no registered Slack app");
      },
      apps: async () => [{ apiAppId: "A0ONE" }, { apiAppId: "A0TWO" }] as never,
    };
    return { t, posted };
  }

  test("in a two-app workspace a card goes out as the app it names; a team id alone is refused", async () => {
    const { t, posted } = twoApps();
    const post = cardPoster(t);
    await post({ channel: ALICE, app: { apiAppId: "A0TWO", teamId: "T0TEAM" }, text: "x", blocks: [] });
    expect(posted).toEqual([{ app: "A0TWO", channel: ALICE }]);
    await expect(post({ channel: ALICE, app: { teamId: "T0TEAM" }, text: "x", blocks: [] })).rejects.toThrow(NO_APP_REFUSAL);
    await expect(post({ channel: ALICE, text: "x", blocks: [] })).rejects.toThrow(NO_APP_REFUSAL);
    expect(posted.length).toBe(1);
  });

  test("a single-app HTTP gateway lets the transport pick its one app for a post with no app id", async () => {
    const posted: Array<{ ref: unknown; channel: string }> = [];
    const t = {
      client: {} as never,
      clientFor: (ref: unknown) => ({ chat: { postMessage: async (m: { channel: string }) => void posted.push({ ref, channel: m.channel }) } }) as never,
      apps: async () => [{ apiAppId: "A0ONE" }] as never,
    };
    await cardPoster(t)({ channel: ALICE, app: { teamId: "T0TEAM" }, text: "x", blocks: [] });
    await cardPoster(t)({ channel: MANAGER, text: "x", blocks: [] });
    expect(posted).toEqual([{ ref: { teamId: "T0TEAM" }, channel: ALICE }, { ref: {}, channel: MANAGER }]);
  });

  test("a forwarded promotion is stamped by the digest's own app, and the manager's click through it is accepted", async () => {
    const { deps } = setup();
    const t = fakeTransport();
    registerProposalActions(t, deps);
    // The person's card went out as their thread's app.
    const id = await promote();
    await postPersonProposals({ agentId: AGENT, userId: ALICE, app: { apiAppId: "A0ONE", teamId: "T0TEAM" }, ids: [id], post: async () => {} });
    const [a] = await t.click(approveActionId(id), ALICE, undefined, { api_app_id: "A0ONE", team: { id: "T0TEAM" } });
    expect(String(a!.text)).toContain("sent to the manager");
    const [fwd] = await Proposals.listOpen(AGENT, "manager");
    expect([fwd!.slackAppId, fwd!.slackTeamId]).toEqual([null, null]);
    // The digest goes out as the persona's own app, a different one.
    await runDigest(
      { agentId: AGENT, personaId: "default", personaIds: ["default", "helper"], timeZone: "UTC", slot: "2026-W44", now: new Date(NOW) },
      { call: fakeBrain().call, post: async () => {}, recipient: () => MANAGER, budget: () => ({ limitUsd: 1, timeZone: "UTC" }), skills: () => [], app: async () => ({ apiAppId: "A0TWO", teamId: "T0TEAM" }) },
    );
    expect((await Proposals.get(fwd!.id))!.slackAppId).toBe("A0TWO");
    const [m] = await t.click(approveActionId(fwd!.id), MANAGER, undefined, { api_app_id: "A0TWO", team: { id: "T0TEAM" } });
    expect(String(m!.text)).toContain("written to shared memory");
  });

  test("a single-app transport posts with its one client", async () => {
    const posted: string[] = [];
    const post = cardPoster({ client: { chat: { postMessage: async (m: { channel: string }) => void posted.push(m.channel) } } as never });
    await post({ channel: MANAGER, text: "x", blocks: [] });
    expect(posted).toEqual([MANAGER]);
  });

  test("a click through another app or workspace than the card's is refused", async () => {
    const { deps } = setup();
    const t = fakeTransport();
    registerProposalActions(t, deps);
    const id = await teamFact();
    await Proposals.stampApp([id], { apiAppId: "A0ONE", teamId: "T0TEAM" });
    const wrongApp = await t.click(approveActionId(id), MANAGER, undefined, { api_app_id: "A0TWO", team: { id: "T0TEAM" } });
    expect(String(wrongApp[0]!.text)).toContain("another Slack app");
    const wrongTeam = await t.click(approveActionId(id), MANAGER, undefined, { api_app_id: "A0ONE", team: { id: "T0OTHER" } });
    expect(String(wrongTeam[0]!.text)).toContain("another Slack app");
    expect((await Proposals.get(id))!.status).toBe("open");
    const ok = await t.click(approveActionId(id), MANAGER, undefined, { api_app_id: "A0ONE", team: { id: "T0TEAM" } });
    expect(String(ok[0]!.text)).toContain("Approved");
  });
});
