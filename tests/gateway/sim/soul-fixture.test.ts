import { describe, it, expect } from "bun:test";
import { writeSoulFixture } from "../../../src/gateway/sim/soul-fixture";
import { loadSoulData } from "../../../src/soul/extract";

describe("soul fixture", () => {
  it("writes a SOUL.md the real loader extracts manager/approvers/trusted/allowed from", async () => {
    writeSoulFixture({ manager: "U_MGR", backup: "U_BACKUP", approvers: ["U_APP"], trusted: ["C_TEAM"], allowed: ["C_PUB"] });
    const soul = await loadSoulData();
    expect(soul.manager.userId).toBe("U_MGR");
    expect(soul.backupManager.userId).toBe("U_BACKUP");
    expect(soul.approvers.some((a) => a.userId === "U_APP")).toBe(true);
    expect(soul.trustedChannels).toContain("C_TEAM");
    expect(soul.allowedChannels).toContain("C_PUB");
  });
});
