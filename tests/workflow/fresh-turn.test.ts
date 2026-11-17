import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createFreshRunner, freshOptions, FOOTER, SANDBOX_TOOLS } from "../../src/workflow/fresh-turn";
import { SUBMIT_TOOL_NAME } from "../../src/workflow/submit-tool";
import type { WorkflowThreadRow } from "../../src/db/workflow";
import type { TurnBody } from "../../src/workflow/types";

const row = { run_id: "run-1", session_id: "11111111-1111-4111-8111-111111111111", channel_id: "C1", thread_ts: "1.0", starter_user_id: "U_A" } as WorkflowThreadRow;
const turn = (over: Partial<TurnBody> = {}): TurnBody => ({ runId: "run-1", stage: "pm", attempt: 1, prompt: "STAGE PROMPT", requestId: "r1", context: "fresh", artifact: { name: "prd", checklist: ["a"] }, ...over });

let posts: string[];
let cards: any[];
let stageCards: any[];
let calls: any[];
let sandboxOn: boolean;
let entered: number;
let submitInput: any;
let script: (opts: any) => AsyncIterable<any>;

const assistant = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const deps = () => ({
  query: ((args: any) => { calls.push(args); return script(args.options); }) as any,
  makeSubmitServer: ((i: any) => { submitInput = i; return { type: "sdk", name: "slaude_workflow", instance: {} } as any; }) as any,
  post: async (_r: WorkflowThreadRow, t: string) => { posts.push(t); },
  stageGate: {
    post: async (r: any) => { stageCards.push(r); return { gateId: "g" }; },
    postArtifactCard: async (r: any) => { cards.push(r); return { gateId: "g" }; },
  } as any,
  client: { submitArtifact: async () => ({ hash: "h", questions: [], approvable: true }) },
  inSandbox: async () => sandboxOn,
  enterSandbox: async () => { entered++; sandboxOn = true; },
  app: () => ({}),
});

beforeEach(() => {
  posts = []; cards = []; stageCards = []; calls = []; sandboxOn = false; entered = 0; submitInput = undefined;
  script = async function* () { yield assistant("done"); };
  for (const k of ["SLAUDE_SANDBOX", "SLAUDE_SANDBOX_MCP_URL", "SLAUDE_SANDBOX_AUTO_USERS", "SLAUDE_WORKFLOW_FRESH_TIMEOUT_MS"]) delete process.env[k];
});
afterEach(() => { for (const k of ["SLAUDE_SANDBOX", "SLAUDE_SANDBOX_MCP_URL", "SLAUDE_SANDBOX_AUTO_USERS", "SLAUDE_WORKFLOW_FRESH_TIMEOUT_MS", "SLAUDE_ENCRYPTION_KEY"]) delete process.env[k]; });
const enableSandbox = () => { process.env.SLAUDE_SANDBOX = "1"; process.env.SLAUDE_SANDBOX_MCP_URL = "http://sandbox.test/mcp"; };

describe("what the fresh run sees", () => {
  it("is the factory prompt and a short footer, with no soul, memory, skills, local tools or secrets", async () => {
    process.env.SLAUDE_ENCRYPTION_KEY = "secret-value";
    await createFreshRunner(deps()).run(row, turn());
    const o = calls[0].options;
    expect(o.systemPrompt).toBe("STAGE PROMPT" + FOOTER);
    expect(typeof o.systemPrompt).toBe("string");
    expect(o.tools).toEqual([]);
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.plugins).toBeUndefined();
    expect(o.allowedTools).toEqual([SUBMIT_TOOL_NAME]);
    expect(Object.keys(o.mcpServers)).toEqual(["slaude_workflow"]);
    expect(o.env.SLAUDE_ENCRYPTION_KEY).toBeUndefined();
    expect(o.disallowedTools).toContain("Monitor");
  });

  it("uses the turn's model when given", () => {
    const o = freshOptions({ turn: turn({ model: "m-1" }), mcpServers: {}, allowedTools: [], abortController: new AbortController() });
    expect(o.model).toBe("m-1");
  });

  it("a stage with no artifact mounts no submit tool", async () => {
    await createFreshRunner(deps()).run(row, turn({ artifact: undefined }));
    expect(calls[0].options.mcpServers).toEqual({});
    expect(calls[0].options.allowedTools).toEqual([]);
  });
});

describe("the sandbox", () => {
  it("a host stage never gets it, even in a sandbox-mode thread", async () => {
    enableSandbox(); sandboxOn = true;
    await createFreshRunner(deps()).run(row, turn({ runsIn: "host" }));
    expect(calls[0].options.mcpServers.remote).toBeUndefined();
  });

  it("a code stage gets the thread's sandbox by the thread session id, without git_push", async () => {
    enableSandbox(); sandboxOn = true;
    await createFreshRunner(deps()).run(row, turn({ runsIn: "sandbox" }));
    const o = calls[0].options;
    expect(o.mcpServers.remote.url).toBe("http://sandbox.test/mcp");
    expect(o.mcpServers.remote.headers["X-Sandbox-Session"]).toBe(row.session_id);
    expect(o.allowedTools).toEqual(expect.arrayContaining(SANDBOX_TOOLS));
    expect(o.allowedTools.some((t: string) => t.endsWith("git_push"))).toBe(false);
    expect(entered).toBe(0);
  });

  it("a code stage switches the thread to sandbox mode when the starter may", async () => {
    enableSandbox();
    await createFreshRunner(deps()).run(row, turn({ runsIn: "sandbox" }));
    expect(entered).toBe(1);
    expect(calls[0].options.mcpServers.remote).toBeDefined();
  });

  it("a code stage stops with a message when the starter may not, or sandbox mode is off", async () => {
    enableSandbox(); process.env.SLAUDE_SANDBOX_AUTO_USERS = "U_OTHER";
    await createFreshRunner(deps()).run(row, turn({ runsIn: "sandbox" }));
    expect(calls).toEqual([]);
    expect(posts[0]).toContain("Ask a manager for sandbox access");
    posts = [];
    delete process.env.SLAUDE_SANDBOX; delete process.env.SLAUDE_SANDBOX_AUTO_USERS;
    await createFreshRunner(deps()).run(row, turn({ runsIn: "sandbox" }));
    expect(calls).toEqual([]);
    expect(posts[0]).toContain("sandbox mode is not enabled");
  });

  it("with runsIn unknown the sandbox is mounted only when the thread is already in it", async () => {
    enableSandbox();
    await createFreshRunner(deps()).run(row, turn());
    expect(calls[0].options.mcpServers.remote).toBeUndefined();
    sandboxOn = true;
    await createFreshRunner(deps()).run(row, turn());
    expect(calls[1].options.mcpServers.remote).toBeDefined();
    expect(entered).toBe(0);
  });
});

describe("how a turn ends", () => {
  it("submitted: the agent's last message is posted and the card came from the submit tool", async () => {
    script = async function* (_o) {
      yield assistant("working");
      await submitInput.onSubmitted({ hash: "h", questions: [], approvable: true }, { name: "prd", content: "# PRD", checklist: [] });
      yield assistant("The PRD is ready.");
    };
    await createFreshRunner(deps()).run(row, turn());
    expect(posts).toEqual(["The PRD is ready."]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ channel: "C1", threadTs: "1.0", sessionId: row.session_id, stage: "pm" });
    expect(stageCards).toEqual([]);
  });

  it("no submission: a warning says how to run the stage again", async () => {
    await createFreshRunner(deps()).run(row, turn());
    expect(posts[0]).toBe("done");
    expect(posts[1]).toContain("ended without a submitted artifact");
    expect(cards).toEqual([]);
  });

  it("an accepted artifact whose card failed is reported", async () => {
    const d = deps();
    d.stageGate.postArtifactCard = async () => ({ error: "slack down" }) as any;
    script = async function* () {
      await submitInput.onSubmitted({ hash: "h", questions: [], approvable: true }, { name: "prd", content: "x", checklist: [] }).catch(() => {});
      yield assistant("ok");
    };
    await createFreshRunner(d).run(row, turn());
    expect(posts.join("\n")).toContain("approval card could not be posted (slack down)");
  });

  it("a stage with no artifact gets a card carrying what the agent said", async () => {
    script = async function* () { yield assistant("x".repeat(5000)); };
    await createFreshRunner(deps()).run(row, turn({ artifact: undefined }));
    expect(stageCards).toHaveLength(1);
    expect(stageCards[0].stage).toBe("pm");
    expect(stageCards[0].summary).toHaveLength(2800);
  });

  it("a result message's text is the final text", async () => {
    script = async function* () { yield assistant("draft"); yield { type: "result", subtype: "success", result: "final answer" }; };
    await createFreshRunner(deps()).run(row, turn({ artifact: undefined }));
    expect(posts).toEqual(["final answer"]);
  });

  it("an error is posted short and without the environment", async () => {
    script = async function* () { throw new Error("x".repeat(500)); };
    await createFreshRunner(deps()).run(row, turn());
    expect(posts[0]).toContain("failed");
    expect(posts[0]?.length ?? 0).toBeLessThan(400);
  });

  it("a turn that runs past the limit is aborted and reported", async () => {
    process.env.SLAUDE_WORKFLOW_FRESH_TIMEOUT_MS = "30";
    script = async function* (o: any) { await new Promise((_r, rej) => o.abortController.signal.addEventListener("abort", () => rej(new Error("aborted")))); yield assistant("never"); };
    await createFreshRunner(deps()).run(row, turn());
    expect(posts[0]).toContain("timed out");
  });

  it("abort(runId) stops a turn silently", async () => {
    script = async function* (o: any) { await new Promise((_r, rej) => o.abortController.signal.addEventListener("abort", () => rej(new Error("aborted")))); yield assistant("never"); };
    const runner = createFreshRunner(deps());
    const p = runner.run(row, turn());
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.active()).toBe(1);
    runner.abort("run-1");
    await p;
    expect(posts).toEqual([]);
    expect(runner.active()).toBe(0);
  });

  it("a second turn for the same run replaces one still going", async () => {
    let first: AbortSignal | undefined;
    script = async function* (o: any) {
      if (!first) { first = o.abortController.signal; await new Promise((_r, rej) => first!.addEventListener("abort", () => rej(new Error("aborted")))); }
      yield assistant("second done");
    };
    const runner = createFreshRunner(deps());
    const a = runner.run(row, turn({ requestId: "r1" }));
    await new Promise((r) => setTimeout(r, 10));
    const b = runner.run(row, turn({ requestId: "r2" }));
    await Promise.all([a, b]);
    expect(first?.aborted).toBe(true);
    expect(posts).toContain("second done");
  });
});
