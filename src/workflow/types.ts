/** Shapes shared by the workflow callbacks, the fresh-turn runner and the submit tool. */

export interface ArtifactSpec {
  name: string;
  checklist?: string[];
  outcomes?: string[];
  outcomeRequired?: boolean;
}

/** `POST /workflow/v1/turns` as the workflow service sends it. */
export interface TurnBody {
  runId: string;
  stage: string;
  attempt: number;
  prompt: string;
  requestId: string;
  model?: string;
  effort?: string;
  /** "fresh": a method stage, run in an isolated agent context. */
  context?: "fresh";
  promptHash?: string;
  artifact?: ArtifactSpec;
  /** Where the stage works. Absent until the workflow service sends it. */
  runsIn?: "host" | "sandbox";
}

/** Factory caps an artifact at 64 KB; the sandbox shell takes the content in one argument. */
export const MAX_COMMIT_CONTENT = 64 * 1024;

/** `POST /workflow/v1/runs/:id/commit` */
export interface CommitRequest {
  requestId: string;
  path: string;
  content: string;
  message: string;
}
export type CommitResult = { sha: string } | { skipped: string };

export interface ChecklistAnswer {
  item: string;
  pass: boolean;
  note?: string;
}

/** The workflow service's answer to an accepted artifact submission. */
export interface SubmitResult {
  hash: string;
  questions: string[];
  approvable: boolean;
}

/** An artifact the agent submitted, as the stage card shows it. */
export interface SubmittedArtifact {
  name: string;
  content: string;
  outcome?: string;
  checklist: ChecklistAnswer[];
}

/** Parse the optional method fields of a turn body. Returns an error message, or the fields. */
export function parseMethodFields(body: Record<string, unknown>): { error: string } | { context?: "fresh"; promptHash?: string; artifact?: ArtifactSpec; model?: string; effort?: string; runsIn?: "host" | "sandbox" } {
  const { context, promptHash, artifact, model, effort, runsIn } = body;
  if (context !== undefined && context !== "fresh") return { error: 'context must be "fresh" when present' };
  if (promptHash !== undefined && typeof promptHash !== "string") return { error: "promptHash must be a string" };
  if (model !== undefined && typeof model !== "string") return { error: "model must be a string" };
  if (effort !== undefined && typeof effort !== "string") return { error: "effort must be a string" };
  if (runsIn !== undefined && runsIn !== "host" && runsIn !== "sandbox") return { error: 'runsIn must be "host" or "sandbox"' };
  let spec: ArtifactSpec | undefined;
  if (artifact !== undefined) {
    const a = artifact as Record<string, unknown> | null;
    const strings = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
    if (!a || typeof a !== "object" || typeof a.name !== "string" || !a.name) return { error: "artifact.name is required" };
    if (!strings(a.checklist) || !strings(a.outcomes)) return { error: "artifact.checklist and artifact.outcomes must be string arrays" };
    if (a.outcomeRequired !== undefined && typeof a.outcomeRequired !== "boolean") return { error: "artifact.outcomeRequired must be a boolean" };
    spec = { name: a.name, ...(a.checklist ? { checklist: a.checklist as string[] } : {}), ...(a.outcomes ? { outcomes: a.outcomes as string[] } : {}), ...(a.outcomeRequired !== undefined ? { outcomeRequired: a.outcomeRequired as boolean } : {}) };
  }
  return {
    ...(context ? { context } : {}),
    ...(promptHash ? { promptHash } : {}),
    ...(spec ? { artifact: spec } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(runsIn ? { runsIn } : {}),
  };
}
