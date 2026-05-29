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
});
