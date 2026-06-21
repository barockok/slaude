import { describe, it, expect } from "bun:test";
import { writeSoulFixture } from "../../../src/gateway/sim/soul-fixture";
import { soulData } from "../../../src/soul/extract";

describe("soul fixture", () => {
  it("injects structured SoulData the gates read (manager/approvers/trusted/allowed)", () => {
    writeSoulFixture({ manager: "U0MGR", backup: "U0BACKUP", approvers: ["U0APP"], trusted: ["C0TEAM"], allowed: ["C0PUB"] });
    const soul = soulData();
    expect(soul.manager.userId).toBe("U0MGR");
    expect(soul.backupManager.userId).toBe("U0BACKUP");
    expect(soul.approvers.some((a) => a.userId === "U0APP")).toBe(true);
    expect(soul.trustedChannels).toContain("C0TEAM");
    expect(soul.allowedChannels).toContain("C0PUB");
  });

  it("emits per-channel overrides (mandate + approvers, and a bare channel) into structured data", () => {
    writeSoulFixture({
      manager: "U0MGR", backup: "U0BACKUP", approvers: ["U0APP"], trusted: ["C0TEAM"], allowed: ["C0PUB"],
      channelOverrides: [
        { channel: "C0ENG", mandate: "Ship backend fixes.", approvers: ["U0DBA"] },
        { channel: "C0OPS" }, // no mandate, no approvers → exercises the empty sub-branches
      ],
    });
    const soul = soulData();
    expect(soul.channelOverrides).toHaveLength(2);
    const eng = soul.channelOverrides.find((c) => c.channel === "C0ENG")!;
    expect(eng.mandate).toBe("Ship backend fixes.");
    expect(eng.approvers.map((a) => a.userId)).toContain("U0DBA");
    const ops = soul.channelOverrides.find((c) => c.channel === "C0OPS")!;
    expect(ops.approvers).toHaveLength(0);
  });
});
