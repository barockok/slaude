import { describe, it, expect } from "bun:test";
import { submitArtifactHandler, submitDescription, createSubmitServer } from "../../src/workflow/submit-tool";
import { FactoryError } from "../../src/workflow/client";
import type { WorkflowThreadRow } from "../../src/db/workflow";
import type { SubmitResult } from "../../src/workflow/types";

const row = { run_id: "run-1" } as WorkflowThreadRow;
const spec = { name: "prd", checklist: ["Every FR has an ID", "No technology named"], outcomes: ["ok", "needs-research"], outcomeRequired: true };
const args = { content: "# PRD", outcome: "ok", checklist: [{ item: "Every FR has an ID", pass: true }] };

function make(submit: (runId: string, b: any) => Promise<SubmitResult>, onSubmitted: (r: SubmitResult, a: any) => Promise<void> = async () => {}) {
  return submitArtifactHandler({ row, stage: "pm", attempt: 2, spec, client: { submitArtifact: submit as any }, onSubmitted });
}

describe("submit_artifact", () => {
  it("sends the turn's run, stage and attempt, then reports the card to the runner", async () => {
    const sent: any[] = []; const cards: any[] = [];
    const r = await make(async (id, b) => { sent.push([id, b]); return { hash: "h", questions: [], approvable: true }; }, async (res, a) => { cards.push([res, a]); })(args);
    expect(r.isError).toBeUndefined();
    expect(sent[0]).toEqual(["run-1", { stage: "pm", attempt: 2, content: "# PRD", outcome: "ok", checklist: args.checklist }]);
    expect(cards[0][1]).toEqual({ name: "prd", content: "# PRD", outcome: "ok", checklist: args.checklist });
    expect(r.content[0]!.text).toContain("Accepted");
  });

  it("open questions are named in the reply", async () => {
    const r = await make(async () => ({ hash: "h", questions: ["Who owns it?"], approvable: false }))(args);
    expect(r.content[0]!.text).toContain("1 open question");
  });

  it("a 422 returns every problem as a tool error so the agent fixes them in the same turn", async () => {
    let cards = 0;
    const r = await make(async () => { throw new FactoryError(422, "no", ["missing section Goals", "placeholder [NAME] left"]); }, async () => { cards++; })(args);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("- missing section Goals");
    expect(r.content[0]!.text).toContain("- placeholder [NAME] left");
    expect(cards).toBe(0);
  });

  it("a 409 tells the agent to stop; a network error says the service is unreachable", async () => {
    const stop = await make(async () => { throw new FactoryError(409, "stage moved on"); })(args);
    expect(stop.isError).toBe(true);
    expect(stop.content[0]!.text).toContain("Stop");
    const down = await make(async () => { throw new FactoryError(0, "factory unreachable: ECONNREFUSED"); })(args);
    expect(down.isError).toBe(true);
    expect(down.content[0]!.text).toContain("could not be reached");
  });

  it("an accepted artifact whose card failed is reported, not retried", async () => {
    const r = await make(async () => ({ hash: "h", questions: [], approvable: true }), async () => { throw new Error("slack down"); })(args);
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain("card could not be posted (slack down)");
  });
});

describe("description and server", () => {
  it("lists the checklist and the outcomes", () => {
    const d = submitDescription(spec);
    expect(d).toContain("1. Every FR has an ID");
    expect(d).toContain("2. No technology named");
    expect(d).toContain("Required outcome, one of: ok, needs-research");
    expect(submitDescription({ name: "brief" })).not.toContain("outcome");
  });
  it("builds an MCP server named slaude_workflow", () => {
    const s = createSubmitServer({ row, stage: "pm", attempt: 1, spec, client: { submitArtifact: async () => ({ hash: "", questions: [], approvable: true }) }, onSubmitted: async () => {} });
    expect(s.type).toBe("sdk");
    expect(s.name).toBe("slaude_workflow");
  });
});
