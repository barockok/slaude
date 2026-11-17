import { describe, it, expect, beforeEach } from "bun:test";
import * as OneOnOne from "../../src/db/one-on-one";

beforeEach(() => OneOnOne._wipeForTests());

describe("one_on_one store", async () => {
  it("lock then find returns the row", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    const row = await OneOnOne.find("C1", "1.0");
    expect(row?.locked_user).toBe("U_A");
    expect(row?.created_by).toBe("U_A");
    expect(typeof row?.created_at).toBe("number");
  });
  it("find returns null when no lock", async () => {
    expect(await OneOnOne.find("C1", "nope")).toBeNull();
  });
  it("lock upserts — re-locking the same thread replaces the locked_user", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_B", createdBy: "U_B" });
    expect((await OneOnOne.find("C1", "1.0"))?.locked_user).toBe("U_B");
  });
  it("unlock removes the row", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    await OneOnOne.unlock("C1", "1.0");
    expect(await OneOnOne.find("C1", "1.0")).toBeNull();
  });
  it("locks are scoped per (channel, thread)", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    expect(await OneOnOne.find("C2", "1.0")).toBeNull();
    expect(await OneOnOne.find("C1", "2.0")).toBeNull();
  });
});

describe("one_on_one lock team (slice C task 12)", () => {
  it("lock stores the team and find returns it", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A", teamId: "T0EXAMPLE" });
    expect((await OneOnOne.find("C1", "1.0"))?.team_id).toBe("T0EXAMPLE");
  });
  it("a lock without a team stores NULL (unknown)", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    expect((await OneOnOne.find("C1", "1.0"))?.team_id).toBeNull();
  });
  it("re-locking replaces the team with the new locker's", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A", teamId: "T0EXAMPLE" });
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A", teamId: "T1EXAMPLE" });
    expect((await OneOnOne.find("C1", "1.0"))?.team_id).toBe("T1EXAMPLE");
  });
  it("open and relock keep the team", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A", teamId: "T0EXAMPLE" });
    await OneOnOne.setOpen("C1", "1.0", "scope");
    await OneOnOne.setLocked("C1", "1.0");
    expect((await OneOnOne.find("C1", "1.0"))?.team_id).toBe("T0EXAMPLE");
  });
});

describe("lockOwnership", () => {
  const row = (team: string | null) => ({ locked_user: "U0EXAMPLE", team_id: team });
  it("the same id in the lock's workspace owns it", () => {
    expect(OneOnOne.lockOwnership(row("T0EXAMPLE"), { teamId: "T0EXAMPLE", userId: "U0EXAMPLE" })).toBe("owner");
  });
  it("the same U id in another workspace does not", () => {
    expect(OneOnOne.lockOwnership(row("T0EXAMPLE"), { teamId: "T1EXAMPLE", userId: "U0EXAMPLE" })).toBe("other");
  });
  it("a different id is not the owner", () => {
    expect(OneOnOne.lockOwnership(row("T0EXAMPLE"), { teamId: "T0EXAMPLE", userId: "U0SECOND" })).toBe("other");
  });
  it("a lock with no team is read as the single workspace when there is one, unknown otherwise", () => {
    expect(OneOnOne.lockOwnership(row(null), { teamId: "T0EXAMPLE", userId: "U0EXAMPLE" }, "T0EXAMPLE")).toBe("owner");
    expect(OneOnOne.lockOwnership(row(null), { teamId: "T1EXAMPLE", userId: "U0EXAMPLE" }, "T0EXAMPLE")).toBe("other");
    expect(OneOnOne.lockOwnership(row(null), { teamId: "T0EXAMPLE", userId: "U0EXAMPLE" })).toBe("unknown");
    expect(OneOnOne.lockOwnership(row(null), { teamId: "T0EXAMPLE", userId: "U0SECOND" })).toBe("other");
  });
});
