import { env } from "../config/env";
import type { SubmitResult } from "./types";

const TIMEOUT_MS = 15_000;

/** An answer from the factory API that is not a success; `status` 0 = unreachable. */
export class FactoryError extends Error {
  /** Set on a 422 from artifact submission: every problem the contract check found. */
  readonly problems?: string[];
  constructor(readonly status: number, message: string, problems?: string[]) {
    super(message);
    if (problems) this.problems = problems;
  }
}

export interface StartRunInput {
  pipeline: string;
  channelId: string;
  threadTs: string;
  sessionId: string;
  starter: string;
  ticketRef?: string;
  request: string;
}

export interface ApprovalInput {
  gateId: string;
  stage: string;
  attempt?: number;
  decision: "approve" | "reject" | "answer";
  by: string;
  outcome?: string;
  note?: string;
  /** For `answer`: one non-empty answer per open question, in order. */
  answers?: string[];
}

export interface SubmitArtifactInput {
  stage: string;
  attempt: number;
  content: string;
  outcome?: string;
  checklist: Array<{ item: string; pass: boolean; note?: string }>;
}

/** The part of `GET /runs/:id` the stage card needs. */
export interface RunSummary {
  stage?: string;
  candidate?: { stage?: string; attempt?: number; artifact?: string; content?: string; outcome?: string; questions?: string[] };
}

async function call<T>(path: string, body: unknown, method: "POST" | "GET" = "POST"): Promise<T> {
  const base = env.workflow.serviceUrl();
  if (!base) throw new FactoryError(0, "SLAUDE_WORKFLOW_SERVICE_URL is empty");
  const token = env.workflow.serviceToken();
  let res: Response;
  try {
    res = await fetch(new URL(path, base), {
      method,
      headers: { ...(method === "POST" ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new FactoryError(0, `factory unreachable: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    let problems: string[] | undefined;
    try {
      const j = JSON.parse(text) as { error?: string; problems?: unknown };
      msg = j.error ?? text;
      if (Array.isArray(j.problems) && j.problems.every((p) => typeof p === "string")) problems = j.problems as string[];
    } catch {}
    throw new FactoryError(res.status, msg || `factory returned ${res.status}`, problems);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** The factory API (framework docs/04-http-contract.md). */
export const factory = {
  startRun: (i: StartRunInput) => call<{ runId: string; pipeline: string; pipelineVersion: number }>("/runs", i),
  approve: (runId: string, a: ApprovalInput) => call<Record<string, never>>(`/runs/${encodeURIComponent(runId)}/approvals`, a),
  submitArtifact: (runId: string, b: SubmitArtifactInput) => call<SubmitResult>(`/runs/${encodeURIComponent(runId)}/artifacts`, b),
  getRun: (runId: string) => call<RunSummary>(`/runs/${encodeURIComponent(runId)}`, undefined, "GET"),
  cancel: (runId: string, by: string) => call<Record<string, never>>(`/runs/${encodeURIComponent(runId)}/cancel`, { by }),
};
export type FactoryClient = typeof factory;
