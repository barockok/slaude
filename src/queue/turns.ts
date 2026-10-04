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
  /** How many times the gateway re-dispatched this turn after a
   *  LABEL_MISMATCH failure (node labels spec §4.6). Bounded at one: a second
   *  mismatch is shown to the user instead. Absent = 0. */
  relabelAttempts?: number;
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

/** How long a move's copy is held unclaimable while the original is removed
 *  (#swap). Promoted at once on success; only a crash mid-move waits it out. */
const SWAP_HOLD_MS = 30_000;

/** How long the once-guard of a LABEL_MISMATCH re-dispatch is kept. Short on
 *  purpose: once the winner wrote its job-moved marker every follower follows
 *  that instead, so the guard only matters while the winner works, and a
 *  winner that died mid-way lets another follower redo it after this long. */
const REDISPATCH_TTL_MS = 30_000;

/**
 * Take a job off its queue ONLY if no worker holds it, in one step (review
 * F1). A check-then-remove from the client is not atomic: a job claimed AND
 * finished between the check and the remove would be removed "successfully"
 * after it ran, and the move's copy would run its messages a second time.
 *
 * KEYS[1] the queue's key prefix (`<bull prefix>:<queue>:`)
 * ARGV[1] the job id
 * ARGV[2] "1" to also take an ACTIVE job whose lock is gone (a dead node's
 *         claim, which no surviving worker will stall-recover: the reaper)
 *
 * Returns where the job was taken from (`delayed|prioritized|wait|paused|
 * active`), or why it was not: `missing`, `locked` (a worker holds it) or
 * `claimed` (active without the flag, completed or failed).
 */
const TAKE_UNCLAIMED_LUA = `
local p = KEYS[1]
local id = ARGV[1]
local jobKey = p .. id
if redis.call("EXISTS", jobKey) == 0 then return "missing" end
if redis.call("EXISTS", jobKey .. ":lock") == 1 then return "locked" end
local from
if redis.call("ZREM", p .. "delayed", id) == 1 then from = "delayed"
elseif redis.call("ZREM", p .. "prioritized", id) == 1 then from = "prioritized"
elseif redis.call("LREM", p .. "wait", 1, id) == 1 then from = "wait"
elseif redis.call("LREM", p .. "paused", 1, id) == 1 then from = "paused"
elseif ARGV[2] == "1" and redis.call("LREM", p .. "active", 1, id) == 1 then
  redis.call("SREM", p .. "stalled", id)
  from = "active"
else
  return "claimed"
end
redis.call("DEL", jobKey, jobKey .. ":logs", jobKey .. ":dependencies", jobKey .. ":processed", jobKey .. ":failed", jobKey .. ":unsuccessful")
return from
`;

/** TAKE_UNCLAIMED_LUA outcomes that mean the job was taken. */
const TAKEN = new Set(["delayed", "prioritized", "wait", "paused", "active"]);

/** Options for a move off a queue. */
export interface MoveOpts {
  /** The caller is the worker holding this job (a label mismatch at claim). */
  claimed?: boolean;
  /** Also move an ACTIVE job whose lock is gone (a dead node's own queue). */
  rescueActive?: boolean;
}

/** One message's identity for de-duplication: a re-delivered message is the
 *  same Slack message, so its ts, author and text all match. */
const msgKey = (m: TurnMessage): string => `${m.ts}\u0000${m.user}\u0000${m.text}`;

/** `extra` without the messages `base` already holds (review F3). */
export function newMessages(base: readonly TurnMessage[], extra: readonly TurnMessage[]): TurnMessage[] {
  const have = new Set(base.map(msgKey));
  const out: TurnMessage[] = [];
  for (const m of extra) {
    const k = msgKey(m);
    if (have.has(k)) continue;
    have.add(k);
    out.push(m);
  }
  return out;
}

export interface TurnQueuesOpts {
  connection: Redis;
  keys?: Keys;
  /** Test-only: awaited between updateData and the post-update state check,
   *  to force the claim race deterministically. */
  afterUpdateData?: () => Promise<void>;
  /** Test-only: awaited inside a move between adding the held copy and
   *  removing the original — the window a claim race needs. */
  beforeSwapRemove?: () => Promise<void>;
  /** Test-only: awaited right after a move took the original off its queue,
   *  before its messages are merged anywhere (a throw here is a crash). */
  afterTakeOriginal?: () => Promise<void>;
}

export class TurnQueues {
  readonly keys: Keys;
  #connection: Redis;
  #queues = new Map<string, Queue>();
  #afterUpdateData?: () => Promise<void>;
  #beforeSwapRemove?: () => Promise<void>;
  #afterTakeOriginal?: () => Promise<void>;

  constructor(opts: TurnQueuesOpts) {
    this.#connection = opts.connection;
    this.keys = opts.keys ?? makeKeys();
    this.#afterUpdateData = opts.afterUpdateData;
    this.#beforeSwapRemove = opts.beforeSwapRemove;
    this.#afterTakeOriginal = opts.afterTakeOriginal;
  }

  /** The command connection these queues share (label status reads). */
  get redis(): Redis {
    return this.#connection;
  }

  /**
   * Take `job` off its queue if no worker holds it (TAKE_UNCLAIMED_LUA, one
   * atomic step). Returns the script's outcome: a state name when taken.
   */
  async takeUnclaimed(job: Pick<Job, "id" | "queueName">, opts: { rescueActive?: boolean } = {}): Promise<string> {
    const qprefix = `${this.keys.bullPrefix}:${job.queueName}:`;
    return String(await this.#connection.eval(TAKE_UNCLAIMED_LUA, 1, qprefix, String(job.id), opts.rescueActive ? "1" : "0"));
  }

  async #take(job: Job, opts: { rescueActive?: boolean } = {}): Promise<boolean> {
    return TAKEN.has(await this.takeUnclaimed(job, opts));
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
    const prev = pending.data as TurnJob;
    // Only a LABEL change relocates (node labels spec §4.6). A warmth change
    // under the same label (the warm node came or went between messages)
    // appends in place exactly as before labels: same job id, same token.
    if (want && ref.queue !== want.queue && jobLabel(prev) !== jobLabel(job)) {
      return this.#relocate(pending, job, ckey, want);
    }
    // A message the pending job already holds is not appended again (review
    // F3): a re-delivery after a crash between an append and its marker, or a
    // retry after the claim race below, would otherwise run it twice. With
    // nothing new, the messages are already in a job that runs them.
    const fresh = newMessages(prev.messages, job.messages);
    if (fresh.length === 0) {
      await this.#connection.pexpire(ckey, COALESCE_TTL_MS);
      return { jobId: pending.id!, queue: ref.queue, coalesced: true };
    }
    await pending.updateData({
      ...prev,
      messages: [...prev.messages, ...fresh],
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
   * every call the turn makes. Through #swap, so the original's messages run
   * exactly once: if a worker claimed the original meanwhile, null tells the
   * caller to add only this call's messages — the claimed job runs the
   * earlier ones.
   */
  async #relocate(pending: Job, job: TurnJob, ckey: string, want: { queue: string; jobId?: string }): Promise<EnqueueResult | null> {
    const prev = pending.data as TurnJob;
    const id = want.jobId ?? randomUUID();
    const merged: TurnJob = {
      ...job,
      messages: [...prev.messages, ...newMessages(prev.messages, job.messages)],
      enqueuedAt: Math.min(prev.enqueuedAt ?? job.enqueuedAt, job.enqueuedAt),
    };
    if (!(await this.#swap(pending, want.queue, merged, id))) return null;
    await this.#connection.set(ckey, JSON.stringify({ queue: want.queue, jobId: id }), "PX", COALESCE_TTL_MS);
    return { jobId: id, queue: want.queue, coalesced: true };
  }

  /**
   * Replace an UNCLAIMED job with a copy on `target`, so its messages run
   * exactly once. The copy is added HELD (delayed), so no worker can claim it;
   * then the original is taken off its queue in one atomic step that refuses a
   * job a worker holds or has finished (TAKE_UNCLAIMED_LUA): a refusal means a
   * worker claimed the original, so the held copy is dropped (still
   * unclaimable) and false is returned. Only once the original is gone is the
   * copy promoted. A crash in between leaves the copy to run when the hold
   * lapses (at-least-once, never lost). The job-moved marker is written before
   * the original disappears, so a follower never reads the move as the turn's
   * end. `rescueActive` also takes an active job whose lock is gone (reaper).
   */
  async #swap(original: Job, target: string, data: TurnJob, id: string, opts: { rescueActive?: boolean } = {}): Promise<boolean> {
    const copy = await this.queue(target).add("turn", data, { ...this.defaultJobOpts(), jobId: id, delay: SWAP_HOLD_MS });
    await this.#markMoved(String(original.id), { queue: target, jobId: id });
    if (this.#beforeSwapRemove) await this.#beforeSwapRemove();
    // A throw here (the outcome unknown) leaves the held copy in place: it runs
    // when the hold lapses, a duplicate at worst rather than a lost turn.
    if (!(await this.#take(original, opts))) {
      await copy.remove().catch(() => {});
      await this.#connection.del(this.keys.jobMoved(String(original.id))).catch(() => {});
      return false;
    }
    // A failed promote only delays the turn by the hold; it is not lost.
    await copy.promote().catch(() => {});
    return true;
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
   * The append-elsewhere branch of moveTo: when the coalesce index points at
   * ANOTHER pending job, merge `job`'s messages into it. The same held-copy
   * pattern as #swap (review F4), so no crash point loses the messages:
   *
   *   1. add a HELD copy of `job` on the indexed queue and point the job-moved
   *      marker at it;
   *   2. take `job` off its queue atomically (refused when a worker holds it:
   *      drop the copy, its worker runs it);
   *   3. append the messages to the indexed job and drop the held copy, or,
   *      when that job was claimed meanwhile, promote the copy instead.
   *
   * A crash after 2 leaves the held copy, which runs when its hold lapses; a
   * crash between the append and dropping the copy runs the messages twice
   * (at-least-once). Null = the index points at `job` itself (or nowhere): the
   * caller moves it. A refused take returns the job's own location.
   */
  async #moveIntoIndexed(job: Job, ckey: string, opts: { rescueActive?: boolean } = {}): Promise<EnqueueResult | null> {
    const id = String(job.id);
    const raw = await this.#connection.get(ckey);
    if (!raw) return null;
    let ref: MovedRef;
    try {
      ref = JSON.parse(raw) as MovedRef;
    } catch {
      return null; // corrupt index — treat as self
    }
    if (ref.jobId === id && ref.queue === job.queueName) return null;
    const other = await this.queue(ref.queue).getJob(ref.jobId);
    if (!other || !PENDING_STATES.has(await other.getState())) return null;
    const data = job.data as TurnJob;
    const holdId = randomUUID();
    const hold = await this.queue(ref.queue).add("turn", data, { ...this.defaultJobOpts(), jobId: holdId, delay: SWAP_HOLD_MS });
    await this.#markMoved(id, { queue: ref.queue, jobId: holdId });
    if (this.#beforeSwapRemove) await this.#beforeSwapRemove();
    if (!(await this.#take(job, opts))) {
      await hold.remove().catch(() => {});
      await this.#connection.del(this.keys.jobMoved(id)).catch(() => {});
      return { jobId: id, queue: job.queueName, coalesced: false };
    }
    if (this.#afterTakeOriginal) await this.#afterTakeOriginal();
    const appended = await this.#tryAppend(ckey, data);
    if (appended) {
      // A refused take means the hold lapsed and a worker took the copy: the
      // messages run twice (at-least-once), never zero times.
      await this.#take(hold).catch(() => false);
      // Both markers: a follower may be watching the original or the copy.
      await this.#markMoved(holdId, { queue: appended.queue, jobId: appended.jobId });
      await this.#markMoved(id, { queue: appended.queue, jobId: appended.jobId });
      return appended;
    }
    // The indexed job was claimed meanwhile: the copy runs the messages.
    await hold.promote().catch(() => {});
    await this.#connection.set(ckey, JSON.stringify({ queue: ref.queue, jobId: holdId }), "PX", COALESCE_TTL_MS);
    return { jobId: holdId, queue: ref.queue, coalesced: false };
  }

  /**
   * Move a job to `label`'s queue (node labels spec §4.6): a pending job after
   * a relabel, a job claimed by a node without its label, or the reaper
   * draining a dead node's own queue. The job keeps its id, so its token's `job` claim keeps
   * matching (token refresh and reissue bind on it) and the turn-done marker
   * still dedups it. Under the session's append lock:
   *
   * - already on that queue: nothing to do;
   * - already moved (a job-moved marker sends it away from this queue, or the
   *   target already holds this id in any state): the move is DONE — return
   *   where it went, add nothing. This makes a re-delivered claim idempotent:
   *   a node that died after adding the copy but before completing the
   *   original must not append the messages twice or start a second copy;
   * - the coalesce index points at another pending job: append there;
   * - otherwise put a copy on the label queue and re-point the index.
   *
   * `claimed`: the caller is the worker holding this job (a label mismatch at
   * claim). The original cannot be removed while locked; the caller completes
   * it instead. Unclaimed: through #swap, so the messages run exactly once.
   * `rescueActive` (reaper, dead node): an active job whose lock has expired is
   * moved too; one whose lock is live is left alone.
   */
  async moveTo(job: Job, label: string, opts: MoveOpts = {}): Promise<EnqueueResult> {
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
      const done = await this.movedTo(id);
      if (done && done.queue !== from) return { jobId: done.jobId, queue: done.queue, coalesced: false };
      if (await this.queue(target).getJob(id)) {
        await this.#markMoved(id, { queue: target, jobId: id });
        return { jobId: id, queue: target, coalesced: false };
      }
      if (opts.claimed) {
        // The original stays locked by the caller, so the index cannot point
        // at it usefully; append to another pending job if there is one.
        const raw = await this.#connection.get(ckey);
        const ref = raw ? (() => { try { return JSON.parse(raw) as MovedRef; } catch { return null; } })() : null;
        if (ref && !(ref.jobId === id && ref.queue === from)) {
          const appended = await this.#tryAppend(ckey, data);
          if (appended) {
            await this.#markMoved(id, { queue: appended.queue, jobId: appended.jobId });
            return appended;
          }
        }
        // Add, then mark: a crash in between leaves the copy on the target,
        // which the target check above treats as done on re-delivery.
        const res = await this.#addFresh(data, target, ckey, id);
        await this.#markMoved(id, { queue: target, jobId: id });
        return res;
      }
      const take = { rescueActive: opts.rescueActive };
      const appended = await this.#moveIntoIndexed(job, ckey, take);
      if (appended) return appended;
      if (!(await this.#swap(job, target, data, id, take))) return { jobId: id, queue: from, coalesced: false };
      await this.#connection.set(ckey, JSON.stringify({ queue: target, jobId: id }), "PX", COALESCE_TTL_MS);
      return { jobId: id, queue: target, coalesced: false };
    } finally {
      await releaseLock(this.#connection, lockKey, lockOwner).catch(() => {});
    }
  }

  /**
   * Re-dispatch the turn of a job that FAILED with LABEL_MISMATCH (node labels
   * spec §4.6) as `job` (the caller sets its label, token and
   * relabelAttempts) on `label`'s queue, under `newJobId`. Once per failed job
   * across every gateway replica: a SET NX guard decides which follower does
   * it; the others get null and follow the job-moved marker the winner writes.
   * Through enqueueTurn, so it coalesces like any message (and a message the
   * pending job already holds is not added twice). A crash between the guard
   * and the marker delays the re-dispatch until the guard lapses
   * (REDISPATCH_TTL_MS), when a surviving follower redoes it.
   */
  async redispatch(failedJobId: string, job: TurnJob, label: string, newJobId: string): Promise<EnqueueResult | null> {
    const won = await this.#connection.set(this.keys.redispatch(failedJobId), newJobId, "PX", REDISPATCH_TTL_MS, "NX");
    if (won !== "OK") return null;
    const res = await this.enqueueTurn(job, { label }, newJobId);
    await this.#markMoved(failedJobId, { queue: res.queue, jobId: res.jobId });
    return res;
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
