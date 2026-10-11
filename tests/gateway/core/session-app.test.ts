/**
 * D1.2 follow-up: an inbound event records its Slack app on the session row,
 * and a panel-sourced turn (no inbound event) carries that app into its
 * dispatch, so the job token names it and /v1 posts go out as that app even
 * with two apps installed in one team, on any replica.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { createGateway, panelDispatchMeta } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import type { SessionRow } from "../../../src/db/schema";
import { db } from "../../../src/db/schema";
import * as Sessions from "../../../src/db/sessions";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";

function setup() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const client: any = {
    auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
    chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  };
  const t: Transport = {
    client,
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => void handlers.set(name, fn),
  };
  const agent = new AgentManager();
  const sessions: string[] = [];
  agent.sendMessage = async (id: string) => void sessions.push(id);
  createGateway(agent, t);
  const dm = (ts: string, context: any) =>
    handlers.get("message")!({
      event: { type: "message", channel: "D_MGR", channel_type: "im", user: WORLD.manager, team: "T", ts, text: "hello" },
      client,
      context,
    });
  return { dm, sessions };
}

describe("session app identity", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM sessions");
    await db.run("DELETE FROM seen_events");
    writeSoulFixture(WORLD);
  });

  it("an inbound event records its app on the session row", async () => {
    const g = setup();
    await g.dm("920.1", { teamId: "T", apiAppId: "A0TWO" });
    expect((await Sessions.findById(g.sessions[0]!))!.slack_app_id).toBe("A0TWO");
  });

  it("an event with no app (Socket Mode) leaves the row alone", async () => {
    const g = setup();
    await g.dm("920.2", { teamId: "T" });
    expect((await Sessions.findById(g.sessions[0]!))!.slack_app_id ?? null).toBeNull();
  });

  it("a panel turn's dispatch carries the session's recorded app", () => {
    const row = { id: "S1", slack_team_id: "T", slack_channel_id: "C1", slack_thread_ts: "1.0", persona_id: "default", slack_app_id: "A0TWO" } as SessionRow;
    expect(panelDispatchMeta(row, "op", "2.0")).toEqual({
      teamId: "T", channelId: "C1", threadTs: "1.0", eventTs: "2.0", userId: "op", personaId: undefined, apiAppId: "A0TWO",
    });
    const legacy = { ...row, slack_app_id: null } as SessionRow;
    expect("apiAppId" in panelDispatchMeta(legacy, "op", "2.0")).toBe(false);
  });
});
