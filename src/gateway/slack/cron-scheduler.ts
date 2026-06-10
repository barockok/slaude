import type { AgentManager } from "../../agent/manager";
import type { WebClient } from "@slack/web-api";
import * as CronJobs from "../../db/cron-jobs";
import { getNextRun } from "./cron-parser";

export type CronSchedulerDeps = {
  agent: AgentManager;
  client: WebClient;
  /** Called before sendMessage so the adapter can register a route + SlackContext
   *  for this cron session. Without a route, agent events are silently dropped. */
  onExecute?: (job: CronJobs.CronJob, sessionId: string) => void;
};

export class CronScheduler {
  #agent: AgentManager;
  #client: WebClient;
  #onExecute?: (job: CronJobs.CronJob, sessionId: string) => void;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = new Set<string>(); // job ids currently executing

  constructor(deps: CronSchedulerDeps) {
    this.#agent = deps.agent;
    this.#client = deps.client;
    this.#onExecute = deps.onExecute;
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
    const due = CronJobs.findDue(now);
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
      CronJobs.updateNextRun(job.id, getNextRun(job.cronExpr), "error: missing Slack keys");
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
    };

    const session = this.#agent.ensureSession(threadKey);

    // Cron fires by default even when the thread/channel session is live — scheduled
    // jobs run on time regardless of human activity. (Same-job re-entry is still
    // guarded by #running in #tick.)

    // Let the adapter register a route so this session gets Slack MCP tools.
    this.#onExecute?.(job, session.id);

    const envelope = `[scheduled] ${job.prompt}\n\nReply with the result. This is a cron job.`;

    // Wait for completion before clearing #running and updating next_run.
    // AgentManager emits "event" payloads — never raw "done"/"error" events.
    const onDone = (e: any) => {
      if (e.sessionId !== session.id) return;
      this.#agent.off("event", onEvent);
      const nextRun = getNextRun(job.cronExpr);
      CronJobs.updateNextRun(job.id, nextRun, "completed");
      this.#running.delete(job.id);
    };
    const onError = (e: any) => {
      if (e.sessionId !== session.id) return;
      this.#agent.off("event", onEvent);
      const nextRun = getNextRun(job.cronExpr);
      CronJobs.updateNextRun(job.id, nextRun, `error: ${e.error ?? "unknown"}`);
      this.#running.delete(job.id);
    };
    const onEvent = (e: any) => {
      if (e.type === "done") onDone(e);
      else if (e.type === "error") onError(e);
    };
    this.#agent.on("event", onEvent);

    try {
      await this.#agent.sendMessage(session.id, envelope);
    } catch (e: any) {
      console.error(`[cron] job ${job.id} failed to send:`, e?.message ?? e);
      this.#agent.off("event", onEvent);
      CronJobs.updateNextRun(job.id, getNextRun(job.cronExpr), `error: ${e?.message ?? "unknown"}`);
      this.#running.delete(job.id);
    }
  }
}
