import { env } from "../../config/env";
import * as Workflow from "../../db/workflow";
import { factory, FactoryError, type FactoryClient } from "../../workflow/client";
import type { SlashHit } from "../slack/commands";
import { settleStageGates } from "../slack/stage-gate";

type WorkflowHit = Extract<SlashHit, { kind: "workflow" }>;
type ParticipantHit = Extract<SlashHit, { kind: "participant" }>;

export interface WorkflowCommandCtx {
  channelId: string;
  threadTs: string;
  userId: string;
  sessionId: string;
  isManager: boolean;
  reply(text: string): Promise<void>;
}

/** The framework's run id for a thread (factory docs/03-engine.md): one run per thread. */
export const runIdFor = (channelId: string, threadTs: string) => `run-${channelId}-${threadTs}`;

const NOT_ENABLED = ":no_entry: Workflows are not enabled on this deployment (SLAUDE_WORKFLOW is off or SLAUDE_WORKFLOW_SERVICE_URL is empty).";

/**
 * Start a run in this thread with `starter` as the starter. Shared by `/workflow start`
 * and the agent's start_workflow tool. The thread row is written first, so a callback
 * from the factory that arrives before the start call returns can find the run.
 */
export async function startWorkflow(
  i: { channelId: string; threadTs: string; sessionId: string; starter: string; pipeline: string; ticketRef?: string; request: string },
  client: FactoryClient = factory,
): Promise<{ ok: true; runId: string; pipelineVersion: number } | { ok: false; message: string }> {
  if (!env.workflow.active()) return { ok: false, message: NOT_ENABLED };
  if (await Workflow.running(i.channelId, i.threadTs)) return { ok: false, message: "This thread already has a running workflow. `/workflow status` shows it." };
  const runId = runIdFor(i.channelId, i.threadTs);
  await Workflow.start({ channelId: i.channelId, threadTs: i.threadTs, sessionId: i.sessionId, runId, pipeline: i.pipeline, ticketRef: i.ticketRef, starter: i.starter });
  try {
    const r = await client.startRun({ pipeline: i.pipeline, channelId: i.channelId, threadTs: i.threadTs, sessionId: i.sessionId, starter: i.starter, ticketRef: i.ticketRef, request: i.request || "(see the thread)" });
    return { ok: true, runId: r.runId, pipelineVersion: r.pipelineVersion };
  } catch (e) {
    await Workflow.finish(runId);
    const err = e instanceof FactoryError ? e : new FactoryError(0, String(e));
    if (err.status === 409) return { ok: false, message: "The factory already has a running workflow for this thread." };
    if (err.status === 422) return { ok: false, message: `:x: ${err.message}` };
    return { ok: false, message: `:warning: Could not start the workflow: ${err.message}` };
  }
}

export async function handleWorkflowCommand(hit: WorkflowHit, ctx: WorkflowCommandCtx, client: FactoryClient = factory): Promise<void> {
  if (!env.workflow.active()) return ctx.reply(NOT_ENABLED);
  const { channelId, threadTs, userId } = ctx;

  if (hit.action === "usage") return ctx.reply("Usage: `/workflow start <pipeline> [TICKET-123 | text]`, `/workflow status`, `/workflow cancel`, `/workflow answer <answer 1> || <answer 2>`, `/workflow reject <reason>`.");

  if (hit.action === "start") {
    const r = await startWorkflow({ channelId, threadTs, sessionId: ctx.sessionId, starter: userId, pipeline: hit.pipeline, ticketRef: hit.ticketRef, request: hit.request }, client);
    if (!r.ok) return ctx.reply(r.message);
    return ctx.reply(`:gear: Workflow \`${hit.pipeline}@${r.pipelineVersion}\` started${hit.ticketRef ? ` for ${hit.ticketRef}` : ""} (run \`${r.runId}\`). <@${userId}> is the starter. Add approvers with \`/participant add @user\`.`);
  }

  const row = await Workflow.running(channelId, threadTs);
  if (!row) return ctx.reply("No running workflow in this thread. `/workflow start <pipeline> …` starts one.");

  if (hit.action === "status") {
    const people = await Workflow.participants(channelId, threadTs);
    return ctx.reply(
      `Workflow \`${row.pipeline}\`${row.ticket_ref ? ` for ${row.ticket_ref}` : ""}: stage *${row.stage ?? "starting"}*${row.attempt > 1 ? ` (attempt ${row.attempt})` : ""}. ` +
      `Starter <@${row.starter_user_id}>; participants: ${people.length ? people.map((u) => `<@${u}>`).join(", ") : "none"}.`,
    );
  }

  if (hit.action === "answer" || hit.action === "reject") {
    if (!(await Workflow.isApprover(channelId, threadTs, userId))) {
      return ctx.reply(`:no_entry: <@${userId}>, only this workflow's starter and participants can decide its stages. \`/participant list\` shows who.`);
    }
    const stage = row.stage;
    if (!stage) return ctx.reply("The workflow has not started a stage yet.");
    const attempt = row.attempt || 1;
    // Unique per command: an answer re-runs the stage, possibly at the same attempt, and a later
    // round of answers must not look like a repeat to the factory.
    const gateId = `cmd:${row.run_id}:${stage}:${attempt}:${hit.action}:${Date.now().toString(36)}`;
    try {
      if (hit.action === "reject") {
        await client.approve(row.run_id, { gateId, stage, attempt, decision: "reject", by: userId, note: hit.text });
        await settleStageGates(row.session_id, row.run_id, stage, userId, "denied");
        return ctx.reply(`:leftwards_arrow_with_hook: Stage *${stage}* rejected by <@${userId}>; it runs again with your reason.`);
      }
      const asked = (await client.getRun(row.run_id)).candidate?.questions ?? [];
      if (!asked.length) return ctx.reply("This stage has no open questions. Use `/workflow reject <reason>` to send it back.");
      const answers = hit.text.split("||").map((a) => a.trim()).filter(Boolean);
      if (answers.length !== asked.length) {
        return ctx.reply(`:warning: ${asked.length} question${asked.length > 1 ? "s are" : " is"} open and you gave ${answers.length} answer${answers.length === 1 ? "" : "s"}. Separate the answers with \`||\`, in order.`);
      }
      await client.approve(row.run_id, { gateId, stage, attempt, decision: "answer", by: userId, answers });
      await settleStageGates(row.session_id, row.run_id, stage, userId, "cancelled");
      return ctx.reply(`:speech_balloon: Answers recorded by <@${userId}>; stage *${stage}* runs again.`);
    } catch (e) {
      return ctx.reply(`:warning: The workflow did not accept that: ${(e as Error).message}`);
    }
  }

  // cancel
  if (row.starter_user_id !== userId && !ctx.isManager) return ctx.reply(`Only <@${row.starter_user_id}> or a manager can cancel this workflow.`);
  try {
    await client.cancel(row.run_id, userId);
  } catch (e) {
    return ctx.reply(`:warning: Could not cancel: ${(e as Error).message}`);
  }
  return ctx.reply(":octagonal_sign: Cancel sent; the workflow will close this thread shortly.");
}

export async function handleParticipantCommand(hit: ParticipantHit, ctx: WorkflowCommandCtx): Promise<void> {
  if (!env.workflow.active()) return ctx.reply(NOT_ENABLED);
  const { channelId, threadTs, userId } = ctx;
  const row = await Workflow.running(channelId, threadTs);
  if (!row) return ctx.reply("Start a workflow first: `/workflow start <pipeline> …`.");

  if (hit.action === "list") {
    const people = await Workflow.participants(channelId, threadTs);
    return ctx.reply(`May approve stages: <@${row.starter_user_id}> (starter)${people.map((u) => `, <@${u}>`).join("")}.`);
  }
  if (row.starter_user_id !== userId && !ctx.isManager) return ctx.reply(`Only <@${row.starter_user_id}> (the starter) or a manager can change participants.`);

  if (hit.action === "add") {
    const added = hit.userIds.filter((u) => u !== row.starter_user_id);
    for (const u of added) await Workflow.addParticipant(channelId, threadTs, u, userId);
    return ctx.reply(added.length ? `Added ${added.map((u) => `<@${u}>`).join(", ")}: they may approve this workflow's stages.` : "The starter can already approve.");
  }
  const removed: string[] = [];
  for (const u of hit.userIds) if (await Workflow.removeParticipant(channelId, threadTs, u)) removed.push(u);
  return ctx.reply(removed.length ? `Removed ${removed.map((u) => `<@${u}>`).join(", ")}.` : "None of them were participants.");
}
