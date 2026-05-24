import { describe, expect, test } from "bun:test";
import { slackHandlers, type SlackContext } from "../src/gateway/slack/mcp-tools";

function fakeCtx(impl: {
  usersInfo?: (uid: string) => any;
  convInfo?: () => any;
  convReplies?: () => any;
  convMembers?: () => any;
  searchMessages?: () => any;
}): SlackContext {
  return {
    client: {
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
  };
}

describe("slackHandlers", () => {
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
});
