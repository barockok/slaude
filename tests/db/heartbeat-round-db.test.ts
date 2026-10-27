import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Posts from "../../src/db/proactive-posts";
import * as Marks from "../../src/db/heartbeat-watermarks";

// Runs on whichever driver the suite is on (sqlite by default, PGLite with
// SLAUDE_DB=pg), like the other repo tests.
const base = {
  agentId: "a1",
  audience: "person" as const,
  recipient: "U0ALICE",
  topic: "t",
  textHash: "h",
  evidenceHash: null,
  channelId: "D1",
  teamId: "T1",
  postedAt: 1000,
};

beforeEach(async () => {
  await db.run("DELETE FROM proactive_posts");
  await db.run("DELETE FROM heartbeat_watermarks");
});

describe("proactive_posts text and context", () => {
  test("a post round-trips its text and context; an old row reads null", async () => {
    const context: Posts.PostContext = { source: "mail", itemId: "m1", summary: "s", ruleSlug: "r", level: "ask", evidence: "e" };
    await Posts.recordPost({ ...base, messageTs: "1.1", text: "hello", context });
    await db.run(
      `INSERT INTO proactive_posts (id, agent_id, audience, recipient, topic, text_hash, channel_id, message_ts, posted_at)
       VALUES ('old', 'a1', 'person', 'U0ALICE', 't', 'h', 'D1', '2.2', 1)`,
    );
    const fresh = await Posts.findByMessage("D1", "1.1");
    expect(fresh?.text).toBe("hello");
    expect(fresh?.context).toEqual(context);
    expect(fresh?.context?.level).toBe("ask");
    const old = await Posts.findByMessage("D1", "2.2");
    expect(old?.text).toBeNull();
    expect(old?.context).toBeNull();
  });

  test("unreadable context JSON reads as null", async () => {
    await Posts.recordPost({ ...base, messageTs: "3.3" });
    await db.run(`UPDATE proactive_posts SET context = '{nope' WHERE message_ts = '3.3'`);
    expect((await Posts.findByMessage("D1", "3.3"))?.context).toBeNull();
  });
});

describe("heartbeat watermarks", () => {
  test("watermarks only move forward", async () => {
    await Marks.advance("a1", "mail", 200, 1);
    await Marks.advance("a1", "mail", 100, 2);
    expect(await Marks.getSince("a1", "mail")).toBe(200);
    await Marks.advance("a1", "mail", 300, 3);
    expect(await Marks.getSince("a1", "mail")).toBe(300);
  });

  test("an unknown source has no watermark; agents are separate", async () => {
    await Marks.advance("a1", "mail", 200, 1);
    expect(await Marks.getSince("a1", "chat")).toBeNull();
    expect(await Marks.getSince("a2", "mail")).toBeNull();
  });
});
