import { describe, expect, test } from "bun:test";
import { SlackSurface, makeSlackSurfaceFactory } from "../src/gateway/slack/surface";
import type { SessionBinding } from "../src/gateway/core/surface";

function fakeClient(impl: any = {}) {
  return {
    chat: {
      postMessage: async () => impl.postMessage?.() ?? { ts: "100.0" },
      update: async () => impl.chatUpdate?.() ?? {},
    },
    reactions: {
      add: async () => impl.reactionsAdd?.() ?? {},
      remove: async () => impl.reactionsRemove?.() ?? {},
    },
    files: { uploadV2: async () => impl.filesUploadV2?.() ?? { files: [{ id: "F1" }] } },
    conversations: { replies: async () => impl.convReplies?.() ?? { messages: [], has_more: false } },
  } as any;
}

function binding(over: Partial<SessionBinding> = {}): SessionBinding {
  return {
    conversationId: "C1",
    threadRef: "123.456",
    inboundRef: "789.012",
    requestApproval: async () => ({ approved: true, by: "U1" }),
    reloadSession: () => true,
    ...over,
  };
}

describe("SlackSurface", () => {
  test("id is slack and declares edit/react/upload capabilities (not typing)", () => {
    const s = new SlackSurface(fakeClient(), binding());
    expect(s.id).toBe("slack");
    expect([...s.capabilities].sort()).toEqual(["edit", "react", "upload"]);
  });

  test("reply posts to the bound conversation and returns ts as ref", async () => {
    const s = new SlackSurface(fakeClient({ postMessage: () => ({ ts: "999.0" }) }), binding());
    expect(await s.reply({ text: "hi" })).toEqual({ ref: "999.0" });
  });

  test("getHistory maps slack fields and preserves reply_count/thread_ts/has_more", async () => {
    const s = new SlackSurface(
      fakeClient({
        convReplies: () => ({
          has_more: true,
          messages: [{ ts: "1.0", user: "U9", text: "hey", thread_ts: "1.0", reply_count: 2, replies: [{ ts: "2.0", user: "U8" }] }],
        }),
      }),
      binding(),
    );
    const { messages, hasMore } = await s.getHistory({});
    expect(hasMore).toBe(true);
    expect(messages[0]).toMatchObject({ author: "U9", text: "hey", ref: "1.0", threadRef: "1.0", replyCount: 2 });
    expect(messages[0]!.replies).toEqual([{ ts: "2.0", user: "U8" }]);
  });

  test("getHistory omits replies when includeReplies=false", async () => {
    const s = new SlackSurface(
      fakeClient({ convReplies: () => ({ has_more: false, messages: [{ ts: "1.0", user: "U9", text: "x", replies: [{ ts: "2.0" }] }] }) }),
      binding(),
    );
    const { messages } = await s.getHistory({ includeReplies: false });
    expect(messages[0]!.replies).toBeUndefined();
  });

  test("react swallows already_reacted", async () => {
    const s = new SlackSurface(
      fakeClient({ reactionsAdd: () => { throw { data: { error: "already_reacted" } }; } }),
      binding(),
    );
    await s.react({ name: "eyes" }); // must not throw
  });

  test("react rethrows other errors", async () => {
    const s = new SlackSurface(fakeClient({ reactionsAdd: () => { throw new Error("boom"); } }), binding());
    expect(s.react({ name: "x" })).rejects.toThrow("boom");
  });

  test("requestApproval delegates to the binding hook", async () => {
    let seen: any;
    const s = new SlackSurface(fakeClient(), binding({ requestApproval: async (r) => { seen = r; return { approved: false, by: "U2", note: "no" }; } }));
    const res = await s.requestApproval({ summary: "deploy" });
    expect(seen.summary).toBe("deploy");
    expect(res).toEqual({ approved: false, by: "U2", note: "no" });
  });

  test("factory builds a SlackSurface bound to the client", () => {
    const f = makeSlackSurfaceFactory(fakeClient());
    expect(f(binding())).toBeInstanceOf(SlackSurface);
  });
});
