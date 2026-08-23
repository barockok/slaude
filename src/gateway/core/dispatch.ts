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
    /** A done/error arrived via the stream since the last enqueue. */
    sawOutcome: boolean;
  };
  const followers = new Map<string, Follower>();
  let closed = false;

  function followEvents(sessionId: string, job: { jobId: string; queue: string }): void {
    const existing = followers.get(sessionId);
    const deadline = Date.now() + followMaxMs;
    if (existing) {
      existing.deadline = Math.max(existing.deadline, deadline);
      existing.jobs.set(job.jobId, { queue: job.queue });
      existing.sawOutcome = false;
      return;
    }
    const state: Follower = { deadline, jobs: new Map([[job.jobId, { queue: job.queue }]]), sawOutcome: false };
    followers.set(sessionId, state);
    void (async () => {
      let lastId: string | undefined;
      try {
        // Skip the backlog: events already on the stream belong to earlier
        // turns whose UX was already rendered (possibly by another replica).
        lastId = (await pubsub.readEvents(sessionId)).at(-1)?.id;
      } catch {}
      try {
        while (!closed && Date.now() < state.deadline) {
          try {
            for (const entry of await pubsub.readEvents(sessionId, lastId)) {
              lastId = entry.id;
              const e = entry.event as AgentEvent;
              if (!e || typeof e !== "object" || !("type" in e)) continue;
              agent.emit("event", e);
              if (e.type === "done" || e.type === "error") {
                state.sawOutcome = true;
                // Turn finished — linger briefly for stragglers, then stop
                // (unless a new enqueue pushed the deadline out again).
                state.deadline = Math.min(state.deadline, Date.now() + followLingerMs);
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
                if (!state.sawOutcome) {
                  console.warn(
                    `[dispatch] events-stream gap session=${sessionId} job=${jobId} state=${jstate} — synthesizing turn outcome`,
                  );
                  agent.emit("event", (jstate === "failed"
                    ? { type: "error", sessionId, error: "turn failed on the node (job failed; events stream gap)" }
                    : { type: "done", sessionId }) as AgentEvent);
                  state.sawOutcome = true;
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
      // Pre-mint the BullMQ job id so the token's `job` claim matches the job
      // it rides on — /v1/jobs/:id/token-refresh binds on it. On coalesce the
      // messages join an EXISTING job which keeps its own (matching) token.
      const jobId = randomUUID();
      const jobToken = mintJobToken({
        tenant: "default",
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
      const res = await turns.enqueueTurn(
        {
          sessionId: session.id,
          tenantId: "default",
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
      followEvents(session.id, { jobId: res.jobId, queue: res.queue });
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
