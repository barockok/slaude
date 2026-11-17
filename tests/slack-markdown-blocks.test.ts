import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MARKDOWN_BLOCK_MAX, slackMessage } from "../src/gateway/slack/format";
import { formatOutbound } from "../src/gateway/slack/outbound";
import { SlackSurface } from "../src/gateway/slack/surface";
import type { SessionBinding } from "../src/gateway/core/surface";

const FLAG = "SLAUDE_SLACK_MARKDOWN_BLOCKS";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[FLAG];
  delete process.env[FLAG];
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

const TABLE = "| a | b |\n|---|---|\n| **x** | [l](https://example.com) |";

describe("slackMessage", () => {
  test("flag off: text only, untouched", () => {
    expect(slackMessage("*hi*", { flag: false })).toEqual({ text: "*hi*" });
    expect(slackMessage("*hi*", { flag: false, update: true })).toEqual({ text: "*hi*" });
  });
  test("flag on: one markdown block, the same text as the fallback", () => {
    expect(slackMessage(TABLE, { flag: true })).toEqual({ text: TABLE, blocks: [{ type: "markdown", text: TABLE }] });
  });
  test("flag on, exactly at the limit: still a block", () => {
    const t = "a".repeat(MARKDOWN_BLOCK_MAX);
    expect(slackMessage(t, { flag: true }).blocks).toHaveLength(1);
  });
  test("flag on, over the limit: mrkdwn text, no block (a post)", () => {
    const t = "**b** " + "a".repeat(MARKDOWN_BLOCK_MAX);
    const m = slackMessage(t, { flag: true });
    expect(m.blocks).toBeUndefined();
    expect(m.text.startsWith("*b* ")).toBe(true);
  });
  test("flag on, over the limit, an update: blocks cleared so an old block does not outlive the text", () => {
    const m = slackMessage("x".repeat(MARKDOWN_BLOCK_MAX + 1), { flag: true, update: true });
    expect(m.blocks).toEqual([]);
  });
});

describe("formatOutbound", () => {
  test("flag off: a table becomes a code block, bold becomes mrkdwn (as before)", () => {
    const out = formatOutbound("**x**\n\n" + TABLE, "reply", "default");
    expect(out.startsWith("*x*")).toBe(true);
    expect(out).toContain("```");
  });
  test("flag on: a chat message keeps its raw markdown", () => {
    process.env[FLAG] = "1";
    expect(formatOutbound("**x**\n\n" + TABLE, "reply", "default")).toBe("**x**\n\n" + TABLE);
    for (const kind of ["edit", "post_message", "runtime", "todo"] as const) expect(formatOutbound("**x**", kind, "default")).toBe("**x**");
  });
  test("flag on: a path that cannot send blocks still gets mrkdwn", () => {
    process.env[FLAG] = "1";
    expect(formatOutbound("**x**", "ephemeral", "default")).toBe("*x*");
    expect(formatOutbound("**x**", "upload_caption", "default")).toBe("*x*");
    expect(formatOutbound("**x**", "runtime", "default", true)).toBe("*x*");
  });
});

function recorder() {
  const posts: any[] = [];
  const updates: any[] = [];
  const client = {
    chat: {
      postMessage: async (a: any) => (posts.push(a), { ts: "100.0" }),
      update: async (a: any) => (updates.push(a), {}),
    },
  } as any;
  return { client, posts, updates };
}
const binding = (): SessionBinding => ({
  conversationId: "C1",
  threadRef: "123.456",
  inboundRef: "789.012",
  requestApproval: async () => ({ approved: true, by: "U1" }),
  reloadSession: () => true,
});

describe("SlackSurface with markdown blocks", () => {
  test("flag off: a reply is mrkdwn text with no blocks", async () => {
    const { client, posts } = recorder();
    await new SlackSurface(client, binding()).reply({ text: "**hi**" });
    expect(posts[0].text).toBe("*hi*");
    expect(posts[0].blocks).toBeUndefined();
    expect(posts[0].mrkdwn).toBe(true);
  });
  test("flag on: a reply is one markdown block of the raw text, with the raw text as fallback", async () => {
    process.env[FLAG] = "1";
    const { client, posts } = recorder();
    await new SlackSurface(client, binding()).reply({ text: TABLE });
    expect(posts[0].blocks).toEqual([{ type: "markdown", text: TABLE }]);
    expect(posts[0].text).toBe(TABLE);
  });
  test("flag on: an edit resends the block", async () => {
    process.env[FLAG] = "1";
    const { client, updates } = recorder();
    await new SlackSurface(client, binding()).edit({ ref: "100.0", text: "**now** done" });
    expect(updates[0].blocks).toEqual([{ type: "markdown", text: "**now** done" }]);
  });
  test("flag on: a reply over the block limit goes out as mrkdwn text", async () => {
    process.env[FLAG] = "1";
    const { client, posts } = recorder();
    await new SlackSurface(client, binding()).reply({ text: "**b** " + "a".repeat(MARKDOWN_BLOCK_MAX) });
    expect(posts[0].blocks).toBeUndefined();
    expect(posts[0].text.startsWith("*b* ")).toBe(true);
  });
});
