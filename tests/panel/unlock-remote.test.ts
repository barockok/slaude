import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import { db } from "../../src/db/schema";
import * as Sessions from "../../src/db/sessions";
import * as OneOnOne from "../../src/db/one-on-one";
import * as Remote from "../../src/db/remote";
import { __resetMasterKeyCache } from "../../src/db/crypto";

const SECRET = "t".repeat(32);

beforeEach(async () => {
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_OPERATORS = "op@example.com";
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
  __resetMasterKeyCache();
  __resetRoleCache();
  await OneOnOne._wipeForTests();
  await Remote._wipeForTests();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("SLAUDE_PANEL")) delete process.env[k];
  __resetRoleCache();
});

const unlock = async (id: string, unlocked: string[]) => {
  const api = createPanelApi({ registry: null, pubsub: null, panelLock: null, chat: async () => {}, onUnlock: (s) => { unlocked.push(s); } });
  return (await api.fetch(
    new Request(`https://panel.example.com/panel/api/sessions/${id}/control`, {
      method: "POST",
      headers: {
        cookie: `${AT_COOKIE}=${mintSession({ sub: "s", email: "op@example.com" }, "at", { secret: SECRET })}`,
        "x-panel-csrf": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "unlock-1on1" }),
    }),
  ))!;
};

describe("panel unlock-1on1", () => {
  it("ends a remote target together with the lock", async () => {
    const row = await Sessions.createForThread({
      thread: { team_id: "T1", channel_id: "C_PU", thread_ts: "9.1" },
      model: "m",
      working_dir: "/tmp/x",
    });
    await OneOnOne.lock({ channelId: "C_PU", threadTs: "9.1", lockedUser: "U_A", createdBy: "U_A" });
    await Remote.setTarget({ channelId: "C_PU", threadTs: "9.1", teamId: "T1", userId: "U_A", addr: "tcAddr1", dir: "/r", lockByRemote: false });
    const unlocked: string[] = [];
    const res = await unlock(row.id, unlocked);
    expect(res.status).toBe(200);
    expect(await OneOnOne.find("C_PU", "9.1")).toBeNull();
    expect(await Remote.findTarget("C_PU", "9.1")).toBeNull();
    expect(unlocked).toEqual([row.id]);
  });

  it("does not reload when the session has no Slack thread", async () => {
    const row = await Sessions.createForThread({
      thread: { team_id: "T1", channel_id: "C_PU", thread_ts: "9.2" },
      model: "m",
      working_dir: "/tmp/x",
    });
    await db.run("UPDATE sessions SET slack_thread_ts = NULL WHERE id = ?", [row.id]);
    const unlocked: string[] = [];
    expect((await unlock(row.id, unlocked)).status).toBe(400);
    expect(unlocked).toEqual([]);
  });
});
