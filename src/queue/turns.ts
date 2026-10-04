/**
 * BullMQ turn queues: one queue per node label (`turns` for `default`,
 * `turns.label.<label>` for any other) plus per-node queues for warm routing,
 * with per-session message coalescing (spec §2, node labels spec §4.6).
 *
 * Relabel: when the session's pending job sits on a different queue than the
 * one this enqueue computed (its persona was relabelled, or its warm node no
 * longer carries the label), the pending job is moved to the computed queue
 * with the new messages appended, carrying the new job token (the old one's
 * label claim may no longer be the persona's), before anything else happens.
 * A relabel must not strand a message on a queue no node of the label reads.
 *
 * Coalescing: messages arriving while a session already has a *pending*
 * (waiting/delayed — NOT active) job are appended to that job's messages[]
 * via job.updateData, matching the monolith's pushUser semantics. The pending
 * job for a session is indexed under `coalesce:<sessionId>`.
 *
 * Race vs worker claim: updateData on a job that a worker has already claimed
 * "succeeds" silently (verified empirically — BullMQ does not throw on
 * active/completed jobs), but the worker read its data at claim time. So after
 * every updateData we re-check the job state; if it is no longer pending, the
 * appended messages may or may not have been seen and we re-enqueue *this
 * call's* messages as a fresh job. That makes delivery at-least-once in the
 * race window; the session-serializing turn lock plus Slack ts-dedup on the
 * consumer side make the duplicate harmless.
 */
import { randomUUID } from "node:crypto";
import { Queue, type Job, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { DEFAULT_LABEL, LABEL_QUEUE_PREFIX, LABEL_RE, labelTurnsQueue, makeKeys, nodeTurnsQueue, TURNS_QUEUE, type Keys } from "./keys";
import { acquireLock, releaseLock } from "./locks";

export interface TurnMessage {
  ts: string;
  user: string;
  text: string;
  files?: unknown[];
  /** Record-only message (disengaged/mention-only): the node persists it to
   *  the transcript via the suppress hook without running the model. A turn
   *  runs suppressed only when EVERY coalesced message is suppressed. */
  suppress?: boolean;
}

/** Payload of one turn job (spec §2). Imported by the node worker (P6). */
export interface TurnJob {
  sessionId: string;
  tenantId: string;
  personaId: string;
  /** The node label this turn runs on (node labels spec §4.3); the same value
   *  is signed into jobToken. Absent on jobs from an older gateway = "default". */
  label?: string;
  messages: TurnMessage[];
  /** Identity the turn runs as when it is not the thread's /1on1 lock owner —
   *  currently a cron job's captured initiator. The node applies it before the
   *  turn so credential scoping matches an interactive 1on1. */
  oauthUser?: string;
  /** Short-lived JWT minted by the gateway; nodes present it on tool calls. */
  jobToken: string;
  enqueuedAt: number;
}

/** Where to enqueue: a label's queue, or a specific warm node's queue.
 *  `"shared"` is the pre-label spelling of `{ label: "default" }`, kept as a
 *  compatibility shim for older call sites. */
export type TurnTarget = { label: string } | { node: string } | "shared";

/** The label a job runs on: its payload's, or `default` for a job from a
 *  gateway that predates labels. */
export function jobLabel(job: Pick<TurnJob, "label">): string {
  return job.label ?? DEFAULT_LABEL;
}

/** Where a moved job went (the `job-moved:<id>` marker). */
export interface MovedRef {
  queue: string;
  jobId: string;
}

export interface EnqueueResult {
  jobId: string;
  /** BullMQ queue name the job (or append) landed on. */
  queue: string;
  /** True when the messages were appended onto an existing pending job. */
  coalesced: boolean;
}

/** States in which a job's data can still be safely rewritten. */
const PENDING_STATES = new Set(["waiting", "delayed", "prioritized", "paused", "waiting-children"]);

/** How long a coalesce index entry may outlive its job (safety TTL). */
const COALESCE_TTL_MS = 10 * 60 * 1000;

/** How long a job-moved marker is kept: longer than a follower lives (20 min). */
const MOVED_TTL_MS = 60 * 60 * 1000;

export interface TurnQueuesOpts {
  connection: Redis;
  keys?: Keys;
  /** Test-only: awaited between updateData and the post-update state check,
   *  to force the claim race deterministically. */
  afterUpdateData?: () => Promise<void>;
}

export class TurnQueues {
  readonly keys: Keys;
  #connection: Redis;
  #queues = new Map<string, Queue>();
  #afterUpdateData?: () => Promise<void>;

  constructor(opts: TurnQueuesOpts) {
    this.#connection = opts.connection;
    this.keys = opts.keys ?? makeKeys();
    this.#afterUpdateData = opts.afterUpdateData;
  }

  queueName(target: TurnTarget): string {
    if (target === "shared") return TURNS_QUEUE;
    return "node" in target ? nodeTurnsQueue(target.node) : labelTurnsQueue(target.label);
  }

  /** Queue handle by BullMQ name (cached). Shared connection is fine: queues
   *  (unlike Workers) never issue blocking commands. */
  queue(name: string): Queue {
    let q = this.#queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.#connection, prefix: this.keys.bullPrefix });
      this.#queues.set(name, q);
    }
    return q;
  }

  /**
   * Read one job by queue name without caching a handle for a name this
   * process has not used: the name can come from a caller (token-reissue), and
   * the handle cache must not grow with whatever names callers send.
   */
  async peekJob(name: string, jobId: string): Promise<Job | undefined> {
    const cached = this.#queues.get(name);
    if (cached) return cached.getJob(jobId);
    const q = new Queue(name, { connection: this.#connection, prefix: this.keys.bullPrefix });
    try {
      return await q.getJob(jobId);
    } finally {
      // close() would quit the shared connection only if BullMQ owned it; it
      // does not here (an injected connection), so this just drops the handle.
      await q.close().catch(() => {});
    }
  }

  /** Spec §2: attempts 2 with backoff; keep a bounded tail for inspection. */
  defaultJobOpts(): JobsOptions {
    return {
      attempts: 2,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600, count: 1000 },
    };
  }

  /**
   * Enqueue a turn, coalescing into the session's pending job when one
   * exists. Appenders for the same session serialize on a short Redis lock so
   * two gateway replicas cannot lose each other's read-modify-write.
   *
   * `jobId` (optional) pre-assigns the BullMQ job id for a FRESH add — the
   * dispatcher mints it before the token so the token's `job` claim matches
   * the job it rides on (token-refresh binding). Ignored when the messages
   * coalesce into an existing pending job.
   */
  async enqueueTurn(job: TurnJob, target: TurnTarget = { label: DEFAULT_LABEL }, jobId?: string): Promise<EnqueueResult> {
    const ckey = this.keys.coalesce(job.sessionId);
    const lockKey = this.keys.coalesceLock(job.sessionId);
    const lockOwner = randomUUID();
    const qname = this.queueName(target);
    await this.#acquireAppendLock(lockKey, lockOwner);
    try {
      const appended = await this.#tryAppend(ckey, job, { queue: qname, jobId });
      if (appended) return appended;
      return await this.#addFresh(job, qname, ckey, jobId);
    } finally {
      await releaseLock(this.#connection, lockKey, lockOwner).catch(() => {});
    }
  }

  /**
   * Append onto the indexed pending job; null → caller should add fresh.
   * With `want`, a pending job on a different queue is relocated there first
   * (#relocate) instead of appended in place.
   */
  async #tryAppend(ckey: string, job: TurnJob, want?: { queue: string; jobId?: string }): Promise<EnqueueResult | null> {
    const existing = await this.#connection.get(ckey);
    if (!existing) return null;
    let ref: { queue: string; jobId: string };
    try {
      ref = JSON.parse(existing);
    } catch {
      return null; // corrupt index — overwrite via fresh add
    }
    const pending = await this.queue(ref.queue).getJob(ref.jobId);
    if (!pending) return null; // stale index (job done + removed)
    if (!PENDING_STATES.has(await pending.getState())) return null; // already claimed
    if (want && ref.queue !== want.queue) return this.#relocate(pending, job, ckey, want);
    const prev = pending.data as TurnJob;
    await pending.updateData({
      ...prev,
      messages: [...prev.messages, ...job.messages],
      // Keep the ORIGINAL job's token: its `job` claim must keep matching the
      // job id for /v1/jobs/:id/token-refresh, and the worker refreshes an
      // aging token at claim time anyway — replacing it with the newest
      // message's token (the pre-refresh design) would break that binding.
    });
    if (this.#afterUpdateData) await this.#afterUpdateData();
    // Claim race: a worker may have claimed the job between updateData and
    // here, having read the PRE-update data. If the job is no longer pending
    // we cannot know which side won — re-enqueue this call's messages.
    if (PENDING_STATES.has(await pending.getState())) {
      await this.#connection.pexpire(ckey, COALESCE_TTL_MS);
      return { jobId: pending.id!, queue: ref.queue, coalesced: true };
    }
    return null;
  }

  /**
   * Move the session's pending job to `want.queue`, with this call's messages
   * appended, as ONE job under this call's id and token (node labels spec
   * §4.6). The new token, not the pending job's: after a relabel the old
   * token's label claim is not the persona's, and the /v1 gate would refuse
   * every call the turn makes. Add first, then remove the original; if the
   * original was claimed in between (remove refuses a locked job) the copy is
   * undone and null tells the caller to add only this call's messages — the
   * claimed job runs the earlier ones. The job-moved marker is written before
   * the original disappears, so a follower never reads the move as an end.
   */
  async #relocate(pending: Job, job: TurnJob, ckey: string, want: { queue: string; jobId?: string }): Promise<EnqueueResult | null> {
    const prev = pending.data as TurnJob;
    const id = want.jobId ?? randomUUID();
    const merged: TurnJob = {
      ...job,
      messages: [...prev.messages, ...job.messages],
      enqueuedAt: Math.min(prev.enqueuedAt ?? job.enqueuedAt, job.enqueuedAt),
    };
    await this.queue(want.queue).add("turn", merged, { ...this.defaultJobOpts(), jobId: id });
    await this.#markMoved(String(pending.id), { queue: want.queue, jobId: id });
    try {
      await pending.remove();
    } catch {
      await this.queue(want.queue).remove(id).catch(() => {});
      await this.#connection.del(this.keys.jobMoved(String(pending.id))).catch(() => {});
      return null;
    }
    await this.#connection.set(ckey, JSON.stringify({ queue: want.queue, jobId: id }), "PX", COALESCE_TTL_MS);
    return { jobId: id, queue: want.queue, coalesced: true };
  }

  async #markMoved(fromJobId: string, to: MovedRef): Promise<void> {
    await this.#connection.set(this.keys.jobMoved(fromJobId), JSON.stringify(to), "PX", MOVED_TTL_MS);
  }

  /**
   * Every label queue that exists in Redis, as `{queue, label}`, `turns`
   * (default) first. Found by its BullMQ `:meta` key; bounded by the labels in
   * use, so it is safe as a metric label set.
   */
  async labelQueues(): Promise<Array<{ queue: string; label: string }>> {
    const out = [{ queue: TURNS_QUEUE, label: DEFAULT_LABEL }];
    const head = `${this.keys.bullPrefix}:${LABEL_QUEUE_PREFIX}`;
    const seen = new Set<string>();
    let cursor = "0";
    do {
      const [next, batch] = await this.#connection.scan(cursor, "MATCH", `${head}*:meta`, "COUNT", 200);
      cursor = next;
      for (const k of batch) {
        const label = k.slice(head.length, -":meta".length);
        if (LABEL_RE.test(label) && !seen.has(label)) {
          seen.add(label);
          out.push({ queue: labelTurnsQueue(label), label });
        }
      }
    } while (cursor !== "0");
    return out;
  }

  /** Where job `jobId` was last moved to, or null if it never was. */
  async movedTo(jobId: string): Promise<MovedRef | null> {
    const v = await this.#connection.get(this.keys.jobMoved(jobId));
    if (!v) return null;
    try {
      const r = JSON.parse(v) as MovedRef;
      return typeof r?.queue === "string" && typeof r?.jobId === "string" ? r : null;
    } catch {
      return null;
    }
  }

  async #addFresh(job: TurnJob, qname: string, ckey: string, presetId?: string): Promise<EnqueueResult> {
    const jobId = presetId ?? randomUUID();
    // Index first: if the add below fails, the index points at a missing job,
    // which the next enqueue detects (getJob → null) and overwrites.
    await this.#connection.set(ckey, JSON.stringify({ queue: qname, jobId }), "PX", COALESCE_TTL_MS);
    await this.queue(qname).add("turn", job, { ...this.defaultJobOpts(), jobId });
    return { jobId, queue: qname, coalesced: false };
  }

  /**
   * Move an unclaimed job to the shared queue (reaper / stall rescue). NOT
   * plain enqueueTurn: the coalesce index usually points at the very job
   * being moved, and appending a job onto itself before removing it would
   * lose the turn. Under the session's append lock:
   *
   * - index points elsewhere (a different pending job exists): append these
   *   messages there and drop the original;
   * - otherwise: fresh add on shared (re-pointing the index), then remove the
   *   original. If the original got claimed in that window (live-queue race)
   *   its worker will run it — undo our copy to avoid a double turn; if even
   *   the undo fails the duplicate stands (at-least-once, session-lock
   *   serialized).
   */
  async moveToShared(job: Job): Promise<EnqueueResult> {
    const data = job.data as TurnJob;
    const ckey = this.keys.coalesce(data.sessionId);
    const lockKey = this.keys.coalesceLock(data.sessionId);
    const lockOwner = randomUUID();
    await this.#acquireAppendLock(lockKey, lockOwner);
    try {
      const existing = await this.#connection.get(ckey);
      let indexedElsewhere = false;
      if (existing) {
        try {
          indexedElsewhere = (JSON.parse(existing) as { jobId: string }).jobId !== job.id;
        } catch {
          /* corrupt index — treat as self */
        }
      }
      if (indexedElsewhere) {
        const appended = await this.#tryAppend(ckey, data);
        if (appended) {
          await job.remove();
          return appended;
        }
      }
      const res = await this.#addFresh(data, TURNS_QUEUE, ckey);
      await this.#markMoved(String(job.id), { queue: res.queue, jobId: res.jobId }).catch(() => {});
      try {
        await job.remove();
      } catch {
        await this.queue(TURNS_QUEUE)
          .remove(res.jobId)
          .catch(() => {});
      }
      return res;
    } finally {
      await releaseLock(this.#connection, lockKey, lockOwner).catch(() => {});
    }
  }

  /**
   * Move a job to `label`'s queue (node labels spec §4.6), generalising
   * moveToShared. The job keeps its id, so its token's `job` claim keeps
   * matching (token refresh and reissue bind on it) and the turn-done marker
   * still dedups it. Under the session's append lock:
   *
   * - already on that queue: nothing to do;
   * - the coalesce index points at another pending job: append there (the
   *   same rule as moveToShared);
   * - otherwise add the copy on the label queue and re-point the index.
   *
   * `claimed`: the caller is the worker holding this job (a label mismatch at
   * claim). The original cannot be removed while locked; the caller completes
   * it instead, and the job-moved marker tells a follower where the turn went.
   * Unclaimed: the original is removed after the copy is added; if it was
   * claimed in between, the copy is undone and its worker runs it.
   */
  async moveTo(job: Job, label: string, opts: { claimed?: boolean } = {}): Promise<EnqueueResult> {
    const target = labelTurnsQueue(label);
    const from = job.queueName;
    const id = String(job.id);
    if (from === target) return { jobId: id, queue: target, coalesced: false };
    const data = job.data as TurnJob;
    const ckey = this.keys.coalesce(data.sessionId);
    const lockKey = this.keys.coalesceLock(data.sessionId);
    const lockOwner = randomUUID();
    await this.#acquireAppendLock(lockKey, lockOwner);
    try {
      const existing = await this.#connection.get(ckey);
      let indexedElsewhere = false;
      if (existing) {
        try {
          const ref = JSON.parse(existing) as { queue: string; jobId: string };
          indexedElsewhere = ref.jobId !== id || ref.queue !== from;
        } catch {
          /* corrupt index — treat as self */
        }
      }
      if (indexedElsewhere) {
        const appended = await this.#tryAppend(ckey, data);
        if (appended) {
          await this.#markMoved(id, { queue: appended.queue, jobId: appended.jobId });
          if (!opts.claimed) await job.remove();
          return appended;
        }
      }
      // Same id on the target; a job already holding that id there (a move
      // that came back) would swallow the add, so fall back to a fresh id.
      const clash = await this.queue(target).getJob(id);
      const res = await this.#addFresh(data, target, ckey, clash ? undefined : id);
      await this.#markMoved(id, { queue: target, jobId: res.jobId });
      if (!opts.claimed) {
        try {
          await job.remove();
        } catch {
          await this.queue(target).remove(res.jobId).catch(() => {});
          await this.#connection.del(this.keys.jobMoved(id)).catch(() => {});
          return { jobId: id, queue: from, coalesced: false };
        }
      }
      return res;
    } finally {
      await releaseLock(this.#connection, lockKey, lockOwner).catch(() => {});
    }
  }

  /** Spin on the per-session append lock. TTL 2s covers a crashed appender;
   *  5s of contention without progress is pathological — fail loudly. */
  async #acquireAppendLock(lockKey: string, owner: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!(await acquireLock(this.#connection, lockKey, owner, 2000))) {
      if (Date.now() > deadline) throw new Error(`timed out acquiring coalesce lock ${lockKey}`);
      await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 15)));
    }
  }

  async close(): Promise<void> {
    const qs = [...this.#queues.values()];
    this.#queues.clear();
    await Promise.all(qs.map((q) => q.close()));
  }
}
