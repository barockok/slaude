import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentManager } from "../../../src/agent/manager";
import * as DecisionNotes from "../../../src/db/decision-notes";
import * as Sessions from "../../../src/db/sessions";
import { createGateway, type GatewayHandle } from "../../../src/gateway/core/gateway";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { NOTES_MCP_NAME } from "../../../src/notes/mcp-tools";
import type { DecisionSummary, SummarizeDecisionInput } from "../../../src/notes/summarize";

function harness(options: {
  replies?: any[];
  members?: Record<string, string[]>;
  permalinkError?: boolean;
  postErrorOnText?: string;
  updateError?: boolean;
  enabled?: boolean;
  summarize?: (input: SummarizeDecisionInput) => Promise<DecisionSummary>;
} = {}) {
  process.env.SLACK_BOT_TOKEN ||= "xoxb-test";
  const posts: any[] = [];
  const reactions: any[] = [];
  const statuses: any[] = [];
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const client = {
    auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "https://example.slack.com" }) },
    chat: {
      postMessage: async (args: any) => {
        if (options.postErrorOnText && String(args.text).includes(options.postErrorOnText)) throw new Error("post unavailable");
        posts.push(args);
        return { ok: true, ts: `900.${posts.length}` };
      },
      update: async () => {
        if (options.updateError) throw new Error("update unavailable");
        return { ok: true };
      },
      getPermalink: async ({ channel, message_ts }: any) => {
        if (options.permalinkError) throw new Error("permalink unavailable");
        return { ok: true, permalink: `https://example.slack.com/archives/${channel}/p${String(message_ts).replace(".", "")}` };
      },
    },
    reactions: {
      add: async (args: any) => { reactions.push({ action: "add", ...args }); return { ok: true }; },
      remove: async (args: any) => { reactions.push({ action: "remove", ...args }); return { ok: true }; },
    },
    conversations: {
      info: async () => ({}),
      replies: async () => ({ messages: options.replies ?? [], response_metadata: { next_cursor: "" } }),
      members: async ({ channel }: any) => ({ members: options.members?.[channel] ?? [] }),
    },
    users: { info: async ({ user }: any) => ({ user: { id: user, real_name: user } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({ messages: { matches: [] } }) },
    assistant: { threads: { setStatus: async (args: any) => { statuses.push(args); return { ok: true }; } } },
  } as any;
  const transport: Transport = {
    client,
    action: () => {},
    event: (name, handler) => handlers.set(name, handler),
    use: () => {},
    start: async () => {},
    stop: async () => {},
  };
  const agent = new AgentManager();
  const sends: string[] = [];
  agent.sendMessage = async (_sessionId, text) => { sends.push(text); };
  const summarize = options.summarize ?? (async (input) => ({
    found: true,
    title: "Use one owner",
    summary: "Each task has one owner.",
    decisions: [{ decision: "Use one owner", evidenceRefs: [input.messages[0]!.ref] }],
    model: "test-model",
  }));
  const handle = createGateway(agent, transport, {
    decisionNotesEnabled: options.enabled ?? true,
    summarizeDecision: summarize,
  });
  const emit = async (event: any) => handlers.get(event.type)?.({
    event,
    client,
    context: { teamId: event.team ?? "T" },
  });
  return { agent, client, posts, reactions, statuses, sends, handle, emit };
}

function commandEvent(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "app_mention",
    channel: "C0TEAM",
    channel_type: "channel",
    user: "U0MEMBER",
    team: "T",
    ts: "100.300000",
    thread_ts: "100.000000",
    text: `<@U_SLAUDE> ${text}`,
    ...overrides,
  };
}

const handles: GatewayHandle[] = [];

beforeEach(() => {
  DecisionNotes.clearForTests();
  writeSoulFixture(WORLD);
});

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop();
});

describe("decision-note gateway commands", () => {
  test("captures a trusted-channel thread without forwarding the slash command", async () => {
    let sourceSeen: SummarizeDecisionInput | undefined;
    const gateway = harness({
      replies: [
        { ts: "100.000000", user: "U0MEMBER", text: "We need one clear owner." },
        { ts: "100.200000", user: "U0APP", text: "Decision: use one owner per task." },
        { ts: "100.300000", user: "U0MEMBER", text: "/note-add #task-framework" },
      ],
      summarize: async (input) => {
        sourceSeen = input;
        return {
          found: true,
          title: "Use one owner",
          summary: "Each task has one owner.",
          decisions: [{ decision: "Use one owner", evidenceRefs: ["100.200000"] }],
          model: "test-model",
        };
      },
    });
    handles.push(gateway.handle);
    await gateway.emit(commandEvent("/note-add #task-framework Focus on ownership"));
    const notes = DecisionNotes.listByTag({ slackTeamId: "T", personaId: "default" }, "task-framework");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.instruction).toBe("Focus on ownership");
    expect(sourceSeen?.messages.map((message) => message.ref)).toEqual(["100.000000", "100.200000"]);
    expect(gateway.sends).toEqual([]);
    expect(gateway.posts.some((post) => String(post.text).includes("Decision note added"))).toBe(true);
    expect(gateway.statuses.at(-1)?.status).toBe("");
    expect(gateway.reactions.some((reaction) => reaction.action === "add" && reaction.name === "white_check_mark")).toBe(true);
  });

  test("rejects root capture and unauthorized writes before summarization", async () => {
    let calls = 0;
    const gateway = harness({ summarize: async () => { calls++; throw new Error("must not run"); } });
    handles.push(gateway.handle);
    await gateway.emit(commandEvent("/note-add #task-framework", { thread_ts: undefined }));
    await gateway.emit(commandEvent("/note-add #task-framework", {
      channel: "C0PUB",
      ts: "101.300000",
      thread_ts: "101.000000",
    }));
    expect(calls).toBe(0);
    expect(DecisionNotes.listByTag({ slackTeamId: "T", personaId: "default" }, "task-framework")).toEqual([]);
    expect(gateway.posts.some((post) => String(post.text).includes("must be used inside"))).toBe(true);
    expect(gateway.posts.some((post) => String(post.text).includes("manager or approver"))).toBe(true);
  });

  test("keeps malformed note commands local and returns command-specific usage", async () => {
    const gateway = harness();
    handles.push(gateway.handle);
    await gateway.emit(commandEvent("/note-add bad.tag", { ts: "106.1" }));
    await gateway.emit(commandEvent("/note-list nope", { ts: "106.2" }));
    await gateway.emit(commandEvent("/note-history", { ts: "106.3" }));
    const output = gateway.posts.map((post) => String(post.text)).join("\n");
    expect(output).toContain("/note-add <#tag> [focus]");
    expect(output).toContain("/note-list [limit]");
    expect(output).toContain("/note-history <#tag> [limit]");
    expect(gateway.sends).toEqual([]);
  });

  test("returns no-note outcomes for empty and unresolved threads", async () => {
    const empty = harness({ replies: [] });
    handles.push(empty.handle);
    await empty.emit(commandEvent("/note-add #task-framework", { ts: "107.1" }));
    expect(empty.posts.some((post) => String(post.text).includes("earlier messages"))).toBe(true);

    const unresolved = harness({
      replies: [{ ts: "100.1", user: "U0MEMBER", text: "Maybe later." }],
      summarize: async () => ({ found: false, title: "", summary: "", decisions: [], model: "test-model" }),
    });
    handles.push(unresolved.handle);
    await unresolved.emit(commandEvent("/note-add #task-framework", { ts: "107.2" }));
    expect(unresolved.posts.some((post) => String(post.text).includes("clear decision"))).toBe(true);
    expect(DecisionNotes.listByTag({ slackTeamId: "T", personaId: "default" }, "task-framework")).toEqual([]);
  });

  test("replays an already-saved capture idempotently", async () => {
    DecisionNotes.create({
      slackTeamId: "T",
      personaId: "default",
      tag: "task-framework",
      title: "Existing",
      summary: "Already stored.",
      decisions: [{ decision: "Existing", evidenceRefs: ["100.1"] }],
      slackChannelId: "C0TEAM",
      slackThreadTs: "100.000000",
      sourceMessageTs: "108.1",
      sourcePermalink: "https://example.slack.com/archives/C0TEAM/p1081",
      sourceMessageCount: 1,
      sourceTruncated: false,
      createdBy: "U0MEMBER",
      summarizerModel: "test",
    });
    let summaries = 0;
    const gateway = harness({ summarize: async () => { summaries++; throw new Error("must not run"); } });
    handles.push(gateway.handle);
    await gateway.emit(commandEvent("/note-add #task-framework", { ts: "108.1" }));
    expect(summaries).toBe(0);
    expect(gateway.posts.some((post) => String(post.text).includes("already saved"))).toBe(true);
  });

  test("does not write or claim success when provenance fails", async () => {
    const gateway = harness({
      replies: [{ ts: "100.000000", user: "U0MEMBER", text: "Decision: one owner." }],
      permalinkError: true,
    });
    handles.push(gateway.handle);
    await gateway.emit(commandEvent("/note-add #task-framework"));
    expect(DecisionNotes.listByTag({ slackTeamId: "T", personaId: "default" }, "task-framework")).toEqual([]);
    expect(gateway.posts.some((post) => String(post.text).includes("No note was saved"))).toBe(true);
    expect(gateway.posts.some((post) => String(post.text).includes("Decision note added"))).toBe(false);
    expect(gateway.reactions.some((reaction) => reaction.action === "add" && reaction.name === "x")).toBe(true);
  });

  test("lists and reads only same-channel records from a channel", async () => {
    const base = {
      slackTeamId: "T",
      personaId: "default",
      tag: "task-framework",
      summary: "Summary",
      decisions: [{ decision: "Decision", evidenceRefs: ["1.1"] }],
      slackThreadTs: "1.0",
      sourceMessageCount: 1,
      sourceTruncated: false,
      createdBy: "U0MEMBER",
      summarizerModel: "test",
    };
    DecisionNotes.create({ ...base, title: "Visible title", slackChannelId: "C0TEAM", sourceMessageTs: "1.1", sourcePermalink: "https://example.slack.com/archives/C0TEAM/p11" });
    DecisionNotes.create({ ...base, title: "Hidden title", slackChannelId: "C0PUB", sourceMessageTs: "2.1", sourcePermalink: "https://example.slack.com/archives/C0PUB/p21" });
    const gateway = harness();
    handles.push(gateway.handle);
    await gateway.emit(commandEvent("/note-list", { ts: "102.1" }));
    await gateway.emit(commandEvent("/note-history #task-framework", { ts: "102.2" }));
    const output = gateway.posts.map((post) => String(post.text)).join("\n");
    expect(output).toContain("Visible title");
    expect(output).not.toContain("Hidden title");
    expect(output).toContain("1 visible");
  });

  test("reports list and history rendering failures without changing notes", async () => {
    const base = {
      slackTeamId: "T",
      personaId: "default",
      tag: "task-framework",
      title: "Visible title",
      summary: "Summary",
      decisions: [{ decision: "Decision", evidenceRefs: ["1.1"] }],
      slackChannelId: "C0TEAM",
      slackThreadTs: "1.0",
      sourceMessageTs: "1.1",
      sourcePermalink: "https://example.slack.com/archives/C0TEAM/p11",
      sourceMessageCount: 1,
      sourceTruncated: false,
      createdBy: "U0MEMBER",
      summarizerModel: "test",
    };
    DecisionNotes.create(base);
    const listGateway = harness({ postErrorOnText: "Decision note tags" });
    const historyGateway = harness({ postErrorOnText: "Decision history" });
    handles.push(listGateway.handle, historyGateway.handle);
    await listGateway.emit(commandEvent("/note-list", { ts: "109.1" }));
    await historyGateway.emit(commandEvent("/note-history #task-framework", { ts: "109.2" }));
    expect(listGateway.posts.some((post) => String(post.text).includes("couldn't list"))).toBe(true);
    expect(historyGateway.posts.some((post) => String(post.text).includes("couldn't read"))).toBe(true);
    expect(DecisionNotes.listByTag({ slackTeamId: "T", personaId: "default" }, "task-framework")).toHaveLength(1);
  });

  test("DM history aggregates only source conversations containing the requester", async () => {
    const base = {
      slackTeamId: "T",
      personaId: "default",
      tag: "task-framework",
      summary: "Summary",
      decisions: [{ decision: "Decision", evidenceRefs: ["1.1"] }],
      slackThreadTs: "1.0",
      sourceMessageCount: 1,
      sourceTruncated: false,
      createdBy: WORLD.manager,
      summarizerModel: "test",
    };
    DecisionNotes.create({ ...base, title: "Member title", slackChannelId: "C_ALLOWED", sourceMessageTs: "1.1", sourcePermalink: "https://example.slack.com/archives/C_ALLOWED/p11" });
    DecisionNotes.create({ ...base, title: "Secret title", slackChannelId: "C_HIDDEN", sourceMessageTs: "2.1", sourcePermalink: "https://example.slack.com/archives/C_HIDDEN/p21" });
    const gateway = harness({ members: { C_ALLOWED: [WORLD.manager], C_HIDDEN: ["U_OTHER"] } });
    handles.push(gateway.handle);
    await gateway.emit(commandEvent("/note-history #task-framework", {
      type: "message",
      channel: "D_MGR",
      channel_type: "im",
      user: WORLD.manager,
      ts: "103.1",
      thread_ts: undefined,
      text: "/note-history #task-framework",
    }));
    const output = gateway.posts.map((post) => String(post.text)).join("\n");
    expect(output).toContain("Member title");
    expect(output).not.toContain("Secret title");
    expect(output).toContain("1 visible");
  });

  test("feature flag hides help, refuses commands, and omits the agent read server", async () => {
    const gateway = harness({ enabled: false });
    handles.push(gateway.handle);
    await gateway.emit(commandEvent("/help", { ts: "104.1" }));
    await gateway.emit(commandEvent("/note-list", { ts: "104.2" }));
    const output = gateway.posts.map((post) => String(post.text)).join("\n");
    expect(output).not.toContain("/note-add");
    expect(output).toContain("not enabled");

    await gateway.emit(commandEvent("hello", { ts: "104.3", text: "<@U_SLAUDE> hello" }));
    const row = Sessions.findByThread({ team_id: "T", channel_id: "C0TEAM", thread_ts: "100.000000" });
    expect(row).not.toBeNull();
    expect(gateway.handle.__resolveMcp(row!.id)?.[NOTES_MCP_NAME]).toBeUndefined();
  });

  test("enabled sessions mount the read-only decision-note server", async () => {
    const gateway = harness();
    handles.push(gateway.handle);
    await gateway.emit(commandEvent("hello", { ts: "105.1", text: "<@U_SLAUDE> hello" }));
    const row = Sessions.findByThread({ team_id: "T", channel_id: "C0TEAM", thread_ts: "100.000000" });
    expect(row).not.toBeNull();
    const notesServer: any = gateway.handle.__resolveMcp(row!.id)?.[NOTES_MCP_NAME];
    expect(notesServer).toBeDefined();
    const tags = await notesServer.instance._registeredTools.list_note_tags.handler({ limit: 20 });
    const history = await notesServer.instance._registeredTools.list_decision_notes.handler({ tag: "task-framework", limit: 10 });
    expect(tags.isError).toBeUndefined();
    expect(history.isError).toBeUndefined();
  });

  test("an opened 1on1 in a channel does not enable cross-channel history", async () => {
    DecisionNotes.create({
      slackTeamId: "T",
      personaId: "default",
      tag: "task-framework",
      title: "Hidden elsewhere",
      summary: "Must stay hidden.",
      decisions: [{ decision: "Hidden", evidenceRefs: ["1.1"] }],
      slackChannelId: "C_HIDDEN",
      slackThreadTs: "1.0",
      sourceMessageTs: "1.1",
      sourcePermalink: "https://example.slack.com/archives/C_HIDDEN/p11",
      sourceMessageCount: 1,
      sourceTruncated: false,
      createdBy: "U0MEMBER",
      summarizerModel: "test",
    });
    const gateway = harness({ members: { C_HIDDEN: ["U0MEMBER"] } });
    handles.push(gateway.handle);
    await gateway.emit(commandEvent("hello", { ts: "109.5", text: "<@U_SLAUDE> hello" }));
    const row = Sessions.findByThread({ team_id: "T", channel_id: "C0TEAM", thread_ts: "100.000000" })!;
    expect(await gateway.handle.__agentOneOnOne(row.id, "open", "decision review")).toContain("Opened");
    await gateway.emit(commandEvent("/note-history #task-framework", { ts: "109.6" }));
    expect(gateway.posts.map((post) => String(post.text)).join("\n")).not.toContain("Hidden elsewhere");
    expect(await gateway.handle.__agentOneOnOne(row.id, "off")).toContain("Released");
  });

  test("enabled sessions retain the gateway task-event lifecycle", async () => {
    const gateway = harness();
    handles.push(gateway.handle);
    await gateway.emit(commandEvent("hello", { ts: "110.1", text: "<@U_SLAUDE> hello" }));
    const row = Sessions.findByThread({ team_id: "T", channel_id: "C0TEAM", thread_ts: "100.000000" })!;

    gateway.agent.emit("event", {
      type: "toolCall",
      sessionId: row.id,
      tool: "TodoWrite",
      input: { todos: [{ content: "Review decision", status: "in_progress" }] },
    });
    await Bun.sleep(5);
    gateway.agent.emit("event", {
      type: "toolCall",
      sessionId: row.id,
      tool: "TodoWrite",
      input: { todos: [{ content: "Review decision", status: "completed" }] },
    });
    gateway.agent.emit("event", {
      type: "toolCall",
      sessionId: row.id,
      tool: "TaskCreate",
      input: { subject: "Verify note" },
    });
    gateway.agent.emit("event", {
      type: "toolResult",
      sessionId: row.id,
      tool: "TaskCreate",
      result: { task: { id: "task-1" } },
    });
    await Bun.sleep(5);
    gateway.agent.emit("event", {
      type: "toolCall",
      sessionId: row.id,
      tool: "TaskUpdate",
      input: { taskId: "task-1", status: "completed" },
    });
    gateway.agent.emit("event", { type: "done", sessionId: row.id });
    await Bun.sleep(5);

    expect(gateway.posts.some((post) => String(post.text).includes("Review decision"))).toBe(true);
  });

  test("task-event rendering errors remain isolated from decision-note sessions", async () => {
    const postFailure = harness({ postErrorOnText: "Tasks" });
    handles.push(postFailure.handle);
    await postFailure.emit(commandEvent("hello", { ts: "111.1", text: "<@U_SLAUDE> hello" }));
    const first = Sessions.findByThread({ team_id: "T", channel_id: "C0TEAM", thread_ts: "100.000000" })!;
    postFailure.agent.emit("event", {
      type: "toolCall",
      sessionId: first.id,
      tool: "TodoWrite",
      input: { todos: [{ content: "Pending review", status: "pending" }] },
    });
    postFailure.agent.emit("event", {
      type: "toolCall",
      sessionId: first.id,
      tool: "TaskCreate",
      input: { subject: "Failed render" },
    });
    postFailure.agent.emit("event", {
      type: "toolResult",
      sessionId: first.id,
      tool: "TaskCreate",
      result: { task: { id: "failed-task" } },
    });
    await Bun.sleep(5);

    const updateFailure = harness({ updateError: true });
    handles.push(updateFailure.handle);
    await updateFailure.emit(commandEvent("hello", { ts: "112.1", text: "<@U_SLAUDE> hello" }));
    const second = Sessions.findByThread({ team_id: "T", channel_id: "C0TEAM", thread_ts: "100.000000" })!;
    updateFailure.agent.emit("event", {
      type: "toolCall",
      sessionId: second.id,
      tool: "TaskCreate",
      input: { subject: "First task" },
    });
    updateFailure.agent.emit("event", {
      type: "toolResult",
      sessionId: second.id,
      tool: "TaskCreate",
      result: { task: { id: "task-a" } },
    });
    await Bun.sleep(5);
    updateFailure.agent.emit("event", {
      type: "toolCall",
      sessionId: second.id,
      tool: "TaskCreate",
      input: { subject: "Second task" },
    });
    updateFailure.agent.emit("event", {
      type: "toolResult",
      sessionId: second.id,
      tool: "TaskCreate",
      result: { task: { id: "task-b" } },
    });
    updateFailure.agent.emit("event", {
      type: "toolCall",
      sessionId: second.id,
      tool: "TaskUpdate",
      input: { taskId: "task-a", status: "deleted" },
    });
    await Bun.sleep(5);

    expect(DecisionNotes.listByTag({ slackTeamId: "T", personaId: "default" }, "task-framework")).toEqual([]);
  });
});
