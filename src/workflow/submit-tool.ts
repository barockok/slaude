import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { WorkflowThreadRow } from "../db/workflow";
import { FactoryError, type FactoryClient } from "./client";
import type { ArtifactSpec, ChecklistAnswer, SubmitResult, SubmittedArtifact } from "./types";

export const WORKFLOW_MCP_NAME = "slaude_workflow";
export const SUBMIT_TOOL_NAME = `mcp__${WORKFLOW_MCP_NAME}__submit_artifact`;
const MAX_CONTENT = 64 * 1024;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export interface SubmitToolInput {
  row: WorkflowThreadRow;
  stage: string;
  attempt: number;
  spec: ArtifactSpec;
  client: Pick<FactoryClient, "submitArtifact">;
  /** Called after the workflow service accepted the artifact; posts the stage card. May throw. */
  onSubmitted(result: SubmitResult, artifact: SubmittedArtifact): Promise<void>;
}

export interface SubmitArgs {
  content: string;
  outcome?: string;
  checklist: ChecklistAnswer[];
}

/** The tool text the agent reads: what to submit, the checklist to answer, the outcomes it may pick. */
export function submitDescription(spec: ArtifactSpec): string {
  const lines = [
    `Submit the "${spec.name}" artifact for this stage. Call it once the document is complete; a person reviews it next.`,
    "The workflow service checks it against its template. If it refuses, the tool returns every problem: fix them all and submit again in this turn.",
  ];
  if (spec.checklist?.length) {
    lines.push("Answer every checklist item with pass or fail (a fail needs a note):", ...spec.checklist.map((c, i) => `${i + 1}. ${c}`));
  }
  if (spec.outcomes?.length) {
    lines.push(`${spec.outcomeRequired ? "Required" : "Optional"} outcome, one of: ${spec.outcomes.join(", ")}.`);
  }
  return lines.join("\n");
}

/** The handler on its own, so tests can drive it without the MCP transport. */
export function submitArtifactHandler(i: SubmitToolInput): (a: SubmitArgs) => Promise<ToolResult> {
  return async (a) => {
    let result: SubmitResult;
    try {
      result = await i.client.submitArtifact(i.row.run_id, {
        stage: i.stage, attempt: i.attempt, content: a.content,
        ...(a.outcome !== undefined ? { outcome: a.outcome } : {}),
        checklist: a.checklist,
      });
    } catch (e) {
      if (e instanceof FactoryError && e.status === 422) {
        const problems = e.problems?.length ? e.problems : [e.message];
        return fail(`The artifact does not meet its contract. Fix every problem below and submit again in this turn:\n${problems.map((p) => `- ${p}`).join("\n")}`);
      }
      if (e instanceof FactoryError && e.status === 409) return fail("The run is no longer at this stage or attempt. Stop; do not submit again.");
      return fail(`The workflow service could not be reached (${(e as Error).message}). Try once more; if it fails again, say so in your final message.`);
    }
    try {
      await i.onSubmitted(result, { name: i.spec.name, content: a.content, ...(a.outcome !== undefined ? { outcome: a.outcome } : {}), checklist: a.checklist });
    } catch (e) {
      return ok(`The artifact was accepted, but the approval card could not be posted (${(e as Error).message}). Say so in your final message.`);
    }
    return ok(
      result.questions.length
        ? `Accepted with ${result.questions.length} open question(s). The reviewers must answer before the stage can be approved. Stop here.`
        : "Accepted. The approval card is in the thread. Stop here; the next stage starts after the decision.",
    );
  };
}

export function createSubmitServer(i: SubmitToolInput): McpSdkServerConfigWithInstance {
  const outcome = i.spec.outcomes?.length
    ? (i.spec.outcomeRequired ? z.enum(i.spec.outcomes as [string, ...string[]]) : z.enum(i.spec.outcomes as [string, ...string[]]).optional())
    : z.string().optional();
  const handler = submitArtifactHandler(i);
  return createSdkMcpServer({
    name: WORKFLOW_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool(
        "submit_artifact",
        submitDescription(i.spec),
        {
          content: z.string().max(MAX_CONTENT).describe("The whole artifact as Markdown, following the template."),
          outcome,
          checklist: z.array(z.object({ item: z.string(), pass: z.boolean(), note: z.string().optional() })).describe("One entry per checklist item."),
        },
        (args: any) => handler(args as SubmitArgs),
      ),
    ],
  });
}
