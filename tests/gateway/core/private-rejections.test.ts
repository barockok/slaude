/**
 * A person the agent will not answer (a thread locked to someone else, an ignore, an
 * owner guardrail) is told so privately, once in a while, and only when they spoke to the
 * agent. Nothing is ever posted to the thread, and the message still does not run.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { db } from "../../../src/db/schema";
import * as Ignores from "../../../src/db/ignores";
import * as OneOnOne from "../../../src/db/one-on-one";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __setProactiveSoulSource } from "../../../src/soul/proactive";
import { __resetPersonaRegistry } from "../../../src/persona/registry";
import { __clearGuardrailsForTests, applyGuardrailChange } from "../../../src/db/guardrails";
import { __resetGuardrailSnapshotsForTests, refreshGuardrails } from "../../../src/guardrails/snapshot";
import { BOT, SENDER, makeGw, nextTs, tick } from "./private-harness";

const DENY = "---\nname: inbound-care\ndescription: d\n---\n```rules\n- id: no-passwords\n  on: inbound\n  match: { text: '(?i)password\\s*[:=]' }\n  action: deny\n  message: Please do not paste passwords here.\n```";

const say = (g: ReturnType<typeof makeGw>, user: string, text: string, thread: string) => ({
  event: { type: "message", channel: "C1", channel_type: "channel", user, team: "T", ts: nextTs(), thread_ts: thread, text },
  client: g.client,
  context: { teamId: "T" },
});

describe("private rejection notices", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM sessions");
    await db.run("DELETE FROM seen_events");
    await db.run("DELETE FROM ignores").catch(() => {});
    writeSoulFixture({ ...WORLD, trusted: ["C1"] });
  });
  afterEach(async () => {
    __setProactiveSoulSource(null);
    __resetPersonaRegistry();
    await db.run("DELETE FROM ignores").catch(() => {});
    await __clearGuardrailsForTests();
    __resetGuardrailSnapshotsForTests();
  });

  describe("a thread locked to someone else", () => {
    const lock = async (thread: string) => OneOnOne.lock({ channelId: "C1", threadTs: thread, lockedUser: "U0OWNER", createdBy: "U0OWNER" });

    it("tells the person once, names the lock owner, and does not run", async () => {
      const g = makeGw();
      const thread = nextTs();
      await lock(thread);
      await g.emit("message", say(g, "U0MEMBER", `<@${BOT}> hello?`, thread));
      await tick();
      expect(g.sends).toHaveLength(0);
      expect(g.posts).toHaveLength(0);
      expect(g.ephemerals).toHaveLength(1);
      expect(g.ephemerals[0].user).toBe("U0MEMBER");
      expect(g.ephemerals[0].thread_ts).toBe(thread);
      expect(g.ephemerals[0].text).toContain("<@U0OWNER>");
      expect(g.ephemerals[0].text).toContain("1on1");
      await g.emit("message", say(g, "U0MEMBER", `<@${BOT}> still there?`, thread));
      await tick();
      expect(g.ephemerals).toHaveLength(1);
    });

    it("stays silent for chatter that is not addressed to the agent", async () => {
      const g = makeGw();
      const thread = nextTs();
      await lock(thread);
      await g.emit("message", say(g, "U0MEMBER", "thanks all", thread));
      await tick();
      expect(g.ephemerals).toHaveLength(0);
      expect(g.posts).toHaveLength(0);
    });

    it("says nothing to the lock owner or the manager", async () => {
      const g = makeGw();
      const thread = nextTs();
      await lock(thread);
      await g.emit("message", say(g, "U0OWNER", `<@${BOT}> hi`, thread));
      await g.emit("message", say(g, SENDER, `<@${BOT}> hi`, thread));
      await tick();
      expect(g.ephemerals.filter((e) => String(e.text).includes("locked 1on1"))).toHaveLength(0);
    });

    it("falls back to a DM, never the thread, when the ephemeral is refused", async () => {
      const g = makeGw({ ephemeralFails: true });
      const thread = nextTs();
      await lock(thread);
      await g.emit("message", say(g, "U0MEMBER", `<@${BOT}> hello?`, thread));
      await tick();
      expect(g.posts.filter((p) => p.channel === "C1")).toHaveLength(0);
      expect(g.posts.filter((p) => p.channel === "U0MEMBER")).toHaveLength(1);
    });
  });

  describe("an ignored person", () => {
    it("is told once, privately, that the agent is ignoring them here", async () => {
      const g = makeGw();
      await Ignores.create({ targetType: "user", userId: "U0MEMBER", createdBy: SENDER });
      const thread = nextTs();
      await g.emit("message", say(g, "U0MEMBER", `<@${BOT}> hello?`, thread));
      await tick();
      expect(g.posts).toHaveLength(0);
      expect(g.ephemerals).toHaveLength(1);
      expect(g.ephemerals[0].user).toBe("U0MEMBER");
      expect(String(g.ephemerals[0].text).toLowerCase()).toContain("ignor");
      await g.emit("message", say(g, "U0MEMBER", `<@${BOT}> hello again`, thread));
      await tick();
      expect(g.ephemerals).toHaveLength(1);
    });
  });

  describe("an owner guardrail denial", () => {
    it("falls back to a DM, never the channel, when the ephemeral is refused", async () => {
      const g = makeGw({ ephemeralFails: true });
      await __clearGuardrailsForTests();
      __resetGuardrailSnapshotsForTests();
      await applyGuardrailChange("default", { upsert: [{ slug: "inbound-care", md: DENY, source: "file" }], by: "test" });
      await refreshGuardrails();
      const thread = nextTs();
      await g.emit("message", say(g, "U0MEMBER", `<@${BOT}> my password: nope`, thread));
      await tick();
      expect(g.posts.filter((p) => p.channel === "C1")).toHaveLength(0);
      const dm = g.posts.filter((p) => p.channel === "U0MEMBER");
      expect(dm).toHaveLength(1);
      expect(dm[0].text).toContain("Please do not paste passwords here.");
    });
  });

  describe("lifting an ignore", () => {
    it("an ignored manager can still run /unignore on themselves", async () => {
      const g = makeGw();
      await Ignores.create({ targetType: "user", userId: SENDER, createdBy: SENDER });
      const thread = nextTs();
      await g.emit("message", say(g, SENDER, `<@${BOT}> /unignore <@${SENDER}>`, thread));
      await tick();
      expect(await Ignores.findActiveForUser(SENDER)).toBeNull();
      expect(g.posts.map((p) => String(p.text)).join("\n")).toContain("stopped ignoring");
    });
  });
});
