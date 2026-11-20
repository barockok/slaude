/**
 * The remaining gateway-generated posts: a failed turn, the /mcp server list, and the card
 * that asks someone to connect a bridged server. Each goes to the one person it is for.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { db } from "../../../src/db/schema";
import * as Sessions from "../../../src/db/sessions";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __setProactiveSoulSource } from "../../../src/soul/proactive";
import { __resetPersonaRegistry } from "../../../src/persona/registry";
import { failureText } from "../../../src/gateway/core/failure-codes";
import { BOT, SENDER, makeGw, nextTs, tick } from "./private-harness";

const say = (g: ReturnType<typeof makeGw>, user: string, text: string, thread: string) => ({
  event: { type: "message", channel: "C1", channel_type: "channel", user, team: "T", ts: nextTs(), thread_ts: thread, text },
  client: g.client,
  context: { teamId: "T" },
});

describe("remaining private notices", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM sessions");
    await db.run("DELETE FROM seen_events");
    writeSoulFixture({ ...WORLD, trusted: ["C1"] });
  });
  afterEach(() => {
    __setProactiveSoulSource(null);
    __resetPersonaRegistry();
  });

  it("a failed turn tells the person whose turn it was, not the thread", async () => {
    const g = makeGw();
    const thread = nextTs();
    await g.emit("message", say(g, SENDER, `<@${BOT}> do the thing`, thread));
    await tick();
    const row = await Sessions.findByThread({ team_id: "T", channel_id: "C1", thread_ts: thread });
    expect(row).toBeTruthy();
    g.agent.emit("event", { type: "error", sessionId: row!.id, error: "Invalid API key", code: "TURN_FAILED", jobId: "job-private-1" } as any);
    await tick();
    expect(g.posts.filter((p) => p.channel === "C1" && String(p.text).includes(failureText("TURN_FAILED")))).toHaveLength(0);
    const mine = g.ephemerals.filter((e) => e.text === failureText("TURN_FAILED"));
    expect(mine).toHaveLength(1);
    expect(mine[0].user).toBe(SENDER);
    expect(JSON.stringify(g.ephemerals)).not.toContain("Invalid API key");
  });

  it("/mcp shows the server list to the sender only", async () => {
    const g = makeGw();
    const thread = nextTs();
    await g.emit("message", say(g, SENDER, `<@${BOT}> /mcp`, thread));
    await tick();
    expect(g.posts.filter((p) => p.channel === "C1")).toHaveLength(0);
    expect(g.ephemerals.some((e) => String(e.text).includes("MCP"))).toBe(true);
  });

  it("the bridge connect card goes by DM to the person who must click it, naming the channel", async () => {
    const g = makeGw();
    await g.h.__postBridgeConnectCard!({ persona: "default", session: "s", team: "T", channel: "C1", thread: nextTs(), initiator: SENDER, runAs: "agent", app: "A1" } as never, "svc", "global", "connect");
    expect(g.posts.filter((p) => p.channel === "C1")).toHaveLength(0);
    const dm = g.posts.filter((p) => p.channel === SENDER);
    expect(dm).toHaveLength(1);
    expect(String(dm[0].text)).toContain("<#C1>");
    expect((dm[0].blocks as any[]).some((b) => b.type === "actions")).toBe(true);
  });
});
