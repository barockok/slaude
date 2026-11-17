import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { audit } from "../../src/audit/index";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import * as Sessions from "../../src/db/sessions";
import { flushFirstSight, resetFirstSight, setLiveWorkspaces } from "../../src/domain/first-sight";

const WS = "T0EXAMPLE";
const nap = () => new Promise((r) => setTimeout(r, 20));

describe("first sight seams (global db)", () => {
  afterAll(() => setLiveWorkspaces(() => []));
  beforeEach(async () => {
    await Domain._wipeForTests();
    for (const t of ["audit_events", "sessions"]) await db.run(`DELETE FROM ${t}`);
    resetFirstSight();
    setLiveWorkspaces(() => [WS]);
  });

  test("an audit event with a Slack user actor and a channel observes both", async () => {
    await audit({ actorKind: "slack_user", actorId: "U0EXAMPLE", action: "gate.permission.refused", decision: "refused", channelId: "C0EXAMPLE" }, { sink: () => {} });
    await nap();
    await flushFirstSight();
    expect((await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE" }))?.state).toBe("observed");
    expect(await Domain.findBoundary({ service: "slack", workspace: WS, value: "C0EXAMPLE" })).not.toBeNull();
  });

  test("first sight's own audit events do not loop: one user.created, one binding.created, no more", async () => {
    await audit({ actorKind: "slack_user", actorId: "U0EXAMPLE", action: "gate.permission.decided" }, { sink: () => {} });
    await nap();
    await flushFirstSight();
    await nap();
    await flushFirstSight();
    const rows = await db.query<{ action: string }>("SELECT action FROM audit_events ORDER BY id");
    const created = rows.map((r) => r.action).filter((a) => a.endsWith(".created"));
    expect(created.sort()).toEqual(["binding.created", "user.created"]);
  });

  test("a non-user actor is not observed", async () => {
    await audit({ actorKind: "operator", actorId: "UOPERATOR1", action: "x.y" }, { sink: () => {} });
    await nap();
    await flushFirstSight();
    expect(await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "UOPERATOR1" })).toBeNull();
  });

  test("two live workspaces and no session: the workspace is unknown, nothing is written", async () => {
    setLiveWorkspaces(() => [WS, "T1EXAMPLE"]);
    await audit({ actorKind: "slack_user", actorId: "U0EXAMPLE", action: "x.y" }, { sink: () => {} });
    await nap();
    await flushFirstSight();
    expect(await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE" })).toBeNull();
  });

  test("session creation observes the channel", async () => {
    await Sessions.createForThread({ thread: { team_id: WS, channel_id: "D0EXAMPLE", thread_ts: "1.1" }, model: "m", working_dir: "/w" });
    await nap();
    await flushFirstSight();
    expect((await Domain.findBoundary({ service: "slack", workspace: WS, value: "D0EXAMPLE" }))?.kind).toBe("dm");
  });

  test("a session lookup that found nothing is not repeated within the TTL", async () => {
    setLiveWorkspaces(() => [WS, "T1EXAMPLE"]);
    const spy = spyOn(db, "one");
    try {
      for (let i = 0; i < 3; i++) {
        await audit({ actorKind: "slack_user", actorId: "U0NEGCACHE", action: "x.y", sessionId: "no-such-session" }, { sink: () => {} });
        await nap();
      }
      await flushFirstSight();
      const lookups = spy.mock.calls.filter((c) => String(c[0]).includes("FROM sessions WHERE id"));
      expect(lookups.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
