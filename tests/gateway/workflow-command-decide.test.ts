import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as PendingGates from "../../src/db/pending-gates";
import * as Workflow from "../../src/db/workflow";
import { db } from "../../src/db/schema";
import { handleWorkflowCommand } from "../../src/gateway/core/workflow-command";
import { parseSlashCommand } from "../../src/gateway/slack/commands";
import type { FactoryClient } from "../../src/workflow/client";

let replies: string[];
let approvals: any[];
let questions: string[];
const client = {
  approve: async (runId: string, a: any) => { approvals.push([runId, a]); return {}; },
  getRun: async () => ({ candidate: { questions } }),
} as unknown as FactoryClient;
const ctx = (userId: string) => ({ channelId: "C1", threadTs: "1.0", userId, sessionId: "S1", isManager: false, reply: async (t: string) => { replies.push(t); } });
const run = (text: string, user = "U_A") => handleWorkflowCommand(parseSlashCommand(text) as any, ctx(user), client);

beforeEach(async () => {
  process.env.SLAUDE_WORKFLOW = "1";
  process.env.SLAUDE_WORKFLOW_SERVICE_URL = "https://factory.test";
  await Workflow._wipeForTests();
  await db.run("DELETE FROM pending_gates");
  replies = []; approvals = []; questions = [];
  await Workflow.start({ channelId: "C1", threadTs: "1.0", sessionId: "S1", runId: "run-C1-1.0", pipeline: "roles", starter: "U_A" });
  await Workflow.beginStage("run-C1-1.0", "pm", 2, "r:pm:2");
});
afterEach(() => { delete process.env.SLAUDE_WORKFLOW; delete process.env.SLAUDE_WORKFLOW_SERVICE_URL; });

describe("parsing", () => {
  it("answer and reject need text", () => {
    expect(parseSlashCommand("/workflow reject too vague")).toEqual({ kind: "workflow", action: "reject", text: "too vague" });
    expect(parseSlashCommand("/workflow answer a || b")).toEqual({ kind: "workflow", action: "answer", text: "a || b" });
    expect(parseSlashCommand("/workflow reject")).toEqual({ kind: "workflow", action: "usage" });
  });
});

describe("/workflow reject", () => {
  it("sends the reason to the factory for the current stage and attempt, and settles the open card", async () => {
    await PendingGates.create({ id: "g1", kind: "approval", sessionId: "S1", payload: { type: "stage", runId: "run-C1-1.0", stage: "pm", attempt: 2 } });
    await PendingGates.create({ id: "g2", kind: "approval", sessionId: "S1", payload: { type: "stage", runId: "run-C1-1.0", stage: "other", attempt: 1 } });
    await run("/workflow reject Goals are not measurable");
    expect(approvals[0][0]).toBe("run-C1-1.0");
    expect(approvals[0][1]).toMatchObject({ stage: "pm", attempt: 2, decision: "reject", by: "U_A", note: "Goals are not measurable" });
    expect((await PendingGates.get("g1"))?.status).toBe("denied");
    expect((await PendingGates.get("g2"))?.status).toBe("pending");
    expect(replies[0]).toContain("rejected");
  });

  it("refuses someone who is not the starter or a participant, and a thread with no run", async () => {
    await run("/workflow reject no", "U_X");
    expect(approvals).toEqual([]);
    expect(replies[0]).toContain("only this workflow's starter and participants");
    await Workflow.finish("run-C1-1.0");
    replies = [];
    await run("/workflow reject no");
    expect(replies[0]).toContain("No running workflow");
  });

  it("a participant may reject", async () => {
    await Workflow.addParticipant("C1", "1.0", "U_B", "U_A");
    await run("/workflow reject no", "U_B");
    expect(approvals).toHaveLength(1);
  });
});

describe("/workflow answer", () => {
  it("sends one answer per open question in order", async () => {
    questions = ["Who owns it?", "By when?"];
    await run("/workflow answer Platform team || end of Q1");
    expect(approvals[0][1]).toMatchObject({ stage: "pm", attempt: 2, decision: "answer", answers: ["Platform team", "end of Q1"] });
    expect(replies[0]).toContain("Answers recorded");
  });

  it("refuses a wrong count, and a stage with no open questions", async () => {
    questions = ["a?", "b?"];
    await run("/workflow answer only one");
    expect(approvals).toEqual([]);
    expect(replies[0]).toContain("2 questions are open and you gave 1 answer");
    questions = [];
    replies = [];
    await run("/workflow answer x");
    expect(replies[0]).toContain("no open questions");
  });

  it("each command uses its own gate id, so a second round is not a repeat", async () => {
    questions = ["a?"];
    await run("/workflow answer one");
    await new Promise((r) => setTimeout(r, 3));
    await run("/workflow answer two");
    expect(approvals[0][1].gateId).not.toBe(approvals[1][1].gateId);
  });
});
