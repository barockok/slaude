import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as Workflow from "../../src/db/workflow";
import { createWorkflowApi, isSafeCommitPath } from "../../src/workflow/api";
import type { CommitRequest, CommitResult, TurnBody } from "../../src/workflow/types";

const TOKEN = "c".repeat(32);
let injected: string[];
let fresh: TurnBody[];
let aborted: string[];
let commits: CommitRequest[];
let commitResult: CommitResult | Error;

const api = createWorkflowApi({
  injectTurn: async (_row, prompt) => { injected.push(prompt); },
  post: async () => {},
  runFreshTurn: (_row, turn) => { fresh.push(turn); },
  commit: async (_row, c) => { commits.push(c); if (commitResult instanceof Error) throw commitResult; return commitResult; },
  abortRun: (runId) => { aborted.push(runId); },
});
const call = (path: string, body: unknown, token = TOKEN) =>
  api(new Request(`http://slaude${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
const turn = (over: Record<string, unknown> = {}) => ({ runId: "run-C1-1.0", stage: "pm", attempt: 1, prompt: "write the prd", requestId: "run-C1-1.0:pm:1", ...over });
const freshTurn = (over: Record<string, unknown> = {}) => turn({ context: "fresh", promptHash: "abc", artifact: { name: "prd", checklist: ["a"], outcomes: ["ok"], outcomeRequired: true }, ...over });
const commit = (over: Record<string, unknown> = {}) => ({ requestId: "run-C1-1.0:commit:1", path: "docs/factory/run/prd.md", content: "# PRD", message: "add prd", ...over });

beforeEach(async () => {
  process.env.SLAUDE_WORKFLOW = "1";
  process.env.SLAUDE_WORKFLOW_METHOD = "1";
  process.env.SLAUDE_WORKFLOW_SERVICE_URL = "https://factory.test";
  process.env.SLAUDE_WORKFLOW_CALLBACK_TOKEN = TOKEN;
  await Workflow._wipeForTests();
  injected = []; fresh = []; aborted = []; commits = []; commitResult = { sha: "abc123" };
  await Workflow.start({ channelId: "C1", threadTs: "1.0", sessionId: "S1", runId: "run-C1-1.0", pipeline: "roles", starter: "U_A" });
});
afterEach(() => { for (const k of ["SLAUDE_WORKFLOW", "SLAUDE_WORKFLOW_METHOD", "SLAUDE_WORKFLOW_SERVICE_URL", "SLAUDE_WORKFLOW_CALLBACK_TOKEN"]) delete process.env[k]; });

describe("method stage turns", () => {
  it("a fresh turn goes to the runner with every method field and never to the thread session", async () => {
    const res = await call("/workflow/v1/turns", freshTurn({ model: "m", effort: "high", runsIn: "sandbox" }));
    expect(res!.status).toBe(200);
    expect(injected).toEqual([]);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({
      runId: "run-C1-1.0", stage: "pm", attempt: 1, context: "fresh", promptHash: "abc", model: "m", effort: "high", runsIn: "sandbox",
      artifact: { name: "prd", checklist: ["a"], outcomes: ["ok"], outcomeRequired: true },
    });
  });

  it("a repeated requestId starts the runner once", async () => {
    await call("/workflow/v1/turns", freshTurn());
    const dup = await call("/workflow/v1/turns", freshTurn());
    expect(await dup!.json()).toEqual({ duplicate: true });
    expect(fresh).toHaveLength(1);
  });

  it("with the method flag off a fresh turn is refused with 409 and not recorded, so a retry works after enabling", async () => {
    delete process.env.SLAUDE_WORKFLOW_METHOD;
    const res = await call("/workflow/v1/turns", freshTurn());
    expect(res!.status).toBe(409);
    expect(fresh).toEqual([]);
    expect(injected).toEqual([]);
    expect((await Workflow.findByRun("run-C1-1.0"))!.last_request_id).toBeNull();
    process.env.SLAUDE_WORKFLOW_METHOD = "1";
    expect((await call("/workflow/v1/turns", freshTurn()))!.status).toBe(200);
    expect(fresh).toHaveLength(1);
  });

  it("a turn without context still goes to the thread session, even with the flag on", async () => {
    expect((await call("/workflow/v1/turns", turn({ model: "m", effort: "low" })))!.status).toBe(200);
    expect(injected).toEqual(["write the prd"]);
    expect(fresh).toEqual([]);
  });

  it("rejects malformed method fields with 400", async () => {
    for (const bad of [
      { context: "stale" },
      { promptHash: 5 },
      { runsIn: "cloud" },
      { artifact: { name: "" } },
      { artifact: { name: "prd", checklist: "x" } },
      { artifact: { name: "prd", outcomes: [1] } },
      { artifact: { name: "prd", outcomeRequired: "yes" } },
    ]) {
      expect((await call("/workflow/v1/turns", turn({ ...bad, requestId: `r:${JSON.stringify(bad)}` })))!.status).toBe(400);
    }
    expect(fresh).toEqual([]);
  });

  it("finish stops an in-flight fresh turn, once", async () => {
    await call("/workflow/v1/runs/run-C1-1.0/finish", { reason: "done" });
    await call("/workflow/v1/runs/run-C1-1.0/finish", { reason: "done" });
    expect(aborted).toEqual(["run-C1-1.0"]);
  });
});

describe("commit callback", () => {
  const url = "/workflow/v1/runs/run-C1-1.0/commit";

  it("passes the request to the committer and returns its result", async () => {
    const res = await call(url, commit());
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ sha: "abc123" });
    expect(commits[0]).toEqual(commit());
    commitResult = { skipped: "no sandbox" };
    expect(await (await call(url, commit()))!.json()).toEqual({ skipped: "no sandbox" });
  });

  it("answers 404 for an unknown run, skips a finished one, 401 for a wrong token", async () => {
    expect((await call("/workflow/v1/runs/nope/commit", commit()))!.status).toBe(404);
    expect((await call(url, commit(), "x".repeat(32)))!.status).toBe(401);
    await Workflow.finish("run-C1-1.0");
    const done = await call(url, commit());
    expect(done!.status).toBe(200);
    expect(await done!.json()).toEqual({ skipped: "run is finished" });
    expect(commits).toEqual([]);
  });

  it("refuses unsafe fields with 400 before the committer runs", async () => {
    for (const bad of [
      { requestId: "has space" }, { requestId: "a'b" }, { requestId: "$(x)" }, { requestId: "" },
      { path: "/etc/passwd" }, { path: "../x" }, { path: "a/../b" }, { path: "a//b" }, { path: "a\\b" }, { path: "" },
      { content: 5 }, { content: "x".repeat(64 * 1024 + 1) }, { message: "" }, { message: "x".repeat(501) }, { message: "a\u0000b" },
    ]) {
      expect((await call(url, commit(bad)))!.status).toBe(400);
    }
    expect(commits).toEqual([]);
  });

  it("a committer failure is a 502 with a short message", async () => {
    commitResult = new Error("sandbox said no");
    const res = await call(url, commit());
    expect(res!.status).toBe(502);
    expect((await res!.json() as any).error).toContain("sandbox said no");
  });

  it("without a committer the route answers 501", async () => {
    const bare = createWorkflowApi({ injectTurn: async () => {}, post: async () => {} });
    const res = await bare(new Request(`http://slaude${url}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(commit()) }));
    expect(res!.status).toBe(501);
  });
});

describe("isSafeCommitPath", () => {
  it("accepts plain relative paths only", () => {
    expect(isSafeCommitPath("docs/factory/r1/prd.md")).toBe(true);
    expect(isSafeCommitPath("a.md")).toBe(true);
    expect(isSafeCommitPath("./a")).toBe(false);
    expect(isSafeCommitPath("a/")).toBe(false);
    expect(isSafeCommitPath("x".repeat(301))).toBe(false);
    expect(isSafeCommitPath(undefined)).toBe(false);
  });
});
