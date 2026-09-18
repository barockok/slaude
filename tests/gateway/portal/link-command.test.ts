/**
 * `/link` end to end through the gateway's message router.
 *
 * The property under test is delivery: the onboarding link is what proves the
 * requester controls the Slack account, so it must arrive ephemerally and never
 * as a channel post. Every assertion here is about who can see the reply.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { verifyLinkToken } from "../../../src/gateway/portal/link-token";
import * as Accounts from "../../../src/db/accounts";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";

const ISS = "https://idp.example.com/realms/slaude";
const TEAM = "TTESTTEAM1";

function harness() {
  const posts: any[] = [];
  const ephemeral: any[] = [];
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: TEAM, url: "x" }) },
      chat: {
        postMessage: async (a: any) => { posts.push(a); return { ok: true, ts: "1.1" }; },
        postEphemeral: async (a: any) => { ephemeral.push(a); return { ok: true, message_ts: "1.2" }; },
        update: async () => ({ ok: true }),
      },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    } as any,
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => { handlers.set(name, fn); },
  };
  const agent = new AgentManager();
  agent.sendMessage = async () => {};
  createGateway(agent, t);

  const send = async (text: string, who: { userId: string; teamId?: string; channel?: string }) =>
    handlers.get("message")?.({
      event: {
        type: "message",
        channel: who.channel ?? "D_MGR",
        channel_type: who.channel ? "channel" : "im",
        user: who.userId,
        team: who.teamId ?? TEAM,
        ts: `${Date.now()}.1`,
        text,
      },
      client: t.client,
      context: { teamId: who.teamId ?? TEAM },
    });

  return { send, posts, ephemeral };
}

const USER = WORLD.manager;

beforeEach(async () => {
  process.env.SLACK_BOT_TOKEN ||= "xoxb-test";
  process.env.SLAUDE_PORTAL = "1";
  process.env.SLAUDE_PANEL_SECRET = "p".repeat(32);
  process.env.SLAUDE_PANEL_PUBLIC_URL = "https://slaude.example.com";
  writeSoulFixture(WORLD);
  await Accounts._wipeForTests();
});

describe("/link", () => {
  test("posts an onboarding URL ephemerally, never publicly", async () => {
    const { send, posts, ephemeral } = harness();

    await send("/link", { userId: USER });

    expect(ephemeral).toHaveLength(1);
    expect(String(ephemeral[0].text)).toContain("/portal/link?t=");
    expect(ephemeral[0].user).toBe(USER);
    expect(posts).toHaveLength(0);
  });

  test("the link carries a token bound to the requesting user and workspace", async () => {
    const { send, ephemeral } = harness();

    await send("/link", { userId: USER });

    // The Slack renderer autolinks a bare URL to <url|label>, so take the URL
    // half; a naive \S+ would swallow the label and the closing bracket.
    const raw = String(ephemeral[0].text).match(/<?(https?:\/\/[^\s|>]+)/)![1]!;
    const url = new URL(raw);
    const r = verifyLinkToken(url.searchParams.get("t"));
    expect(r.ok && r.claims.slackUser).toBe(USER);
    expect(r.ok && r.claims.team).toBe(TEAM);
  });

  test("an already-linked user is told so instead of being sent a link", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: USER, accountId: a.id, via: "signed-link" });
    const { send, posts, ephemeral } = harness();

    await send("/link", { userId: USER });

    expect(String(ephemeral[0].text)).toContain("alice@example.com");
    expect(String(ephemeral[0].text)).not.toContain("/portal/link?t=");
    expect(posts).toHaveLength(0);
  });

  test("with the portal disabled the command says so rather than minting a dead link", async () => {
    process.env.SLAUDE_PORTAL = "0";
    const { send, ephemeral } = harness();

    await send("/link", { userId: USER });

    expect(String(ephemeral[0].text)).toContain("not enabled");
    expect(String(ephemeral[0].text)).not.toContain("/portal/link?t=");
  });
});
