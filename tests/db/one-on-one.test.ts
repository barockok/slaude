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

describe("one_on_one named guests", () => {
  const lockIt = () => OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U0OWNER", createdBy: "U0OWNER" });

  it("a fresh lock has no guests", async () => {
    await lockIt();
    expect((await OneOnOne.find("C1", "1.0"))?.guests).toEqual([]);
  });
  it("setGuests stores ids, deduplicated, in order; an empty list stores none", async () => {
    await lockIt();
    await OneOnOne.setGuests("C1", "1.0", ["U0QA", "U0REV", "U0QA"]);
    expect((await OneOnOne.find("C1", "1.0"))?.guests).toEqual(["U0QA", "U0REV"]);
    await OneOnOne.setGuests("C1", "1.0", []);
    expect((await OneOnOne.find("C1", "1.0"))?.guests).toEqual([]);
  });
  it("re-locking, opening and re-locking from open all clear guests", async () => {
    await lockIt();
    await OneOnOne.setGuests("C1", "1.0", ["U0QA"]);
    await lockIt();
    expect((await OneOnOne.find("C1", "1.0"))?.guests).toEqual([]);

    await OneOnOne.setGuests("C1", "1.0", ["U0QA"]);
    await OneOnOne.setOpen("C1", "1.0", "read-only");
    expect((await OneOnOne.find("C1", "1.0"))?.guests).toEqual([]);

    await OneOnOne.setGuests("C1", "1.0", ["U0QA"]);
    await OneOnOne.setLocked("C1", "1.0");
    expect((await OneOnOne.find("C1", "1.0"))?.guests).toEqual([]);
  });
  it("unlock (/1on1 off) drops the guests with the lock", async () => {
    await lockIt();
    await OneOnOne.setGuests("C1", "1.0", ["U0QA"]);
    await OneOnOne.unlock("C1", "1.0");
    await lockIt();
    expect((await OneOnOne.find("C1", "1.0"))?.guests).toEqual([]);
  });
  it("setGuests on an unlocked thread does nothing", async () => {
    await OneOnOne.setGuests("C1", "nope", ["U0QA"]);
    expect(await OneOnOne.find("C1", "nope")).toBeNull();
  });
  it("parseGuests admits only Slack user ids from a JSON array; anything else is none", () => {
    expect(OneOnOne.parseGuests('["U0QA","W0B"]')).toEqual(["U0QA", "W0B"]);
    expect(OneOnOne.parseGuests('["U0QA","<@U0X>",7,"c1"]')).toEqual(["U0QA"]);
    expect(OneOnOne.parseGuests("not json")).toEqual([]);
    expect(OneOnOne.parseGuests('{"a":1}')).toEqual([]);
    expect(OneOnOne.parseGuests(null)).toEqual([]);
  });
});
