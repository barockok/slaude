import { expect, test } from "bun:test";
import * as Sessions from "../../src/db/sessions";

test("archiving frees the key and keeps the row", async () => {
  const thread = { team_id: "T1", channel_id: "C1", thread_ts: "channel:C1", persona_id: "p1" };
  const row = await Sessions.createForThread({ thread, model: "m", working_dir: "/tmp/x" });
  await Sessions.archiveChannelSession(row.id, "C1", 42);
  expect(await Sessions.findByThread(thread)).toBeNull();
  expect((await Sessions.findById(row.id))?.slack_thread_ts).toBe("channel-archived:C1:42");
});
