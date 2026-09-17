import type { AgentManager } from "../../agent/manager";
import type { SessionRow } from "../../db/schema";
import type { WebClient } from "@slack/web-api";
import * as CronJobs from "../../db/cron-jobs";
import { getNextRun } from "./cron-parser";

export type CronSchedulerDeps = {
  agent: AgentManager;
  client: WebClient;
  /**
   * How a cron turn is delivered. The gateway role injects the queue dispatch
   * so the turn runs on a node like every other turn; without it the scheduler
   * runs the turn in this process, which is what mono wants.
   */
  send?: (i: {
    session: SessionRow;
    envelope: string;
    job: CronJobs.CronJob;
    /** Thread the run's session is keyed on — synthetic for channel targets. */
    threadTs: string;
  }) => Promise<void>;
  /**
   * Whether a turn for this session is already in flight. Defaults to this
   * process's own agent, which is only the whole truth in mono: under the split
   * the turn runs on a node, so the gateway injects a cluster-wide check.
   */
  isLive?: (sessionId: string) => Promise<boolean>;
  /** Called before sendMessage so the adapter can register a route + SlackContext
   *  for this cron session. Without a route, agent events are silently dropped. */
  onExecute?: (job: CronJobs.CronJob, sessionId: string) => void;
};

export class CronScheduler {
  #agent: AgentManager;
  #client: WebClient;
  #onExecute?: (job: CronJobs.CronJob, sessionId: string) => void;
  #send?: CronSchedulerDeps["send"];
  #isLive?: CronSchedulerDeps["isLive"];
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = new Set<string>(); // job ids currently executing

  constructor(deps: CronSchedulerDeps) {
    this.#agent = deps.agent;
    this.#client = deps.client;
    this.#onExecute = deps.onExecute;
    this.#send = deps.send;
    this.#isLive = deps.isLive;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#tick(), 60_000);
    // Run once immediately
    void this.#tick();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #tick(): Promise<void> {
    const now = Date.now();
    const due = await CronJobs.findDue(now);
    for (const job of due) {
      if (this.#running.has(job.id)) continue;
      this.#running.add(job.id);
      void this.#execute(job);
    }
  }

  async #execute(job: CronJobs.CronJob): Promise<void> {
    // Legacy jobs without real Slack keys can't post — skip and mark error.
    if (!job.slackTeamId || !job.slackChannelId) {
      console.error(`[cron] job ${job.id} missing Slack keys (legacy job) — skipping`);
      await CronJobs.updateNextRun(job.id, getNextRun(job.cronExpr), "error: missing Slack keys");
      this.#running.delete(job.id);
      return;
    }

    // Channel-target jobs broadcast to channel root — never bind a real thread, so
    // the session key is always the internal cron id (persistent across runs).
    const threadTs =
      job.target === "channel" ? `cron:${job.id}` : job.slackThreadTs ?? `cron:${job.id}`;
    const threadKey = {
      team_id: job.slackTeamId,
      channel_id: job.slackChannelId,
      thread_ts: threadTs,
      // Key the run's session on the owning persona so ensureSession resolves the
      // persona's soul + brain slice + config dir + cwd (all keyed off persona_id).
      persona_id: job.personaId,
    };

    const session = await this.#agent.ensureSession(threadKey);

    // Jobs created inside a /1on1 carry the lock owner. The run keys on a
    // synthetic `cron:<id>` thread with no lock, so hand the initiator to the
    // manager directly — it boots the child under the initiator's OAuth config
    // dir (same isolation the interactive 1on1 session gets). No-op otherwise.
    if (job.oauthUser) this.#agent.setCronOAuthUser(session.id, job.oauthUser);

    // Cron fires by default even when the thread/channel session is live. A job may
    // opt into passive mode (when_active='skip') to defer the run while a human is
    // active — they get priority for that tick. (Same-job re-entry is still guarded
    // by #running in #tick.)
    const live = this.#isLive ? await this.#isLive(session.id) : this.#agent.isLive(session.id);
    if (job.whenActive === "skip" && live) {
      console.log(`[cron] job ${job.id} skipped — session ${session.id} is live (when_active=skip)`);
      await CronJobs.updateNextRun(job.id, getNextRun(job.cronExpr), "skipped: session live");
      this.#running.delete(job.id);
      return;
    }

    // Let the adapter register a route so this session gets Slack MCP tools.
    this.#onExecute?.(job, session.id);

    const envelope = `[scheduled] ${job.prompt}\n\nReply with the result. This is a cron job.`;

    // Wait for completion before clearing #running and updating next_run.
    // AgentManager emits "event" payloads — never raw "done"/"error" events.
    const onDone = async (e: any) => {
      if (e.sessionId !== session.id) return;
      this.#agent.off("event", onEvent);
      const nextRun = getNextRun(job.cronExpr);
      await CronJobs.updateNextRun(job.id, nextRun, "completed");
      this.#running.delete(job.id);
    };
    const onError = async (e: any) => {
      if (e.sessionId !== session.id) return;
      this.#agent.off("event", onEvent);
      const nextRun = getNextRun(job.cronExpr);
      await CronJobs.updateNextRun(job.id, nextRun, `error: ${e.error ?? "unknown"}`);
      this.#running.delete(job.id);
    };
    const onEvent = (e: any) => {
      if (e.type === "done") void onDone(e);
      else if (e.type === "error") void onError(e);
    };
    this.#agent.on("event", onEvent);

    try {
      if (this.#send) await this.#send({ session, envelope, job, threadTs });
      else await this.#agent.sendMessage(session.id, envelope);
    } catch (e: any) {
      console.error(`[cron] job ${job.id} failed to send:`, e?.message ?? e);
      this.#agent.off("event", onEvent);
      await CronJobs.updateNextRun(job.id, getNextRun(job.cronExpr), `error: ${e?.message ?? "unknown"}`);
      this.#running.delete(job.id);
    }
  }
}
