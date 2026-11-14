import { describe, expect, test } from "bun:test";
import { audit } from "../../src/audit/index";
import * as Accounts from "../../src/db/accounts";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import * as Sessions from "../../src/db/sessions";
import { flushFirstSightWork } from "../../src/domain/first-sight-flush";
import { resetFirstSight, setLiveWorkspaces } from "../../src/domain/first-sight";

const WS = "T0EXAMPLE";
const count = async (t: string) => Number((await db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n);

describe("first sight isolation in tests", () => {
  test("a fire-and-forget audit observation is flushed without sleeping", async () => {
    resetFirstSight();
    setLiveWorkspaces(() => [WS]);
    await audit({ actorKind: "slack_user", actorId: "U0ISOLATE", action: "x.y" }, { sink: () => {} });
    await flushFirstSightWork();
    expect((await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "U0ISOLATE" }))?.state).toBe("observed");
  });

  test("a session's fire-and-forget channel write is flushed, and _wipeForTests clears the domain tables", async () => {
    resetFirstSight();
    await Sessions.createForThread({ thread: { team_id: WS, channel_id: "C0ISOLATE", thread_ts: "9.9" }, model: "m", working_dir: "/w" });
    await Accounts._wipeForTests();
    expect(await count("users")).toBe(0);
    expect(await count("bindings")).toBe(0);
    expect(await count("boundaries")).toBe(0);
    expect(await count("user_aliases")).toBe(0);
    await flushFirstSightWork();
    expect(await count("boundaries")).toBe(0);
    await db.run("DELETE FROM sessions");
  });
});
