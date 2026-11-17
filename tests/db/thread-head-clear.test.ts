import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Sessions from "../../src/db/sessions";

const ids: string[] = [];
beforeAll(async () => {
  await db.query("SELECT 1");
}, 60_000);
afterAll(async () => {
  for (const id of ids) await db.run("DELETE FROM sessions WHERE id = ?", [id]);
});

describe("the thread head marker and a restart with no transcript", () => {
  test("clearStarted gives the head back, a claim then wins again", async () => {
    const r = await Sessions.createForThread({ thread: { team_id: "T0EXAMPLE", channel_id: "C0CLEAR", thread_ts: "1.1" }, model: "m", working_dir: "/w" });
    ids.push(r.id);
    expect(await Sessions.threadHeadPending(r.id)).toBe(true);
    expect(await Sessions.claimThreadHead(r.id, 10)).toBe(true);
    expect(await Sessions.threadHeadPending(r.id)).toBe(false);
    await Sessions.markStarted(r.id);
    await Sessions.clearStarted(r.id);
    expect(await Sessions.threadHeadPending(r.id)).toBe(true);
    expect(await Sessions.claimThreadHead(r.id, 20)).toBe(true);
  });
  test("the marker is not part of the public row", async () => {
    const r = await Sessions.createForThread({ thread: { team_id: "T0EXAMPLE", channel_id: "C0CLEAR", thread_ts: "2.2" }, model: "m", working_dir: "/w" });
    ids.push(r.id);
    await Sessions.claimThreadHead(r.id, 5);
    expect(Object.keys((await Sessions.findById(r.id))!)).not.toContain("thread_head_at");
  });
});
