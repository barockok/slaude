/**
 * What the heartbeat slot starts, end to end through the scheduler's handler:
 * a proactive channel's wake in its channel session, never an agent-level
 * `wake:` session.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { db } from "../../src/db/schema";
import * as Sessions from "../../src/db/sessions";
import { passHandlers, type SlotRun } from "../../src/background/scheduler";
import { channelSessionKey } from "../../src/gateway/core/channel-session";
import { paths } from "../../src/config/home";
import { writeSoulFixture, WORLD } from "../../src/gateway/sim/soul-fixture";
import { __setProactiveSoulSource } from "../../src/soul/proactive";
import { fakeBrain } from "../memory/fake-brain";

const NOW = new Date("2026-10-26T12:00:00Z");

function run(): SlotRun {
  return { agentId: "U0AGENT", personaId: "default", personaIds: ["default"], timeZone: "UTC", pass: "heartbeat", slot: "2026-10-26T12:00", now: NOW, signal: new AbortController().signal };
}

function slack() {
  const sent: { threadTs: string; channelId?: string }[] = [];
  return {
    sent,
    slack: {
      post: async () => undefined,
      wake: { dispatch: async (t: { threadTs: string; channelId?: string }) => void sent.push(t) },
      managers: () => [],
      digestRecipient: () => null,
    } as never,
  };
}

const handler = (s: ReturnType<typeof slack>) => passHandlers({ runner: { now: () => NOW } as never, call: fakeBrain().call, listSources: async () => [] } as never, s.slack).heartbeat!;

describe("the heartbeat slot", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM channel_wake_state");
    await db.run("DELETE FROM background_runs");
    await db.run("DELETE FROM sessions");
    writeSoulFixture({ ...WORLD, trusted: ["C1"], channelOverrides: [{ channel: "C1", mandate: "Keep the release moving." }] });
    await Sessions.createForThread({ thread: { team_id: "T", channel_id: "C1", thread_ts: "1.1", persona_id: "default" }, model: "m", working_dir: "/tmp/x" });
  });
  afterEach(() => __setProactiveSoulSource(null));

  test("a proactive channel wakes in its channel session; no wake: thread is dispatched", async () => {
    appendFileSync(paths.soul, "\n## Channel <#C1>\n### Proactive\n- Enabled: yes\n");
    const s = slack();
    await handler(s)(run());
    expect(s.sent.length).toBeGreaterThan(0);
    for (const t of s.sent) expect(t.threadTs).toBe(channelSessionKey("C1"));
    for (const t of s.sent) expect(t.threadTs.startsWith("wake:")).toBe(false);
  });

  test("a global Enabled: yes wakes nothing and warns", async () => {
    appendFileSync(paths.soul, "\n## Proactive\n- Enabled: yes\n");
    const s = slack();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await handler(s)(run());
      expect(s.sent).toEqual([]);
      expect(warn.mock.calls.map((a) => String(a[0])).join(" ")).toContain("global ## Proactive");
    } finally {
      warn.mockRestore();
    }
  });
});
