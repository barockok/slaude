/**
 * Keeping promises (phase E, spec §10.1): due checks go out once, into their
 * own thread, budgeted, deferred for a busy thread or the beneficiary's quiet
 * hours, polled until expiry, and told plainly when they could not be
 * confirmed. None of it consults `## Proactive`.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Commitments from "../../src/db/commitments";
import type { CommitmentRow } from "../../src/db/commitments";
import { claimSlot } from "../../src/db/background-slots";
import { STALE_CLAIM_MS } from "../../src/proactive/promises";
import { NO_PREFS, prefsFromProfile, type PingPrefs } from "../../src/proactive/prefs";
import {
  BUSY_RETRY_MS,
  checkEnvelope,
  couldNotConfirm,
  isLastCheck,
  nextLocal,
  promiseSlot,
  runDueCommitments,
  type PromiseDeps,
} from "../../src/proactive/promises";
import { __setProactiveSoulSource } from "../../src/soul/proactive";

const AGENT = "U0AGENT";
const T0 = Date.parse("2026-10-26T10:00:00Z");
const MIN = 60_000;
const POLL = 15 * MIN;
const DAY = 24 * 60 * MIN;

type Base = Omit<CommitmentRow, "status" | "checks" | "lastCheckedAt">;
const row = (over: Partial<Base> = {}): Base => ({
  agentId: AGENT,
  source: "agent-u0agent",
  slug: "commitments/deploy",
  personaId: "default",
  teamId: "T0TEAM",
  channelId: "C0CHAN",
  threadTs: "1700000000.000100",
  beneficiary: "U0ALICE",
  runAs: null,
  dueText: "after the deploy",
  dueKind: "event",
  checkText: "deploy status",
  onNoChange: "silent",
  nextCheckAt: T0,
  expiresAt: T0 + DAY,
  createdAt: T0 - POLL,
  ...over,
});

function harness(o: { busy?: boolean | "throw"; budget?: boolean; prefs?: PingPrefs; dispatchFails?: boolean; postFails?: boolean; claim?: PromiseDeps["claim"] } = {}) {
  const dispatched: { row: CommitmentRow; envelope: string; runId: string }[] = [];
  const posted: { row: CommitmentRow; text: string }[] = [];
  const dropped: string[] = [];
  let runs = 0;
  const deps: PromiseDeps = {
    timeZone: "UTC",
    prefs: async () => o.prefs ?? NO_PREFS,
    openRun: async () => (o.budget === false ? { ok: false } : { ok: true, runId: `run-${++runs}`, agentId: AGENT }),
    dropRun: async (id) => void dropped.push(id),
    transport: {
      isBusy: async () => {
        if (o.busy === "throw") throw new Error("redis blip");
        return o.busy === true;
      },
      dispatch: async (r, envelope, run) => {
        if (o.dispatchFails) throw new Error("queue down");
        dispatched.push({ row: r, envelope, runId: run.runId });
      },
      post: async (r, text) => {
        if (o.postFails) throw new Error("the thread's /1on1 lock changed");
        posted.push({ row: r, text });
      },
    },
    ...(o.claim ? { claim: o.claim } : {}),
  };
  return { deps, dispatched, posted, dropped };
}

const key = { agentId: AGENT, source: "agent-u0agent", slug: "commitments/deploy" };
const get = () => Commitments.get(key);

let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  await db.run("DELETE FROM commitments");
  await db.run("DELETE FROM background_slots");
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  __setProactiveSoulSource(null);
});

describe("helpers", () => {
  test("isLastCheck: a time promise's second check, an event's final poll", () => {
    const r = { ...row({ dueKind: "time", nextCheckAt: T0, expiresAt: T0 + DAY }), status: "open" as const, checks: 0, lastCheckedAt: null };
    expect(isLastCheck(r, T0, POLL)).toBe(false);
    expect(isLastCheck({ ...r, checks: 1 }, T0 + DAY, POLL)).toBe(true);
    const e = { ...r, dueKind: "event" as const };
    expect(isLastCheck(e, T0, POLL)).toBe(false);
    expect(isLastCheck(e, T0 + DAY - POLL, POLL)).toBe(true);
  });

  test("nextLocal finds the next local clock time", () => {
    expect(nextLocal(new Date("2026-10-26T23:30:00Z"), "UTC", 8 * 60)).toBe(Date.parse("2026-10-27T08:00:00Z"));
    expect(nextLocal(new Date("2026-10-26T07:00:00Z"), "UTC", 8 * 60)).toBe(Date.parse("2026-10-26T08:00:00Z"));
    // In a +07:00 zone, 22:00 local is 15:00Z; the next 08:00 local is 01:00Z.
    expect(nextLocal(new Date("2026-10-26T15:00:00Z"), "Asia/Jakarta", 8 * 60)).toBe(Date.parse("2026-10-27T01:00:00Z"));
  });

  test("the envelope speaks to the beneficiary only, in its own wrapper", () => {
    const r = { ...row(), status: "open" as const, checks: 0, lastCheckedAt: null };
    const e = checkEnvelope(r, false);
    expect(e.startsWith('<runtime-check kind="commitment" last="no">')).toBe(true);
    expect(e).toContain("<@U0ALICE>");
    expect(e).toContain("call pass");
    expect(e).not.toContain("last check");
    const ids = e.match(/<@([A-Z0-9]+)>/g) ?? [];
    expect(new Set(ids)).toEqual(new Set(["<@U0ALICE>"]));
    const last = checkEnvelope({ ...r, onNoChange: "close-in-one-line" }, true);
    expect(last).toContain('last="yes"');
    expect(last).toContain("This is the last check");
    expect(last).toContain("not there yet");
    expect(couldNotConfirm(r)).toBe("<@U0ALICE> I couldn't confirm this in time: after the deploy.");
  });
});

describe("runDueCommitments", () => {
  test("a time promise is checked once at its time, then waits for its last check", async () => {
    await Commitments.upsertOpen(row({ dueKind: "time", dueText: "2026-10-26T10:00:00Z", nextCheckAt: T0, expiresAt: T0 + DAY }));
    const h = harness();
    expect(await runDueCommitments(AGENT, new Date(T0 - MIN), h.deps)).toBe(0);
    expect(await runDueCommitments(AGENT, new Date(T0), h.deps)).toBe(1);
    expect(h.dispatched[0]).toMatchObject({ runId: "run-1", row: { channelId: "C0CHAN", threadTs: "1700000000.000100" } });
    expect(await get()).toMatchObject({ checks: 1, nextCheckAt: T0 + DAY, status: "open" });
    // Nothing more until expiry.
    expect(await runDueCommitments(AGENT, new Date(T0 + POLL), h.deps)).toBe(0);
    expect(await runDueCommitments(AGENT, new Date(T0 + DAY), h.deps)).toBe(1);
    expect(h.dispatched[1]!.envelope).toContain("This is the last check");
    expect((await get())!.status).toBe("expired");
  });

  test("an event promise is polled, then gets its last check, then stops", async () => {
    await Commitments.upsertOpen(row());
    const h = harness();
    let t = T0;
    let n = 0;
    while (t <= T0 + DAY + POLL && n < 200) {
      await runDueCommitments(AGENT, new Date(t), h.deps);
      t += POLL;
      n++;
    }
    // Every poll from T0 while T0 + k·POLL + POLL < expiry, then the last one.
    expect(h.dispatched.length).toBe(DAY / POLL);
    expect(h.dispatched.filter((d) => d.envelope.includes("This is the last check"))).toHaveLength(1);
    expect(h.dispatched.at(-1)!.envelope).toContain("This is the last check");
    expect((await get())!.status).toBe("expired");
  });

  test("a done write after the last check still settles the row", async () => {
    await Commitments.upsertOpen(row({ expiresAt: T0 + POLL }));
    await runDueCommitments(AGENT, new Date(T0), harness().deps);
    expect((await get())!.status).toBe("expired");
    expect(await Commitments.close(key, "done")).toBe(true);
    expect((await get())!.status).toBe("done");
    expect(await Commitments.close(key, "expired")).toBe(false);
  });

  test("two schedulers check a due promise once", async () => {
    await Commitments.upsertOpen(row());
    const a = harness();
    const b = harness();
    await Promise.all([runDueCommitments(AGENT, new Date(T0), a.deps), runDueCommitments(AGENT, new Date(T0), b.deps)]);
    expect(a.dispatched.length + b.dispatched.length).toBe(1);
  });

  test("a busy thread defers the check a minute and records nothing", async () => {
    await Commitments.upsertOpen(row());
    const h = harness({ busy: true });
    expect(await runDueCommitments(AGENT, new Date(T0), h.deps)).toBe(0);
    expect(h.dispatched).toEqual([]);
    expect(await get()).toMatchObject({ nextCheckAt: T0 + BUSY_RETRY_MS, checks: 0 });
  });

  test("no budget: retried at the next poll", async () => {
    await Commitments.upsertOpen(row());
    const h = harness({ budget: false });
    await runDueCommitments(AGENT, new Date(T0), h.deps);
    expect(h.dispatched).toEqual([]);
    expect(h.posted).toEqual([]);
    expect(await get()).toMatchObject({ nextCheckAt: T0 + POLL, status: "open" });
  });

  test("no budget at the last check: one fixed line, once, then expired", async () => {
    await Commitments.upsertOpen(row({ expiresAt: T0 + POLL }));
    const h = harness({ budget: false });
    await runDueCommitments(AGENT, new Date(T0), h.deps);
    await runDueCommitments(AGENT, new Date(T0 + POLL), h.deps);
    expect(h.posted.map((p) => p.text)).toEqual(["<@U0ALICE> I couldn't confirm this in time: after the deploy."]);
    expect(h.posted[0]!.row.threadTs).toBe("1700000000.000100");
    expect((await get())!.status).toBe("expired");
  });

  test("the beneficiary's quiet hours defer the check to their end", async () => {
    await Commitments.upsertOpen(row({ nextCheckAt: Date.parse("2026-10-26T22:00:00Z") }));
    const h = harness({ prefs: prefsFromProfile({ quiet_hours: "21:00-08:00" }) });
    await runDueCommitments(AGENT, new Date("2026-10-26T22:00:00Z"), h.deps);
    expect(h.dispatched).toEqual([]);
    expect((await get())!.nextCheckAt).toBe(Date.parse("2026-10-27T08:00:00Z"));
  });

  test("a dispatch failure ends the run at no cost and retries at the next poll", async () => {
    await Commitments.upsertOpen(row());
    const h = harness({ dispatchFails: true });
    expect(await runDueCommitments(AGENT, new Date(T0), h.deps)).toBe(0);
    expect(h.dropped).toEqual(["run-1"]);
    expect(await get()).toMatchObject({ nextCheckAt: T0 + POLL, checks: 0 });
  });

  test("a failure after the claim moves the row on, so it is checked again", async () => {
    await Commitments.upsertOpen(row());
    await runDueCommitments(AGENT, new Date(T0), harness({ busy: "throw" }).deps);
    expect(await get()).toMatchObject({ nextCheckAt: T0 + POLL, status: "open" });
    const h = harness();
    expect(await runDueCommitments(AGENT, new Date(T0 + POLL), h.deps)).toBe(1);
  });

  test("a claim whose scheduler died mid-check is recovered after STALE_CLAIM_MS", async () => {
    await Commitments.upsertOpen(row());
    // A dead leader: claimed, never moved on.
    await claimSlot(AGENT, "commitment", `agent-u0agent/commitments/deploy@${T0}`, T0);
    const h = harness();
    expect(await runDueCommitments(AGENT, new Date(T0 + MIN), h.deps)).toBe(0);
    expect((await get())!.nextCheckAt).toBe(T0);
    const later = T0 + STALE_CLAIM_MS + MIN;
    expect(await runDueCommitments(AGENT, new Date(later), h.deps)).toBe(0);
    expect((await get())!.nextCheckAt).toBe(later);
    expect(await runDueCommitments(AGENT, new Date(later), h.deps)).toBe(1);
  });

  test("a last check that cannot be dispatched posts the fixed line and expires", async () => {
    await Commitments.upsertOpen(row({ expiresAt: T0 + POLL }));
    const h = harness({ dispatchFails: true });
    await runDueCommitments(AGENT, new Date(T0), h.deps);
    expect(h.posted.map((p) => p.text)).toEqual(["<@U0ALICE> I couldn't confirm this in time: after the deploy."]);
    expect((await get())!.status).toBe("expired");
  });

  test("where even the fixed line is refused (scope changed), the promise still expires, silently", async () => {
    await Commitments.upsertOpen(row({ expiresAt: T0 + POLL }));
    const h = harness({ dispatchFails: true, postFails: true });
    await runDueCommitments(AGENT, new Date(T0), h.deps);
    expect(h.posted).toEqual([]);
    expect((await get())!.status).toBe("expired");
  });

  test("proactiveness off in the SOUL still keeps the promise (§10.6)", async () => {
    __setProactiveSoulSource(() => "## Proactive\n- Enabled: no\n");
    await Commitments.upsertOpen(row());
    const h = harness();
    expect(await runDueCommitments(AGENT, new Date(T0), h.deps)).toBe(1);
  });

  test("a failure on one promise does not stop the next", async () => {
    await Commitments.upsertOpen(row());
    await Commitments.upsertOpen(row({ slug: "commitments/other" }));
    const h = harness({
      claim: async (agentId, slot, at) => {
        if (slot.includes("commitments/deploy@")) throw new Error("db blip");
        return claimSlot(agentId, "commitment", slot, at);
      },
    });
    expect(await runDueCommitments(AGENT, new Date(T0), h.deps)).toBe(1);
    expect(h.dispatched[0]!.row.slug).toBe("commitments/other");
    expect(promiseSlot({ source: "s", slug: "x", nextCheckAt: 5 })).toBe("s/x@5");
  });
});
