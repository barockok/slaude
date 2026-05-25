import type { AgentManager } from "../../agent/manager";
import type { WebClient } from "@slack/web-api";
import * as CronJobs from "../../db/cron-jobs";
import { getNextRun } from "./cron-parser";

export type CronSchedulerDeps = {
  agent: AgentManager;
  client: WebClient;
};

export class CronScheduler {
  #agent: AgentManager;
  #client: WebClient;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = new Set<string>(); // job ids currently executing

  constructor(deps: CronSchedulerDeps) {
    this.#agent = deps.agent;
    this.#client = deps.client;
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
    try {
      const session = this.#agent.ensureSession({
        team_id: "cron",
        channel_id: `cron:${job.id}`,
        thread_ts: `cron:${job.id}`,
      });

      const envelope = `[scheduled] ${job.prompt}\n\nReply with the result. This is a cron job.`;
      await this.#agent.sendMessage(session.id, envelope);

      // Note: we don't wait for agent completion here — the agent fires async.
      // Instead we update lastResult on the next tick or via event listener.
      // For simplicity, mark as done and compute next run.
      const nextRun = getNextRun(job.cronExpr);
      CronJobs.updateNextRun(job.id, nextRun, "dispatched");
    } catch (e: any) {
      console.error(`[cron] job ${job.id} failed:`, e?.message ?? e);
      CronJobs.updateNextRun(job.id, getNextRun(job.cronExpr), `error: ${e?.message ?? "unknown"}`);
    } finally {
      this.#running.delete(job.id);
    }
  }

  /** Post a result message to the job's channel. Called by adapter when agent completes. */
  async postResult(jobId: string, text: string): Promise<void> {
    const job = CronJobs.findById(jobId);
    if (!job) return;
    try {
      await this.#client.chat.postMessage({
        channel: job.channelId,
        thread_ts: job.threadTs ?? undefined,
        text,
        mrkdwn: true,
      });
      CronJobs.updateNextRun(jobId, getNextRun(job.cronExpr), "completed");
    } catch (e: any) {
      console.error(`[cron] failed to post result for ${jobId}:`, e?.message ?? e);
    }
  }
}
