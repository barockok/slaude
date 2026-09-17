/**
 * Gateway-role turn dispatch (spec §2): instead of running the agent
 * in-process, mint a job token, consult the warm-session registry, and
 * enqueue onto BullMQ — per-node queue when the session is warm somewhere,
 * shared `turns` otherwise. Coalescing lives inside TurnQueues.
 *
 * Slack UX parity: nodes append every AgentEvent to the events:<session>
 * stream (spec §4). After each enqueue this module follows that stream and
 * re-emits the events on the LOCAL AgentManager's emitter — the gateway's
 * existing event handler (reactions, status, todo trackers, error posts,
 * done ✅) then behaves exactly as in mono, without knowing the turn ran on
 * another machine. Following stops shortly after the turn ends (a later
 * enqueue restarts it), and hard-stops at a deadline so an orphaned follower
 * can't poll forever.
 */
import { randomUUID } from "node:crypto";
import type { AgentManager, AgentEvent } from "../../agent/manager";
import type { SessionRow } from "../../db/schema";
import { mintJobToken } from "../api/auth";
import { makeKeys, type Keys } from "../../queue/keys";
import { getRedis, getSubRedis } from "../../queue/redis";
import { makeRegistry, type Registry } from "../../queue/registry";
import { makePubSub, type PubSub } from "../../queue/pubsub";
import { TurnQueues, type TurnTarget } from "../../queue/turns";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DispatchMeta {
  teamId: string;
  channelId: string;
  threadTs: string;
  eventTs: string;
  userId: string;
  personaId?: string;
  /** Tenant that owns this conversation. Resolved by the transport from the
   *  slack_apps row; when absent the session row's own column is used, and
   *  'default' is the last resort (sqlite carries no tenant_id column). */
  tenantId?: string;
  suppress?: boolean;
}

export interface QueueDispatch {
  /** Enqueue one inbound message as (part of) a turn job. */
  dispatch(session: SessionRow, text: string, meta: DispatchMeta): Promise<void>;
  /** Durable + published abort for /abort (spec §2). */
  abort(sessionId: string): Promise<void>;
  pubsub: PubSub;
  turns: TurnQueues;
  registry: Registry;
  /** Stop every stream follower (tests/shutdown). */
  close(): Promise<void>;
}

export interface QueueDispatchOpts {
  keys?: Keys;
  /** Follower poll cadence (ms). Default 300. */
  followPollMs?: number;
  /** Hard cap on one follower's lifetime (ms). Default 20 min. */
  followMaxMs?: number;
  /** How long a follower lingers after done/error (ms). Default 3s. */
  followLingerMs?: number;
  /** Test seam: injected infra instead of the process-wide Redis. */
  infra?: { turns: TurnQueues; registry: Registry; pubsub: PubSub };
}

export function makeQueueDispatch(agent: AgentManager, opts: QueueDispatchOpts = {}): QueueDispatch {
  const keys = opts.keys ?? makeKeys();
  const infra =
    opts.infra ??
    (() => {
      const redis = getRedis();
      return {
        turns: new TurnQueues({ connection: redis, keys }),
        registry: makeRegistry({ redis, keys }),
        pubsub: makePubSub({ redis, sub: getSubRedis(), keys }),
      };
    })();
  const { turns, registry, pubsub } = infra;
  const followPollMs = opts.followPollMs ?? 300;
  const followMaxMs = opts.followMaxMs ?? 20 * 60_000;
  const followLingerMs = opts.followLingerMs ?? 3_000;

  type Follower = {
    deadline: number;
    /** Jobs whose outcome this follower still owes the UX pipeline. */
    jobs: Map<string, { queue: string }>;
    /**
     * Once-guard: jobIds whose done/error outcome has already been emitted —
     * by EITHER the stream re-emit OR the job-completion synthesizer, whichever
     * won the race. A turn's outcome fires exactly once per job. Keyed by the
     * unique (UUID) jobId, so it never wrongly suppresses a different job's
     * outcome and needs no per-window reset — the follower (and this Set) is
     * discarded once its loop ends.
     */
    outcomeEmitted: Set<string>;
  };
  const followers = new Map<string, Follower>();
  let closed = false;

  /**
   * @param startAfter Stream id to read after when this call starts a new
   *   follower. It MUST be captured before the job was enqueued: see dispatch().
   *   Ignored when a follower for the session is already running, since that
   *   follower's own cursor is already earlier.
   */
  function followEvents(
    sessionId: string,
    job: { jobId: string; queue: string },
    startAfter: string | undefined,
  ): void {
    const existing = followers.get(sessionId);
    const deadline = Date.now() + followMaxMs;
    if (existing) {
      existing.deadline = Math.max(existing.deadline, deadline);
      existing.jobs.set(job.jobId, { queue: job.queue });
      // Do NOT reset the once-guard: it is keyed by unique jobId, so a new
      // turn's job simply isn't in it yet, and clearing it could let a
      // still-lagging stream outcome for a prior job re-fire.
      return;
    }
    const state: Follower = {
      deadline,
      jobs: new Map([[job.jobId, { queue: job.queue }]]),
      outcomeEmitted: new Set(),
    };
    followers.set(sessionId, state);
    void (async () => {
      // Events before startAfter belong to earlier turns whose UX was already
      // rendered (possibly by another replica), so they are skipped. The cursor
      // is NOT read here: by the time this runs the job is already enqueued, and
      // a fast node can have appended this turn's events, which would then be
      // skipped as backlog too.
      let lastId = startAfter;
      try {
        while (!closed && Date.now() < state.deadline) {
          try {
            for (const entry of await pubsub.readEvents(sessionId, lastId)) {
              lastId = entry.id;
              const e = entry.event as AgentEvent;
              if (!e || typeof e !== "object" || !("type" in e)) continue;
              if (e.type === "done" || e.type === "error") {
                // Authoritative turn outcome. Attribute it to a job still
                // awaiting one (outcomes are FIFO per session — turns are
                // serialized by the session lock) and emit exactly once. If
                // every in-flight job's outcome was already emitted — the
                // job-completion synthesizer beat the stream under lag —
                // suppress this duplicate re-emit so the user never gets a
                // second ✅/❌ for one turn.
                const target = [...state.jobs.keys()].find((id) => !state.outcomeEmitted.has(id));
                if (target === undefined) continue;
                state.outcomeEmitted.add(target);
                agent.emit("event", e);
                // Turn finished — linger briefly for stragglers, then stop
                // (unless a new enqueue pushed the deadline out again).
                state.deadline = Math.min(state.deadline, Date.now() + followLingerMs);
              } else {
                agent.emit("event", e);
              }
            }
          } catch (e) {
            console.error(`[dispatch] event follower read failed session=${sessionId}:`, e);
          }
          // Job completion is the AUTHORITATIVE turn outcome: the stream is a
          // capped, trimmable UX feed (spec §4 — anything that must not be
          // lost does not ride it). If a job settles and the stream never
          // delivered its done/error (trimmed gap, node crash between emit
          // and append), synthesize the outcome so the reaction/status/error
          // pipeline still closes the turn for the user.
          for (const [jobId, ref] of [...state.jobs]) {
            try {
              const j = await turns.queue(ref.queue).getJob(jobId);
              const jstate = j ? await j.getState() : "missing";
              if (jstate === "completed" || jstate === "failed" || jstate === "missing") {
                state.jobs.delete(jobId);
                state.deadline = Math.min(state.deadline, Date.now() + followLingerMs);
                // Synthesize the outcome only if the stream didn't already
                // deliver (and re-emit) it for THIS job. Same once-guard the
                // stream path consults+sets, so whichever fires first wins and
                // the other is suppressed — no double done, double error, or
                // done+error for one job.
                if (!state.outcomeEmitted.has(jobId)) {
                  state.outcomeEmitted.add(jobId);
                  console.warn(
                    `[dispatch] events-stream gap session=${sessionId} job=${jobId} state=${jstate} — synthesizing turn outcome`,
                  );
                  agent.emit("event", (jstate === "failed"
                    ? { type: "error", sessionId, error: "turn failed on the node (job failed; events stream gap)" }
                    : { type: "done", sessionId }) as AgentEvent);
                }
              }
            } catch {
              /* job lookup is best-effort; the stream path still runs */
            }
          }
          await sleep(followPollMs);
        }
      } finally {
        followers.delete(sessionId);
      }
    })();
  }

  return {
    pubsub,
    turns,
    registry,

    async dispatch(session: SessionRow, text: string, meta: DispatchMeta): Promise<void> {
      // A fresh user message supersedes any lingering abort: an /abort whose
      // flag no node ever consumed (all nodes down, turn never claimed) must
      // not silently kill THIS turn at claim time.
      await pubsub.consumeAbortFlag(session.id).catch(() => {});
      const personaId = meta.personaId ?? "default";
      // The tenant reaches the node through the job payload AND the token claim,
      // which /v1 checks against the requested tenant. Explicit meta wins (the
      // transport resolved it from slack_apps); otherwise fall back to the
      // session's own column, absent on sqlite, and finally to 'default'.
      const tenantId = meta.tenantId ?? (session as { tenant_id?: string }).tenant_id ?? "default";
      // Pre-mint the BullMQ job id so the token's `job` claim matches the job
      // it rides on — /v1/jobs/:id/token-refresh binds on it. On coalesce the
      // messages join an EXISTING job which keeps its own (matching) token.
      const jobId = randomUUID();
      const jobToken = mintJobToken({
        tenant: tenantId,
        persona: personaId,
        session: session.id,
        team: meta.teamId,
        channel: meta.channelId,
        thread: meta.threadTs,
        initiator: meta.userId,
        scope: "turn",
        job: jobId,
      });
      // Routing (spec §2): warm + fresh → the holding node's queue; anything
      // else → shared. A node receiving a per-node job it no longer holds
      // cold-resumes locally — it never bounces.
      const loc = await registry.lookup(session.id);
      const target: TurnTarget = loc && loc.fresh ? { node: loc.node } : "shared";
      // Capture the follower's cursor BEFORE the job becomes claimable. Once it
      // is enqueued a node can claim it and append the whole turn before the
      // follower starts; a cursor read after that point would treat this
      // turn's events as backlog and skip them. A failed read falls back to
      // following from the start of the stream, as a failed read did before.
      const startAfter = (await pubsub.lastEventId(session.id).catch(() => null)) ?? undefined;
      const res = await turns.enqueueTurn(
        {
          sessionId: session.id,
          tenantId,
          personaId,
          messages: [
            { ts: meta.eventTs, user: meta.userId, text, ...(meta.suppress ? { suppress: true } : {}) },
          ],
          jobToken,
          enqueuedAt: Date.now(),
        },
        target,
        jobId,
      );
      console.log(
        `[dispatch] session=${session.id} queue=${res.queue} job=${res.jobId} coalesced=${res.coalesced}`,
      );
      followEvents(session.id, { jobId: res.jobId, queue: res.queue }, startAfter);
    },

    async abort(sessionId: string): Promise<void> {
      await pubsub.publishAbort(sessionId);
    },

    async close(): Promise<void> {
      closed = true;
      followers.clear();
      await pubsub.close().catch(() => {});
      await turns.close().catch(() => {});
    },
  };
}
