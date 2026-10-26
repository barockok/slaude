import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Sessions from "../../src/db/sessions";

async function session(persona: string, thread: string, updatedAt: number): Promise<string> {
  const s = await Sessions.createForThread({ thread: { team_id: "T0TEAM", channel_id: "C0CHAN", thread_ts: thread, persona_id: persona }, model: "m", working_dir: "/tmp" });
  await db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [updatedAt, s.id]);
  return s.id;
}

beforeEach(async () => {
  await db.run("DELETE FROM sessions");
});

describe("Sessions.updatedSince", () => {
  test("these personas' sessions touched since the cut, most recent first; the limit keeps the active ones", async () => {
    const old = await session("default", "1.1", 1_000);
    const a = await session("default", "1.2", 5_000);
    const b = await session("p-named", "1.3", 6_000);
    const c = await session("default", "1.4", 7_000);
    await session("p-other", "1.5", 8_000);
    expect((await Sessions.updatedSince(["default", "p-named"], 2_000)).map((s) => s.id)).toEqual([c, b, a]);
    expect((await Sessions.updatedSince(["default", "p-named"], 2_000, 2)).map((s) => s.id)).toEqual([c, b]);
    expect((await Sessions.updatedSince(["default"], 0)).map((s) => s.id)).toContain(old);
    expect(await Sessions.updatedSince([], 0)).toEqual([]);
  });
});
