import { describe, it, expect } from "bun:test";
import { LAYERS, ROLE_NAMES, findLayer, resolveRole } from "../../../src/gateway/sim/roles";

const soul = {
  manager: { userId: "U0MGR" },
  backupManager: { userId: "U0BACKUP" },
  approvers: [{ userId: "U0APP" }],
} as any;

describe("LAYERS", () => {
  it("covers dm + the three channel zones", () => {
    expect(LAYERS.map((l) => l.name).sort()).toEqual(["allowed", "dm", "restricted", "trusted"]);
  });
  it("dm is a DM, channels are not", () => {
    expect(findLayer("dm")!.dm).toBe(true);
    expect(findLayer("trusted")!.dm).toBe(false);
    expect(findLayer("trusted")!.channel).toBe("C0TEAM");
    expect(findLayer("allowed")!.channel).toBe("C0PUB");
  });
  it("findLayer is undefined for unknown names", () => {
    expect(findLayer("nope")).toBeUndefined();
  });
});

describe("resolveRole", () => {
  it("maps soul-derived roles to user ids", () => {
    expect(resolveRole("manager", soul)).toBe("U0MGR");
    expect(resolveRole("approver", soul)).toBe("U0APP");
    expect(resolveRole("backup", soul)).toBe("U0BACKUP");
  });
  it("member and outsider are fixed synthetic users (not in the soul gates)", () => {
    expect(resolveRole("member", soul)).toBe("U0ALICE");
    expect(resolveRole("outsider", soul)).toBe("U0BOB");
  });
  it("returns undefined for an unknown role", () => {
    expect(resolveRole("ceo", soul)).toBeUndefined();
  });
  it("returns undefined when the soul lacks that role", () => {
    expect(resolveRole("approver", { approvers: [] } as any)).toBeUndefined();
    expect(resolveRole("manager", {} as any)).toBeUndefined();
  });
  it("ROLE_NAMES lists every selectable role", () => {
    expect(ROLE_NAMES).toEqual(["manager", "approver", "backup", "member", "outsider"]);
  });
});
