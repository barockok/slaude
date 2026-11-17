/**
 * Callbacks from the factory (framework docs/04-http-contract.md): run a stage as a
 * turn in the run's thread, remind, finish. Its own prefix and bearer, like
 * /brain-import, mounted on gateway and mono only.
 *
 *   POST /workflow/v1/turns              { runId, stage, attempt, prompt, requestId, context?, artifact?, ... }
 *   POST /workflow/v1/runs/:runId/remind { stage, waitingSince }
 *   POST /workflow/v1/runs/:runId/finish { reason }
 *   POST /workflow/v1/runs/:runId/commit { requestId, path, content, message }
 *
 * With workflows off, or SLAUDE_WORKFLOW_CALLBACK_TOKEN unset or under 32 characters,
 * every path answers 404 before anything else is looked at.
 */
import { env } from "../config/env";
import * as Workflow from "../db/workflow";
import type { WorkflowThreadRow } from "../db/workflow";
import { timingSafeStringEqual } from "../gateway/api/auth";
import { json, readBodyCapped } from "../gateway/api/http";
import { MAX_COMMIT_CONTENT, parseMethodFields, type CommitRequest, type CommitResult, type TurnBody } from "./types";

const MIN_TOKEN_LENGTH = 32;
const MAX_BODY = 256 * 1024;

export interface WorkflowApiDeps {
  /** Run `prompt` as a turn in the run's session (replies go to its Slack thread). */
  injectTurn(row: WorkflowThreadRow, prompt: string): Promise<void>;
  /** Post a plain message in the run's thread (no agent turn). */
  post(row: WorkflowThreadRow, text: string): Promise<void>;
  /** Run a method stage (`context: "fresh"`) in an isolated agent run. Returns at once; the run reports in the thread. */
  runFreshTurn?(row: WorkflowThreadRow, turn: TurnBody): void;
  /** Write an approved artifact into the run's repo and commit it. */
  commit?(row: WorkflowThreadRow, c: CommitRequest): Promise<CommitResult>;
  /** Stop an in-flight fresh turn (the run finished or was cancelled). */
  abortRun?(runId: string): void;
}

const REQUEST_ID_RE = /^[A-Za-z0-9:._-]{1,200}$/;

/** A repo-relative path: no leading slash, no `..` or empty segment, no backslash or NUL. */
export function isSafeCommitPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 300) return false;
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function createWorkflowApi(deps: WorkflowApiDeps) {
  return async function fetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname !== "/workflow" && !url.pathname.startsWith("/workflow/")) return null;
    const token = env.workflow.callbackToken();
    if (!env.workflow.active() || token.length < MIN_TOKEN_LENGTH) return json(404, { error: "not found" });
    const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    if (!m || !timingSafeStringEqual(m[1]!, token)) return json(401, { error: "invalid or missing workflow callback token" });
    if (req.method !== "POST") return json(405, { error: "method not allowed" });

    const raw = await readBodyCapped(req, MAX_BODY);
    if (raw === null) return json(413, { error: "body too large" });
    let body: any;
    try { body = JSON.parse(raw || "{}"); } catch { return json(400, { error: "invalid JSON" }); }

    if (url.pathname === "/workflow/v1/turns") {
      const { runId, stage, attempt, prompt, requestId } = body ?? {};
      if (typeof runId !== "string" || typeof stage !== "string" || typeof prompt !== "string" || typeof requestId !== "string" || !Number.isInteger(attempt)) {
        return json(400, { error: "runId, stage, attempt, prompt and requestId are required" });
      }
      const method = parseMethodFields(body);
      if ("error" in method) return json(400, { error: method.error });
      const row = await Workflow.findByRun(runId);
      if (!row) return json(404, { error: "unknown run" });
      if (row.status !== "running") return json(409, { error: "run is finished" });
      const fresh = method.context === "fresh";
      // Checked before beginStage, so the same turn can be retried once the flag is on.
      if (fresh && (!env.workflow.methodEnabled() || !deps.runFreshTurn)) return json(409, { error: "method stages are not enabled" });
      // An activity retry repeats the requestId: answer 200 without a second turn.
      if (!(await Workflow.beginStage(runId, stage, attempt, requestId))) return json(200, { duplicate: true });
      if (fresh) deps.runFreshTurn!(row, { runId, stage, attempt, prompt, requestId, ...method });
      else await deps.injectTurn(row, prompt);
      return json(200, { ok: true });
    }

    const seg = url.pathname.split("/").filter(Boolean); // workflow v1 runs :id remind|finish
    if (seg.length === 5 && seg[1] === "v1" && seg[2] === "runs" && (seg[4] === "remind" || seg[4] === "finish" || seg[4] === "commit")) {
      let runId: string;
      try { runId = decodeURIComponent(seg[3]!); } catch { return json(404, { error: "not found" }); }
      const row = await Workflow.findByRun(runId);
      if (!row) return json(404, { error: "unknown run" });
      if (seg[4] === "commit") {
        if (!deps.commit) return json(501, { error: "commit is not available" });
        // The factory retries any non-2xx without end, so a finished run is answered, not refused.
        if (row.status !== "running") return json(200, { skipped: "run is finished" });
        const { requestId, path, content, message } = body ?? {};
        if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) return json(400, { error: "requestId is missing or has characters outside A-Z a-z 0-9 : . _ -" });
        if (!isSafeCommitPath(path)) return json(400, { error: "path must be relative, without .. segments" });
        if (typeof content !== "string" || content.length > MAX_COMMIT_CONTENT) return json(400, { error: `content must be a string of at most ${MAX_COMMIT_CONTENT} characters` });
        if (typeof message !== "string" || message.length < 1 || message.length > 500 || message.includes("\0")) return json(400, { error: "message must be 1 to 500 characters" });
        try {
          return json(200, await deps.commit(row, { requestId, path, content, message }));
        } catch (e) {
          return json(502, { error: `commit failed: ${(e as Error).message}`.slice(0, 300) });
        }
      }
      if (seg[4] === "remind") {
        if (row.status === "running") {
          const people = [row.starter_user_id, ...(await Workflow.participants(row.channel_id, row.thread_ts))];
          await deps.post(row, `:hourglass: Stage *${body?.stage ?? row.stage}* is still waiting for an approval from ${people.map((u) => `<@${u}>`).join(", ")}.`);
        }
        return json(200, { ok: true });
      }
      // finish: idempotent, the closing line is posted once.
      if (row.status === "running") {
        await Workflow.finish(runId);
        deps.abortRun?.(runId);
        await deps.post(row, `:checkered_flag: Workflow \`${row.pipeline}\`${row.ticket_ref ? ` for ${row.ticket_ref}` : ""} finished: *${String(body?.reason ?? "done")}*.`);
      }
      return json(200, { ok: true });
    }
    return json(404, { error: "not found" });
  };
}
