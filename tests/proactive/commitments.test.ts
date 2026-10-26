/**
 * The commitment index (phase E, spec §10.1): due parsing, the repo, the
 * indexer, and the write hooks in kb_memoize and the pass memoize.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Commitments from "../../src/db/commitments";
import { composePage } from "../../src/knowledge/memory-pages";
import { brainHandlers, type BrainToolDeps } from "../../src/knowledge/mcp-tools";
import type { GateInput } from "../../src/knowledge/gated-dispatch";
import { resetStandingGrants } from "../../src/knowledge/gated-dispatch";
import { agentSourceId, resolveBrainScope, userSourceId } from "../../src/knowledge/scope";
import { indexCommitment, indexWritten, runAsOf } from "../../src/proactive/commitment-index";
import { parseDue, parseThread } from "../../src/proactive/due";
import { passHandlers, type PassToolContext } from "../../src/background/pass-tools";
import { fakeBrain } from "../memory/fake-brain";

const AGENT = "AGENT1";
const TEAM = "T0TEAM";
const NOW = new Date("2026-10-26T10:00:00Z");
const O = { pollMinutes: 15, expireHours: 24 };

beforeAll(() => {
  process.env.SLAUDE_AGENT_ID ??= AGENT;
});
beforeEach(async () => {
  resetStandingGrants();
  await db.run("DELETE FROM commitments");
});

const commitment = (fields: Record<string, string>, extra: { supersedes?: string } = {}) => {
  const c = composePage({ slug: extra.supersedes ? "commitments/deploy-done" : "commitments/deploy", content: "Tell Alice when the deploy is out.", type: "commitment", fields, ...extra }, NOW);
  if ("error" in c) throw new Error(c.error);
  return c.content;
};
const OPEN = { promiser: AGENT, beneficiary: "U0ALICE", thread: "C0CHAN:1700000000.000100", due: "after the deploy", check: "deploy status", on_no_change: "silent", status: "open" };

describe("parseDue / parseThread", () => {
  test("an instant with an offset or Z is a time", () => {
    expect(parseDue("2026-11-02T09:00:00+07:00", NOW, O)).toEqual({ kind: "time", nextCheckAt: Date.parse("2026-11-02T02:00:00Z"), expiresAt: Date.parse("2026-11-03T02:00:00Z") });
    expect(parseDue("2026-11-02T09:00Z", NOW, O)?.kind).toBe("time");
  });

  test("anything else is an event polled from when it was written", () => {
    expect(parseDue("after the deploy", NOW, O)).toEqual({ kind: "event", nextCheckAt: NOW.getTime() + 15 * 60_000, expiresAt: NOW.getTime() + 24 * 3_600_000 });
    expect(parseDue("2026-11-02T09:00:00", NOW, O)?.kind).toBe("event");
    expect(parseDue("2026-13-45T99:99Z", NOW, O)?.kind).toBe("event");
  });

  test("no due is null", () => {
    expect(parseDue(undefined, NOW, O)).toBeNull();
    expect(parseDue("  ", NOW, O)).toBeNull();
  });

  test("thread is <channel>:<ts>", () => {
    expect(parseThread("C0CHAN:1700000000.000100")).toEqual({ channelId: "C0CHAN", threadTs: "1700000000.000100" });
    expect(parseThread("general:1.2")).toBeNull();
    expect(parseThread(undefined)).toBeNull();
  });
});

describe("indexCommitment", () => {
  const base = { agentId: AGENT, source: agentSourceId(AGENT), slug: "commitments/deploy", personaId: "default", teamId: TEAM, runAs: null, allowedThreads: ["C0CHAN:1700000000.000100"], writtenAt: NOW };

  test("an open commitment is indexed, idempotently", async () => {
    expect(await indexCommitment({ ...base, content: commitment(OPEN) })).toBe("indexed");
    expect(await indexCommitment({ ...base, content: commitment(OPEN) })).toBe("indexed");
    const rows = await Commitments.due(AGENT, NOW.getTime() + 60 * 60_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channelId: "C0CHAN", threadTs: "1700000000.000100", beneficiary: "U0ALICE", dueKind: "event", checkText: "deploy status", onNoChange: "silent", status: "open", teamId: TEAM, runAs: null });
    expect(await Commitments.due(AGENT, NOW.getTime())).toEqual([]);
  });

  test("a done page superseding the open one closes it", async () => {
    await indexCommitment({ ...base, content: commitment(OPEN) });
    const done = commitment({ ...OPEN, status: "done" }, { supersedes: "commitments/deploy" });
    expect(await indexCommitment({ ...base, slug: "commitments/deploy-done", content: done })).toBe("closed");
    expect((await Commitments.get({ agentId: AGENT, source: base.source, slug: "commitments/deploy" }))?.status).toBe("done");
    // Nothing left to close.
    expect(await indexCommitment({ ...base, slug: "commitments/deploy-done", content: done })).toBe("ignored");
  });

  test("a rewrite never reopens a finished promise, and keeps the schedule unless the due changed", async () => {
    const k = { agentId: AGENT, source: base.source, slug: base.slug };
    await indexCommitment({ ...base, content: commitment(OPEN) });
    const first = (await Commitments.get(k))!;
    await Commitments.markChecked(k, NOW.getTime() + 1, first.nextCheckAt + 1);
    // Re-saved a day later with the same due: same expiry, checks kept.
    await indexCommitment({ ...base, writtenAt: new Date(NOW.getTime() + 86_400_000), content: commitment(OPEN) });
    expect(await Commitments.get(k)).toMatchObject({ expiresAt: first.expiresAt, checks: 1, nextCheckAt: first.nextCheckAt + 1 });
    // A new due: rescheduled from the new write, checks reset.
    const later = new Date(NOW.getTime() + 3_600_000);
    await indexCommitment({ ...base, writtenAt: later, content: commitment({ ...OPEN, due: "after the review" }) });
    expect(await Commitments.get(k)).toMatchObject({ dueText: "after the review", checks: 0, expiresAt: later.getTime() + 24 * 3_600_000 });
    // Done, then re-saved open: stays done.
    await Commitments.close(k, "done");
    await indexCommitment({ ...base, content: commitment(OPEN) });
    expect((await Commitments.get(k))!.status).toBe("done");
  });

  test("a mention-shaped beneficiary is read as its id; close-in-one-line is kept", async () => {
    await indexCommitment({ ...base, content: commitment({ ...OPEN, beneficiary: "<@U0ALICE|alice>", on_no_change: "close-in-one-line" }) });
    expect((await Commitments.get({ agentId: AGENT, source: base.source, slug: base.slug }))).toMatchObject({ beneficiary: "U0ALICE", onNoChange: "close-in-one-line" });
  });

  test("no thread, no due, no beneficiary id, another type or status: ignored", async () => {
    expect(await indexCommitment({ ...base, content: commitment({ ...OPEN, thread: "somewhere" }) })).toBe("ignored");
    const { due: _d, ...noDue } = OPEN;
    expect(await indexCommitment({ ...base, content: commitment(noDue) })).toBe("ignored");
    expect(await indexCommitment({ ...base, content: commitment({ ...OPEN, beneficiary: "alice" }) })).toBe("ignored");
    expect(await indexCommitment({ ...base, content: "---\ntype: outcome\n---\nx" })).toBe("ignored");
    expect(await indexCommitment({ ...base, content: "---\ntype: commitment\nstatus: maybe\n---\nx" })).toBe("ignored");
    expect(await Commitments.due(AGENT, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  test("a commitment naming a thread the write did not come from is never scheduled", async () => {
    expect(await indexCommitment({ ...base, allowedThreads: ["C0OTHER:1.1"], content: commitment(OPEN) })).toBe("ignored");
    expect(await indexCommitment({ ...base, allowedThreads: [], content: commitment(OPEN) })).toBe("ignored");
    expect(await Commitments.due(AGENT, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  test("indexWritten logs and carries on when a write fails", async () => {
    const orig = Commitments.upsertOpen;
    // A broken page body still never throws out of indexWritten.
    await indexWritten([{ slug: "x", content: "---\ntype: commitment\nstatus: open\n", source: base.source }], base);
    expect(orig).toBe(Commitments.upsertOpen);
  });

  test("runAsOf names the person only for their own user slice", () => {
    expect(runAsOf({ sourceId: userSourceId("U0ALICE"), clientId: "U0ALICE" })).toBe("U0ALICE");
    expect(runAsOf({ sourceId: userSourceId("U0ALICE"), clientId: "U0BOB" })).toBeNull();
    expect(runAsOf({ sourceId: agentSourceId(AGENT), clientId: AGENT })).toBeNull();
  });
});

describe("write hooks", () => {
  test("kb_memoize in Alice's /1on1 indexes the commitment to run as Alice", async () => {
    const brain = fakeBrain();
    const g: GateInput = {
      userId: "U0ALICE", teamId: TEAM, interactive: true, origin: "slack", lockedUser: "U0ALICE",
      channelTrust: "trusted", isManager: false, agentId: AGENT, threadKey: "C0CHAN:1.1",
      turnSenders: [{ userId: "U0ALICE", teamId: TEAM, origin: "slack" }],
    };
    const deps: BrainToolDeps = {
      scope: () => resolveBrainScope({ ...g, kbSources: [] }),
      gate: () => g,
      managers: () => ["U0MGR"],
      requestApproval: async () => ({ approved: true, by: "U0MGR" }),
      call: brain.call,
      onWritten: (pages, scope) => indexWritten(pages, { agentId: AGENT, personaId: "default", teamId: TEAM, runAs: runAsOf(scope), allowedThreads: ["C0CHAN:1700000000.000100"], writtenAt: NOW }),
    };
    const r = await brainHandlers.kb_memoize(
      { pages: [{ slug: "commitments/deploy", content: "Tell Alice when it ships.", summary: "promise", type: "commitment", fields: OPEN }] },
      deps,
    );
    expect(r.isError).toBeFalsy();
    const row = await Commitments.get({ agentId: AGENT, source: userSourceId("U0ALICE"), slug: "commitments/deploy" });
    expect(row).toMatchObject({ runAs: "U0ALICE", status: "open" });
  });

  test("a throwing hook never fails the write", async () => {
    const brain = fakeBrain();
    const g: GateInput = {
      userId: "U0ALICE", teamId: TEAM, interactive: true, origin: "slack", lockedUser: null,
      channelTrust: "trusted", isManager: false, agentId: AGENT, threadKey: "C0CHAN:1.1",
    };
    const r = await brainHandlers.kb_memoize(
      { pages: [{ slug: "notes/x", content: "x", summary: "x" }] },
      {
        scope: () => resolveBrainScope({ ...g, kbSources: [] }),
        gate: () => g,
        managers: () => [],
        requestApproval: async () => ({ approved: true, by: "U0MGR" }),
        call: brain.call,
        onWritten: () => {
          throw new Error("index down");
        },
      },
    );
    expect(r.isError).toBeFalsy();
  });

  test("a pass's memoize reports what it wrote", async () => {
    const brain = fakeBrain();
    const seen: string[] = [];
    const ctx: PassToolContext = {
      scope: { kind: "user", userId: "U0ALICE", teamId: TEAM },
      agentId: AGENT,
      kbSources: [],
      transcripts: [],
      call: brain.call,
      now: () => NOW,
      onWritten: (pages) => {
        seen.push(...pages.map((p) => `${p.source}/${p.slug}`));
        throw new Error("ignored");
      },
    };
    const r = await passHandlers.memoize({ pages: [{ slug: "commitments/deploy", content: "x", type: "commitment", fields: OPEN }] }, ctx);
    expect(r.isError).toBeFalsy();
    expect(seen).toEqual([`${userSourceId("U0ALICE")}/commitments/deploy`]);
  });
});
