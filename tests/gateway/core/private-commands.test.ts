/**
 * Gateway-generated command replies are private: an ephemeral to the sender, a DM when
 * that fails, never the thread. State changes other people must know about keep one
 * short public line.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { db } from "../../../src/db/schema";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __setProactiveSoulSource } from "../../../src/soul/proactive";
import { __resetPersonaRegistry } from "../../../src/persona/registry";
import { BOT, SENDER, makeGw, nextTs, threadMsg, tick } from "./private-harness";

describe("private command replies", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM sessions");
    await db.run("DELETE FROM seen_events");
    writeSoulFixture({ ...WORLD, trusted: ["C1"] });
  });
  afterEach(() => {
    __setProactiveSoulSource(null);
    __resetPersonaRegistry();
    delete process.env.SLAUDE_PRIVATE_NOTICES;
  });

  it("/help in a thread is an ephemeral to the sender and nothing is posted", async () => {
    const g = makeGw();
    const thread = nextTs();
    await g.emit("message", threadMsg(g, `<@${BOT}> /help`, thread));
    await tick();
    expect(g.posts).toHaveLength(0);
    expect(g.ephemerals).toHaveLength(1);
    expect(g.ephemerals[0].user).toBe(SENDER);
    expect(g.ephemerals[0].thread_ts).toBe(thread);
    expect(String(g.ephemerals[0].text)).toContain("/mode");
  });

  it("when the ephemeral is refused the reply is a DM, never the thread", async () => {
    const g = makeGw({ ephemeralFails: true });
    await g.emit("message", threadMsg(g, `<@${BOT}> /help`, nextTs()));
    await tick();
    expect(g.posts.filter((p) => p.channel === "C1")).toHaveLength(0);
    expect(g.posts.filter((p) => p.channel === SENDER)).toHaveLength(1);
  });

  it("when both fail nothing is posted anywhere and the sender gets the error reaction", async () => {
    const g = makeGw({ ephemeralFails: true, dmFails: true });
    await g.emit("message", threadMsg(g, `<@${BOT}> /help`, nextTs()));
    await tick();
    expect(g.posts).toHaveLength(0);
  });

  it("a state change keeps one short public line, the rest of the reply is private", async () => {
    const g = makeGw();
    await g.emit("message", threadMsg(g, `<@${BOT}> /mode plan`, nextTs()));
    await tick();
    expect(g.posts.filter((p) => p.channel === "C1")).toHaveLength(1);
    expect(String(g.posts[0].text)).toContain("plan");
    expect(g.ephemerals).toHaveLength(0);
  });

  it("with SLAUDE_PRIVATE_NOTICES off, /help is posted publicly as before", async () => {
    process.env.SLAUDE_PRIVATE_NOTICES = "off";
    const g = makeGw();
    await g.emit("message", threadMsg(g, `<@${BOT}> /help`, nextTs()));
    await tick();
    expect(g.ephemerals).toHaveLength(0);
    expect(g.posts.filter((p) => p.channel === "C1")).toHaveLength(1);
  });
});
