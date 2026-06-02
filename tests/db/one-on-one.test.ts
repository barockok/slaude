import { describe, it, expect, beforeEach } from "bun:test";
import * as OneOnOne from "../../src/db/one-on-one";

beforeEach(() => OneOnOne._wipeForTests());

describe("one_on_one store", () => {
  it("lock then find returns the row", () => {
    OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    const row = OneOnOne.find("C1", "1.0");
    expect(row?.locked_user).toBe("U_A");
    expect(row?.created_by).toBe("U_A");
    expect(typeof row?.created_at).toBe("number");
  });
  it("find returns null when no lock", () => {
    expect(OneOnOne.find("C1", "nope")).toBeNull();
  });
  it("lock upserts — re-locking the same thread replaces the locked_user", () => {
    OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_B", createdBy: "U_B" });
    expect(OneOnOne.find("C1", "1.0")?.locked_user).toBe("U_B");
  });
  it("unlock removes the row", () => {
    OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    OneOnOne.unlock("C1", "1.0");
    expect(OneOnOne.find("C1", "1.0")).toBeNull();
  });
  it("locks are scoped per (channel, thread)", () => {
    OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    expect(OneOnOne.find("C2", "1.0")).toBeNull();
    expect(OneOnOne.find("C1", "2.0")).toBeNull();
  });
});
