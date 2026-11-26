/**
 * Why a node's claim loops are paused. Two reasons exist and they are
 * independent, so one must never resume what the other paused:
 *
 *   - `auth`: the gateway refused this node's credential. Every worker stops
 *     claiming, its own queue included: the node cannot serve anything.
 *   - `capacity`: the node has no room for another sandbox. Only its
 *     label-queue workers stop. Its own queue keeps running, because that is
 *     where turns of sessions already warm on it arrive, and a warm session's
 *     turn is always served.
 *
 * A worker is paused while it has at least one reason, and resumed when its
 * last reason goes. Pausing a paused worker and resuming a running one are
 * no-ops, so callers need not track state.
 */
export type PauseReason = "auth" | "capacity";

export interface PausableWorker {
  pause(doNotWaitActive?: boolean): Promise<void>;
  resume(): void;
}

export interface ClaimPause {
  /** Add a reason. `labels`: the label-queue workers only. `all`: every worker. */
  pause(reason: PauseReason, scope: "all" | "labels"): Promise<void>;
  /** Remove a reason from every worker that has it; a worker with none left resumes. */
  resume(reason: PauseReason): void;
  /** Whether any worker is paused for this reason. */
  has(reason: PauseReason): boolean;
}

export function makeClaimPause(workers: ReadonlyArray<{ worker: PausableWorker; label: boolean }>): ClaimPause {
  const reasons = workers.map(() => new Set<PauseReason>());
  return {
    async pause(reason, scope) {
      await Promise.all(
        workers.map(async (w, i) => {
          if (scope === "labels" && !w.label) return;
          const first = reasons[i]!.size === 0;
          reasons[i]!.add(reason);
          // In-flight turns are left to finish: only claiming stops.
          if (first) await w.worker.pause(true).catch(() => {});
        }),
      );
    },
    resume(reason) {
      workers.forEach((w, i) => {
        if (!reasons[i]!.delete(reason)) return;
        if (reasons[i]!.size === 0) w.worker.resume();
      });
    },
    has: (reason) => reasons.some((r) => r.has(reason)),
  };
}
