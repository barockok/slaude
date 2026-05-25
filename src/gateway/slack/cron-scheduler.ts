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

    const threadKey = {
      team_id: job.slackTeamId,
      channel_id: job.slackChannelId,
      thread_ts: job.slackThreadTs ?? `cron:${job.id}`,
    };

    const session = this.#agent.ensureSession(threadKey);

    // Skip if humans are actively chatting in this thread — they get priority.
    if (this.#agent.isLive(session.id)) {
      console.log(`[cron] job ${job.id} skipped — session ${session.id} is live (human active)`);
      CronJobs.updateNextRun(job.id, getNextRun(job.cronExpr), "skipped: session live");
      this.#running.delete(job.id);
      return;
    }

    // Let the adapter register a route so this session gets Slack MCP tools.
    this.#onExecute?.(job, session.id);

    const envelope = `[scheduled] ${job.prompt}\n\nReply with the result. This is a cron job.`;

    // Wait for completion before clearing #running and updating next_run.
    const onDone = () => {
      this.#agent.off("done", onDone);
      this.#agent.off("error", onError);
      const nextRun = getNextRun(job.cronExpr);
      CronJobs.updateNextRun(job.id, nextRun, "completed");
      this.#running.delete(job.id);
    };
    const onError = (e: any) => {
      // Only handle errors for this specific session
      if (e.sessionId !== session.id) return;
      this.#agent.off("done", onDone);
      this.#agent.off("error", onError);
      const nextRun = getNextRun(job.cronExpr);
      CronJobs.updateNextRun(job.id, nextRun, `error: ${e.error ?? "unknown"}`);
      this.#running.delete(job.id);
    };
    this.#agent.on("done", onDone);
    this.#agent.on("error", onError);

    try {
      await this.#agent.sendMessage(session.id, envelope);
    } catch (e: any) {
      console.error(`[cron] job ${job.id} failed to send:`, e?.message ?? e);
      this.#agent.off("done", onDone);
      this.#agent.off("error", onError);
      CronJobs.updateNextRun(job.id, getNextRun(job.cronExpr), `error: ${e?.message ?? "unknown"}`);
      this.#running.delete(job.id);
    }
  }
}
