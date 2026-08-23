/**
 * BullMQ turn queues: one shared `turns` queue plus per-node queues for warm
 * routing, with per-session message coalescing (spec §2).
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
import { makeKeys, nodeTurnsQueue, TURNS_QUEUE, type Keys } from "./keys";
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
  messages: TurnMessage[];
  /** Short-lived JWT minted by the gateway; nodes present it on tool calls. */
  jobToken: string;
  enqueuedAt: number;
}

/** Where to enqueue: the shared queue, or a specific warm node's queue. */
export type TurnTarget = "shared" | { node: string };

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
    return target === "shared" ? TURNS_QUEUE : nodeTurnsQueue(target.node);
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
   */
  async enqueueTurn(job: TurnJob, target: TurnTarget = "shared"): Promise<EnqueueResult> {
    const ckey = this.keys.coalesce(job.sessionId);
    const lockKey = this.keys.coalesceLock(job.sessionId);
    const lockOwner = randomUUID();
    await this.#acquireAppendLock(lockKey, lockOwner);
    try {
      const appended = await this.#tryAppend(ckey, job);
      if (appended) return appended;
      return await this.#addFresh(job, this.queueName(target), ckey);
    } finally {
      await releaseLock(this.#connection, lockKey, lockOwner).catch(() => {});
    }
  }

  /** Append onto the indexed pending job; null → caller should add fresh. */
  async #tryAppend(ckey: string, job: TurnJob): Promise<EnqueueResult | null> {
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
    const prev = pending.data as TurnJob;
    await pending.updateData({
      ...prev,
      messages: [...prev.messages, ...job.messages],
      // The newest token has the longest remaining TTL — the turn must outlive
      // the last message that joined it.
      jobToken: job.jobToken,
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

  async #addFresh(job: TurnJob, qname: string, ckey: string): Promise<EnqueueResult> {
    const jobId = randomUUID();
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
