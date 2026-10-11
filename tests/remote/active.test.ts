import { describe, it, expect, beforeEach } from "bun:test";
import * as OneOnOne from "../../src/db/one-on-one";
import * as Remote from "../../src/db/remote";
import { activeRemoteTarget } from "../../src/remote/active";

beforeEach(async () => { await OneOnOne._wipeForTests(); await Remote._wipeForTests(); });

const target = (userId = "U_A") =>
  Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId, addr: "tcA", dir: "/r", lockByRemote: true });

describe("activeRemoteTarget", () => {
  it("is null without a target", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    expect(await activeRemoteTarget("C1", "1.0")).toBeNull();
  });
  it("is null without a lock (no lock, no remote)", async () => {
    await target();
    expect(await activeRemoteTarget("C1", "1.0")).toBeNull();
  });
  it("is null when the lock is open to guests", async () => {
    await target();
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    await OneOnOne.setOpen("C1", "1.0", "");
    expect(await activeRemoteTarget("C1", "1.0")).toBeNull();
  });
  it("is null when the lock belongs to someone else", async () => {
    await target("U_A");
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_MGR", createdBy: "U_MGR" });
    expect(await activeRemoteTarget("C1", "1.0")).toBeNull();
  });
  it("returns the target when locked to its owner", async () => {
    await target();
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    expect(await activeRemoteTarget("C1", "1.0")).toEqual({ teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r" });
  });
});
