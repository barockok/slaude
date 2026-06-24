import { describe, expect, test } from "bun:test";
import { slackHandlers, adminHandlers, type SlackContext } from "../src/gateway/slack/mcp-tools";
import * as CronJobs from "../src/db/cron-jobs";
import { db } from "../src/db/schema";
import { setSoulData, __resetSoulDataMemo } from "../src/soul/extract";
import { SoulDataSchema } from "../src/soul/data";

function fakeCtx(impl: {
  postMessage?: () => any;
  chatUpdate?: () => any;
  reactionsAdd?: () => any;
  reactionsRemove?: () => any;
  filesUploadV2?: () => any;
  usersInfo?: (uid: string) => any;
  convInfo?: () => any;
  convReplies?: () => any;
  convMembers?: () => any;
  searchMessages?: () => any;
  requestApproval?: (req: any) => Promise<any>;
}): SlackContext {
  return {
    client: {
      chat: {
        postMessage: async () => impl.postMessage?.() ?? { ts: "100.0" },
        update: async () => impl.chatUpdate?.() ?? {},
      },
      reactions: {
        add: async () => impl.reactionsAdd?.() ?? {},
        remove: async () => impl.reactionsRemove?.() ?? {},
      },
      files: { uploadV2: async () => impl.filesUploadV2?.() ?? { files: [{ id: "F1" }] } },
      users: { info: async ({ user }: any) => impl.usersInfo?.(user) ?? { user: {} } },
      conversations: {
        info: async () => impl.convInfo?.() ?? { channel: {} },
        replies: async () => impl.convReplies?.() ?? { messages: [] },
        members: async () => impl.convMembers?.() ?? { members: [] },
      },
      search: { messages: async () => impl.searchMessages?.() ?? { messages: { matches: [] } } },
    } as any,
    channel: "C1",
    threadTs: "123.456",
    inboundTs: "789.012",
    requestApproval: impl.requestApproval,
  };
}

describe("slackHandlers", () => {
  test("reply posts message and returns ts", async () => {
    const ctx = fakeCtx({ postMessage: () => ({ ts: "999.0" }) });
    const res = await slackHandlers.reply(ctx, { text: "hello" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("posted ts=999.0");
  });

  test("reply surfaces error", async () => {
    const ctx = fakeCtx({
      postMessage: () => {
        throw new Error("network down");
      },
    });
    const res = await slackHandlers.reply(ctx, { text: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("network down");
  });

  test("edit updates message", async () => {
    const ctx = fakeCtx({});
    const res = await slackHandlers.edit(ctx, { ts: "100.0", text: "updated" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toBe("edited");
  });

  test("edit surfaces error", async () => {
    const ctx = fakeCtx({
      chatUpdate: () => {
        throw new Error("cant_edit");
      },
    });
    const res = await slackHandlers.edit(ctx, { ts: "100.0", text: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("cant_edit");
  });

  test("react adds emoji", async () => {
    const ctx = fakeCtx({});
    const res = await slackHandlers.react(ctx, { name: "eyes" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toBe("reacted :eyes:");
  });

  test("react on already_reacted returns ok", async () => {
    const ctx = fakeCtx({
      reactionsAdd: () => {
        const e: any = new Error("already reacted");
        e.data = { error: "already_reacted" };
        throw e;
      },
    });
    const res = await slackHandlers.react(ctx, { name: "eyes" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toBe("already reacted");
  });

  test("react surfaces other errors", async () => {
    const ctx = fakeCtx({
      reactionsAdd: () => {
        const e: any = new Error("fail");
        e.data = { error: "missing_scope" };
        throw e;
      },
    });
    const res = await slackHandlers.react(ctx, { name: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("missing_scope");
  });

  test("unreact removes emoji", async () => {
    const ctx = fakeCtx({});
    const res = await slackHandlers.unreact(ctx, { name: "eyes" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toBe("unreacted :eyes:");
  });

  test("unreact surfaces error", async () => {
    const ctx = fakeCtx({
      reactionsRemove: () => {
        const e: any = new Error("fail");
        e.data = { error: "no_reaction" };
        throw e;
      },
    });
    const res = await slackHandlers.unreact(ctx, { name: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("no_reaction");
  });

  test("request_approval approved", async () => {
    const ctx = fakeCtx({
      requestApproval: async () => ({ approved: true, by: "U1" }),
    });
    const res = await slackHandlers.request_approval(ctx, { summary: "do thing" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("approved by <@U1>");
  });

  test("request_approval denied with note", async () => {
    const ctx = fakeCtx({
      requestApproval: async () => ({ approved: false, by: "U1", note: "too risky" }),
    });
    const res = await slackHandlers.request_approval(ctx, { summary: "do thing" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("denied by <@U1> (too risky)");
  });

  test("request_approval not wired returns error", async () => {
    const ctx = fakeCtx({});
    delete (ctx as any).requestApproval;
    const res = await slackHandlers.request_approval(ctx, { summary: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("approval gate not wired");
  });

  test("request_approval surfaces error", async () => {
    const ctx = fakeCtx({
      requestApproval: async () => {
        throw new Error("timeout");
      },
    });
    const res = await slackHandlers.request_approval(ctx, { summary: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("timeout");
  });

  test("upload succeeds", async () => {
    const ctx = fakeCtx({
      filesUploadV2: () => ({ files: [{ files: [{ id: "F99" }] }] }),
    });
    const res = await slackHandlers.upload(ctx, { path: import.meta.path });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("F99");
  });

  test("upload missing file returns error", async () => {
    const ctx = fakeCtx({});
    const res = await slackHandlers.upload(ctx, { path: "/tmp/does-not-exist-12345.txt" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("upload failed");
  });

  test("upload surfaces slack error", async () => {
    const ctx = fakeCtx({
      filesUploadV2: () => {
        const e: any = new Error("fail");
        e.data = { error: "invalid_file" };
        throw e;
      },
    });
    // Use a path that exists (the test file itself) so statSync passes
    const res = await slackHandlers.upload(ctx, { path: import.meta.path });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("invalid_file");
  });

  test("get_user_profile returns structured profile", async () => {
    const ctx = fakeCtx({
      usersInfo: (uid) => ({
        user: {
          id: uid,
          name: "alice",
          is_admin: true,
          tz: "America/Los_Angeles",
          profile: {
            real_name: "Alice Smith",
            display_name: "alice",
            title: "Engineer",
            email: "alice@example.com",
            status_text: "in a meeting",
            status_emoji: ":calendar:",
            pronouns: "she/her",
          },
        },
      }),
    });
    const res = await slackHandlers.get_user_profile(ctx, { user_id: "U123" });
    expect(res.isError).toBeUndefined();
    const data = JSON.parse(res.content[0]!.text);
    expect(data.id).toBe("U123");
    expect(data.real_name).toBe("Alice Smith");
    expect(data.title).toBe("Engineer");
    expect(data.email).toBe("alice@example.com");
    expect(data.status_text).toBe("in a meeting");
    expect(data.pronouns).toBe("she/her");
    expect(data.is_admin).toBe(true);
    expect(data.timezone).toBe("America/Los_Angeles");
  });

  test("get_user_profile requires user_id", async () => {
    const ctx = fakeCtx({});
    const res = await slackHandlers.get_user_profile(ctx, {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("user_id required");
  });

  test("get_channel_info returns channel data", async () => {
    const ctx = fakeCtx({
      convInfo: () => ({
        channel: {
          id: "C1",
          name: "general",
          is_channel: true,
          is_private: false,
          topic: { value: "Team updates" },
          purpose: { value: "General chat" },
          num_members: 42,
          creator: "U1",
          created: 1234567890,
        },
      }),
    });
    const res = await slackHandlers.get_channel_info(ctx);
    expect(res.isError).toBeUndefined();
    const data = JSON.parse(res.content[0]!.text);
    expect(data.name).toBe("general");
    expect(data.topic).toBe("Team updates");
    expect(data.num_members).toBe(42);
  });

  test("get_thread_history returns messages", async () => {
    const ctx = fakeCtx({
      convReplies: () => ({
        messages: [
          { ts: "100.0", user: "U1", text: "hello" },
          { ts: "200.0", user: "U2", text: "hi", reply_count: 2 },
        ],
        has_more: false,
      }),
    });
    const res = await slackHandlers.get_thread_history(ctx, { limit: 10 });
    expect(res.isError).toBeUndefined();
    const data = JSON.parse(res.content[0]!.text);
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].text).toBe("hello");
    expect(data.has_more).toBe(false);
  });

  test("list_users_in_channel returns member IDs", async () => {
    const ctx = fakeCtx({
      convMembers: () => ({ members: ["U1", "U2", "U3"], response_metadata: {} }),
    });
    const res = await slackHandlers.list_users_in_channel(ctx, {});
    expect(res.isError).toBeUndefined();
    const data = JSON.parse(res.content[0]!.text);
    expect(data.members).toEqual(["U1", "U2", "U3"]);
    expect(data.has_more).toBe(false);
  });

  test("search_messages returns matches", async () => {
    const ctx = fakeCtx({
      searchMessages: () => ({
        messages: {
          total: 1,
          matches: [
            {
              ts: "100.0",
              user: "U1",
              text: "deploy complete",
              channel: { id: "C1", name: "deploys" },
              permalink: "https://example.com",
              score: 0.9,
            },
          ],
        },
      }),
    });
    const res = await slackHandlers.search_messages(ctx, { query: "deploy", count: 5 });
    expect(res.isError).toBeUndefined();
    const data = JSON.parse(res.content[0]!.text);
    expect(data.total).toBe(1);
    expect(data.matches[0].text).toBe("deploy complete");
  });

  test("search_messages surfaces slack errors", async () => {
    const ctx = fakeCtx({
      searchMessages: () => {
        const e: any = new Error("search failed");
        e.data = { error: "missing_scope" };
        throw e;
      },
    });
    const res = await slackHandlers.search_messages(ctx, { query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("missing_scope");
  });

  test("reply omits thread_ts when postTarget is channel", async () => {
    let captured: any = null;
    const ctx = {
      client: { chat: { postMessage: async (a: any) => { captured = a; return { ts: "1.0" }; } } },
      channel: "C1", threadTs: "123.456", inboundTs: "789.0", postTarget: "channel",
    } as unknown as SlackContext;
    await slackHandlers.reply(ctx, { text: "hi" });
    expect(captured.thread_ts).toBeUndefined();
    expect(captured.channel).toBe("C1");
  });

  test("reply keeps thread_ts when postTarget is thread/absent", async () => {
    let captured: any = null;
    const ctx = {
      client: { chat: { postMessage: async (a: any) => { captured = a; return { ts: "1.0" }; } } },
      channel: "C1", threadTs: "123.456", inboundTs: "789.0",
    } as unknown as SlackContext;
    await slackHandlers.reply(ctx, { text: "hi" });
    expect(captured.thread_ts).toBe("123.456");
  });
});

describe("listCronJobs target tag", () => {
  test("renders [channel] tag", async () => {
    setSoulData(SoulDataSchema.parse({ manager: { userId: "U0MGR" } }));
    db.run("DELETE FROM cron_jobs");
    CronJobs.create({
      channelId: "C1", createdBy: "U1", cronExpr: "0 9 * * *",
      prompt: "digest", nextRunAt: Date.now(), target: "channel",
    });
    const res = await adminHandlers.listCronJobs({ channel: "C1", userId: "U0MGR" } as SlackContext);
    expect(res.content[0]!.text).toContain("[channel]");
    db.run("DELETE FROM cron_jobs");
    __resetSoulDataMemo();
  });
});
