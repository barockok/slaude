/**
 * Keeping promises (spec §10.1; invariants 1 and 5). Every scheduler tick, for
 * each of an agent's open commitments whose next check is due:
 *
 *   1. the beneficiary's own profile quiet hours defer it to their end (only
 *      theirs: they asked for this, so the SOUL's quiet hours do not apply);
 *   2. the check is claimed in `background_slots` as
 *      `<source>/<slug>@<next_check_at>`, so two replicas run it once;
 *   3. a thread whose session is busy (a turn running, or a human message
 *      waiting) defers it a minute, recording nothing: a background run is
 *      never merged into a human's turn;
 *   4. a `commitment` ledger run opens (top priority: no nightly reserve). A
 *      refusal is recorded `skipped-budget` and retried at the next poll; on
 *      the last check, one fixed line tells the beneficiary instead;
 *   5. the check turn is dispatched into the promise's own thread (the cron
 *      path: origin cron, run as the person for a /1on1 promise), carrying
 *      its run, which the turn's own usage closes.
 *
 * Not gated by `## Proactive` or the decision gate: the promise is the
 * authorization. A check never widens its audience: same thread, the
 * beneficiary only.
 *
 * Due rules (due.ts): a time promise is checked at its time, then once more
 * (the last check) at its expiry; an event promise is polled until the poll
 * after which it would expire, which is its last check. After the last
 * check is dispatched the row is `expired`; the turn's own done/dropped write
 * settles it.
 */
import { env } from "../config/env";
import * as Commitments from "../db/commitments";
import type { CommitmentRow } from "../db/commitments";
import { claimSlot } from "../db/background-slots";
import { redactSecrets } from "../gateway/core/status-text";
import { renderPassPrompt } from "../background/prompts";
import { localParts } from "../background/calendar";
import { inWindow } from "../soul/proactive";
import type { PingPrefs } from "./prefs";

/** How the scheduler reaches Slack and the agent (the gateway or mono implements it). */
export interface PromiseTransport {
  /** True when the promise's thread has a turn running or a message waiting. */
  isBusy(row: CommitmentRow): Promise<boolean>;
  /** Dispatch the check turn into the promise's thread, carrying its open run. */
  dispatch(row: CommitmentRow, envelope: string, run: { runId: string; agentId: string }): Promise<void>;
  /** Post one line in the promise's thread, as the agent. */
  post(row: CommitmentRow, text: string): Promise<void>;
}

export interface PromiseDeps {
  transport: PromiseTransport;
  prefs(teamId: string | null, userId: string): Promise<PingPrefs>;
  /** Open a `commitment` run for the row (startSkillCheck with pass commitment). */
  openRun(row: CommitmentRow): Promise<{ ok: true; runId: string; agentId: string } | { ok: false }>;
  /** End a run whose turn never went out, at no cost. */
  dropRun(runId: string, agentId: string): Promise<void>;
  /** The persona's timezone, for a beneficiary whose profile names none. */
  timeZone: string;
  /** Default: claimSlot. */
  claim?: (agentId: string, slot: string, at: number) => Promise<boolean>;
  /** Most promises checked per tick per agent. Default 20. */
  limit?: number;
}

/** A busy thread is looked at again after this long. */
export const BUSY_RETRY_MS = 60_000;

export const couldNotConfirm = (row: Pick<CommitmentRow, "beneficiary" | "dueText">): string =>
  `<@${row.beneficiary}> I couldn't confirm this in time: ${row.dueText}.`;

export const promiseSlot = (row: Pick<CommitmentRow, "source" | "slug" | "nextCheckAt">): string => `${row.source}/${row.slug}@${row.nextCheckAt}`;

/** True when this check is the promise's last. */
export function isLastCheck(row: CommitmentRow, now: number, pollMs: number): boolean {
  return row.dueKind === "time" ? row.checks >= 1 || now >= row.expiresAt : now + pollMs >= row.expiresAt;
}

/** The instant `minutes` local time next comes round after `now` (minute precision; DST shifts ignored). */
export function nextLocal(now: Date, timeZone: string, minutes: number): number {
  const cur = localParts(now, timeZone).minutes;
  const delta = (((minutes - cur) % 1440) + 1440) % 1440 || 1440;
  return now.getTime() - (now.getTime() % 60_000) + delta * 60_000;
}

/** The check prompt for a row. */
export function checkEnvelope(row: CommitmentRow, last: boolean): string {
  return renderPassPrompt("commitment-check", {
    LAST: last ? "yes" : "no",
    BENEFICIARY: row.beneficiary,
    SLUG: row.slug,
    DUE: row.dueText,
    CHECK: row.checkText || "whatever the promise depends on",
    ON_NO_CHANGE_RULE:
      row.onNoChange === "close-in-one-line" ? "say in one line that it is not there yet." : "call pass; say nothing.",
    LAST_RULE: last
      ? "This is the last check. If it is still unresolved, say in one line that you couldn't confirm it, then write the commitment again as dropped (a new slug, `supersedes` naming it)."
      : "",
  });
}

const errText = (e: unknown): string => redactSecrets(e instanceof Error ? e.message : String(e));

/** Check an agent's due promises once. Returns how many check turns went out. */
export async function runDueCommitments(agentId: string, now: Date, deps: PromiseDeps): Promise<number> {
  const pollMs = env.promisePollMinutes() * 60_000;
  const claim = deps.claim ?? ((a: string, slot: string, at: number) => claimSlot(a, "commitment", slot, at));
  const t = now.getTime();
  let sent = 0;
  for (const row of await Commitments.due(agentId, t, deps.limit ?? 20)) {
    const k = { agentId: row.agentId, source: row.source, slug: row.slug };
    const tag = `[proactive] agent=${agentId} commitment=${row.source}/${row.slug}`;
    try {
      const prefs = await deps.prefs(row.teamId, row.beneficiary);
      if (prefs.quietHours) {
        const tz = prefs.timeZone ?? deps.timeZone;
        if (inWindow(localParts(now, tz).minutes, prefs.quietHours)) {
          await Commitments.reschedule(k, nextLocal(now, tz, prefs.quietHours.end));
          continue;
        }
      }
      if (!(await claim(agentId, promiseSlot(row), t))) continue;
      if (await deps.transport.isBusy(row)) {
        await Commitments.reschedule(k, t + BUSY_RETRY_MS);
        continue;
      }
      const last = isLastCheck(row, t, pollMs);
      const run = await deps.openRun(row);
      if (!run.ok) {
        if (last) {
          await deps.transport.post(row, couldNotConfirm(row));
          await Commitments.close(k, "expired");
          console.log(`${tag}: no budget for the last check; told the beneficiary it could not be confirmed`);
        } else {
          await Commitments.reschedule(k, t + pollMs);
        }
        continue;
      }
      try {
        await deps.transport.dispatch(row, checkEnvelope(row, last), { runId: run.runId, agentId: run.agentId });
      } catch (e) {
        console.error(`${tag}: could not dispatch the check: ${errText(e)}`);
        await deps.dropRun(run.runId, run.agentId).catch((e2) => console.error(`${tag}: could not end its run: ${errText(e2)}`));
        await Commitments.reschedule(k, t + pollMs);
        continue;
      }
      sent++;
      if (last) {
        await Commitments.markChecked(k, t, row.expiresAt);
        await Commitments.close(k, "expired");
      } else {
        const next = row.dueKind === "time" ? Math.max(row.expiresAt, t + pollMs) : t + pollMs;
        await Commitments.markChecked(k, t, next);
      }
    } catch (e) {
      console.error(`${tag}: check failed: ${errText(e)}`);
    }
  }
  return sent;
}
