import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import * as Sessions from "../../src/db/sessions";
import * as ChannelWake from "../../src/db/channel-wake-state";
import { parseSlashCommand } from "../../src/gateway/slack/commands";
import { __setProactiveSoulSource } from "../../src/soul/proactive";
import { wakeStatusText } from "../../src/proactive/wake-status";

const NOW = new Date("2026-10-26T12:00:00Z");
const T = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
async function ledger(pass: string, cost: number, outcome: Runs.RunOutcome) {
  const id = await Runs.start({ agentId: "A1", pass, scope: "agent", day: "2026-10-26", startedAt: NOW.getTime() });
  await Runs.finish(id, { tokens: T, costUsd: cost, outcome });
}
const status = (over: Record<string, unknown> = {}) =>
  wakeStatusText({ personaId: "default", agentId: "A1", managerId: "U0MANAGER", budget: { limitUsd: 1, proactiveLimitUsd: 3, timeZone: "UTC" }, now: NOW, ...over });

beforeEach(async () => {
  __setProactiveSoulSource(() => "## Channel <#CONE>\n### Proactive\n- Enabled: yes\n\n## Channel <#CTWO>\n### Proactive\n- Enabled: yes\n");
  await db.run("DELETE FROM background_runs");
  await db.run("DELETE FROM channel_wake_state");
});
afterEach(() => __setProactiveSoulSource(null));

describe("/heartbeat status", () => {
  test("parses, with or without the word status", () => {
    expect(parseSlashCommand("/heartbeat")).toEqual({ kind: "heartbeat-status" });
    expect(parseSlashCommand("/heartbeat status")).toEqual({ kind: "heartbeat-status" });
    expect(parseSlashCommand("/heartbeat nonsense")).toBeNull();
  });
  test("spend per pool, refusals, state, and the week's wakes", async () => {
    await ledger("heartbeat-wake", 0.5, "ok");
    await ledger("heartbeat-wake", 1, "stopped-budget");
    await ledger("heartbeat", 0, "skipped-budget");
    await ledger("skill-check", 0.25, "ok");
    await ChannelWake.noteStart("A1", "CONE", "h", "run-1", NOW.getTime());
    const t = await status();
    expect(t).toContain("proactive $1.50 of $3.00, learning $0.25 of $1.00");
    expect(t).toContain("Refused by budget today: 1");
    expect(t).toContain("2 wakes");
    expect(t).toContain("1 stopped by a cap");
    expect(t).toContain("<#CONE>: last wake 2026-10-26 12:00 UTC");
    expect(t).toContain("<#CTWO>: no wake yet");
    expect(t).not.toContain("Mode:");
    expect(t).not.toContain("Last wake:");
  });
  test("one shared budget; a global Enabled: yes alone lists no channel", async () => {
    __setProactiveSoulSource(() => "## Proactive\n- Enabled: yes\n");
    const t = await status({ budget: { limitUsd: 1, timeZone: "UTC" } });
    expect(t).toContain("one shared budget");
    expect(t).toContain("No channel has proactive on.");
  });
  test("no manager: says that no wake runs", async () => {
    const t = await status({ managerId: null });
    expect(t).toContain("no manager");
  });
});

describe("the wake session sweep", () => {
  test("removes only old wake sessions, never a real thread", async () => {
    const mk = (thread: string) => Sessions.createForThread({ thread: { team_id: "T", channel_id: "U0MANAGER", thread_ts: thread, persona_id: "default" }, model: "", working_dir: "/tmp/w", permission_mode: "default" } as never);
    const old = await mk("wake:A1:old");
    const fresh = await mk("wake:A1:new");
    const real = await mk("1700.100");
    await db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [1000, old.id]);
    await db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [1000, real.id]);
    expect(await Sessions.deleteWakeSessionsBefore(5000)).toBe(1);
    expect(await Sessions.findById(old.id)).toBeNull();
    expect(await Sessions.findById(real.id)).not.toBeNull();
    expect(await Sessions.findById(fresh.id)).not.toBeNull();
  });
});
