import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../config/env";
import { scrubChildEnv, TOOLS_SURVIVING_EMPTY_SET } from "../agent/child-env";
import type { WorkflowThreadRow } from "../db/workflow";
import type { AppRef } from "../gateway/core/transport";
import { chunkText, type StageGate } from "../gateway/slack/stage-gate";
import { REMOTE_MCP_NAME, sandboxMcpServer } from "../remote/mcp";
import type { FactoryClient } from "./client";
import { createSubmitServer, SUBMIT_TOOL_NAME, WORKFLOW_MCP_NAME } from "./submit-tool";
import type { SubmittedArtifact, TurnBody } from "./types";

/** Sandbox tools a code stage may call. git_push is left out: pushing stays a separate, approved step. */
export const SANDBOX_TOOLS = ["bash", "bash_output", "bash_kill", "read", "write", "edit", "glob", "grep", "git_fetch"].map((n) => `mcp__${REMOTE_MCP_NAME}__${n}`);

/** Added after the factory's prompt. The factory's prompt already holds the persona, the inputs and the output contract. */
export const FOOTER =
  "\n\n---\nYour final message is posted in the thread for the people on this workflow. " +
  "When this stage produces an artifact, submit it with the submit_artifact tool before you finish. " +
  "Do not start the next stage.";

const START_MESSAGE = "Run the stage described in your instructions now.";

export interface FreshRunnerDeps {
  /** Test seam, as in defaultRunSubQuery. */
  query?: typeof sdkQuery;
  makeSubmitServer?: typeof createSubmitServer;
  post(row: WorkflowThreadRow, text: string): Promise<void>;
  stageGate: Pick<StageGate, "post" | "postArtifactCard">;
  client: Pick<FactoryClient, "submitArtifact">;
  /** The thread is in sandbox mode. */
  inSandbox(row: WorkflowThreadRow): Promise<boolean>;
  /** Switch the thread to sandbox mode for a code stage. Only called when allowed. */
  enterSandbox(row: WorkflowThreadRow): Promise<void>;
  app(row: WorkflowThreadRow): AppRef | Promise<AppRef>;
}

interface TurnState {
  submitted: boolean;
  cardError: string | null;
  finalText: string;
}

/**
 * What the fresh run mounts, decided from the turn and the thread:
 *   host stage      no sandbox;
 *   sandbox stage   the sandbox (the thread must be in sandbox mode: switched on here when the
 *                   starter may, else the stage stops with a message);
 *   unknown         the sandbox only when the thread is already in sandbox mode.
 */
export async function planSandbox(deps: Pick<FreshRunnerDeps, "inSandbox" | "enterSandbox">, row: WorkflowThreadRow, turn: TurnBody): Promise<{ mount: boolean } | { error: string }> {
  if (turn.runsIn === "host") return { mount: false };
  const url = env.sandbox.activeUrl();
  const inSandbox = await deps.inSandbox(row);
  if (turn.runsIn !== "sandbox") return { mount: !!url && inSandbox };
  if (!url) return { error: `Stage ${turn.stage} works in a sandbox, and sandbox mode is not enabled on this deployment.` };
  if (inSandbox) return { mount: true };
  if (!env.sandbox.autoAllowed(row.starter_user_id)) {
    return { error: `Stage ${turn.stage} works in a sandbox. Ask a manager for sandbox access, or run \`/sandbox on\` here, then reject the stage to run it again.` };
  }
  await deps.enterSandbox(row);
  return { mount: true };
}

/** The SDK options for one fresh run. A plain-string system prompt means no soul, no memory block and no preset. */
export function freshOptions(i: { turn: TurnBody; mcpServers: Record<string, unknown>; allowedTools: string[]; abortController: AbortController }) {
  return {
    systemPrompt: i.turn.prompt + FOOTER,
    model: i.turn.model || env.model() || undefined,
    // No local Bash, Read or Write: they would run in the slaude pod. The sandbox tools come in through mcpServers.
    tools: [] as string[],
    allowedTools: i.allowedTools,
    disallowedTools: [...TOOLS_SURVIVING_EMPTY_SET],
    // Deny anything not allow-listed: this run has no one to ask.
    permissionMode: "dontAsk" as const,
    strictMcpConfig: true,
    // No settings, no plugins, so no skills the agent wrote for itself.
    settingSources: [] as never[],
    mcpServers: i.mcpServers as any,
    abortController: i.abortController,
    env: scrubChildEnv({ ...process.env }),
  };
}

export function createFreshRunner(deps: FreshRunnerDeps): { run(row: WorkflowThreadRow, turn: TurnBody): Promise<void>; abort(runId: string): void; active(): number } {
  const live = new Map<string, AbortController>();
  const runQuery = deps.query ?? sdkQuery;
  const makeSubmit = deps.makeSubmitServer ?? createSubmitServer;

  const say = async (row: WorkflowThreadRow, text: string) => {
    for (const part of chunkText(text)) await deps.post(row, part).catch((e) => console.error(`[workflow] post failed run=${row.run_id}: ${(e as Error).message}`));
  };

  async function execute(row: WorkflowThreadRow, turn: TurnBody, ctl: AbortController): Promise<void> {
    const state: TurnState = { submitted: false, cardError: null, finalText: "" };
    const plan = await planSandbox(deps, row, turn);
    if ("error" in plan) return say(row, `:warning: ${plan.error}`);

    const mcpServers: Record<string, unknown> = {};
    const allowedTools: string[] = [];
    if (turn.artifact) {
      mcpServers[WORKFLOW_MCP_NAME] = makeSubmit({
        row, stage: turn.stage, attempt: turn.attempt, spec: turn.artifact, client: deps.client,
        onSubmitted: async (result, artifact: SubmittedArtifact) => {
          state.submitted = true;
          const r = await deps.stageGate.postArtifactCard({ channel: row.channel_id, threadTs: row.thread_ts, app: await deps.app(row), sessionId: row.session_id, stage: turn.stage, artifact, result });
          if ("error" in r) { state.cardError = r.error; throw new Error(r.error); }
        },
      });
      allowedTools.push(SUBMIT_TOOL_NAME);
    }
    if (plan.mount) {
      mcpServers[REMOTE_MCP_NAME] = sandboxMcpServer(env.sandbox.activeUrl(), row.session_id);
      allowedTools.push(...SANDBOX_TOOLS);
    }

    let timedOut = false;
    const timeoutMs = env.workflow.freshTimeoutMs();
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    try {
      const sdk = runQuery({
        prompt: (async function* () { yield { type: "user" as const, message: { role: "user" as const, content: START_MESSAGE }, parent_tool_use_id: null }; })() as any,
        options: freshOptions({ turn, mcpServers, allowedTools, abortController: ctl }) as any,
      });
      for await (const msg of sdk as AsyncIterable<any>) {
        if (msg.type === "assistant") {
          const text = (msg.message?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
          if (text) state.finalText = text;
        } else if (msg.type === "result" && typeof msg.result === "string" && msg.result.trim()) {
          state.finalText = msg.result.trim();
        }
      }
    } catch (e) {
      if (timedOut) return say(row, `:stopwatch: Stage *${turn.stage}* timed out after ${Math.round(timeoutMs / 60000)} minutes.`);
      if (ctl.signal.aborted) return; // the run finished or was cancelled
      return say(row, `:warning: Stage *${turn.stage}* failed: ${((e as Error).message ?? "unknown error").slice(0, 300)}`);
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) return say(row, `:stopwatch: Stage *${turn.stage}* timed out after ${Math.round(timeoutMs / 60000)} minutes.`);
    if (ctl.signal.aborted) return;

    if (state.finalText) await say(row, state.finalText);
    if (turn.artifact) {
      if (!state.submitted) {
        await say(row, `:warning: Stage *${turn.stage}* ended without a submitted artifact. Reject the stage with \`/workflow reject <reason>\` to run it again.`);
      } else if (state.cardError) {
        await say(row, `:warning: The artifact was accepted, but its approval card could not be posted (${state.cardError}). Reject the stage to run it again.`);
      }
      return; // the submit tool posted the card
    }
    // A stage that produces no artifact: the card carries what the agent said.
    const summary = (state.finalText || "(no output)").slice(0, 2800);
    const r = await deps.stageGate.post({ channel: row.channel_id, threadTs: row.thread_ts, app: await deps.app(row), sessionId: row.session_id, stage: turn.stage, summary });
    if ("error" in r) await say(row, `:warning: Could not post the approval card: ${r.error}`);
  }

  return {
    /** Starts the run and resolves when it ends. Never rejects; failures are posted in the thread. */
    run(row, turn) {
      live.get(row.run_id)?.abort(); // a re-run of the stage replaces one still going
      const ctl = new AbortController();
      live.set(row.run_id, ctl);
      return execute(row, turn, ctl)
        .catch((e) => say(row, `:warning: Stage *${turn.stage}* failed: ${((e as Error).message ?? "unknown error").slice(0, 300)}`))
        .finally(() => { if (live.get(row.run_id) === ctl) live.delete(row.run_id); });
    },
    abort(runId) {
      live.get(runId)?.abort();
      live.delete(runId);
    },
    active: () => live.size,
  };
}
