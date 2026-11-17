import { afterEach, describe, expect, test } from "bun:test";
import { SoulDataSchema } from "../../src/soul/data";
import { __resetSoulDataMemo, channelMandate, effectiveSoulForChannel, setSoulData, soulData, soulDataBase } from "../../src/soul/extract";

afterEach(() => {
  __resetSoulDataMemo();
});

describe("soulData: the installed default structure", () => {
  test("returns the data installed with setSoulData", () => {
    setSoulData(SoulDataSchema.parse({ approvers: [{ userId: "U0XXXXXXXXX", scope: "anything", catchall: true }] }));
    expect(soulData().approvers).toHaveLength(1);
  });

  test("installed data wins and carries its identity", () => {
    setSoulData(SoulDataSchema.parse({ approvers: [], identity: { name: "memo" } }));
    expect(soulData().identity.name).toBe("memo");
  });

  test("nothing installed: empty, so nobody is admitted and nobody may approve", () => {
    __resetSoulDataMemo();
    const d = soulDataBase();
    expect(d.approvers).toEqual([]);
    expect(d.manager.userId).toBeUndefined();
    expect(d.trustedChannels).toEqual([]);
  });
});

describe("effectiveSoulForChannel — resolution", () => {
  function seed(overrides: any[], extra: Partial<any> = {}) {
    setSoulData(SoulDataSchema.parse({
      manager: { userId: "U0MGR00001" },
      backupManager: { userId: "U0BACKUP01" },
      mandate: "Global mandate.",
      approvers: [{ userId: "U0GLOBAL01", scope: "anything", catchall: true }],
      channelOverrides: overrides,
      ...extra,
    }));
  }

  test("no channelId → global view unchanged", () => {
    seed([{ channel: "C0CHAN0001", mandate: "Chan mandate.", approvers: [] }]);
    const d = effectiveSoulForChannel(undefined);
    expect(d.mandate).toBe("Global mandate.");
    expect(d.approvers.map((a) => a.userId)).toEqual(["U0GLOBAL01"]);
  });

  test("unknown channel → global view unchanged", () => {
    seed([{ channel: "C0CHAN0001", mandate: "Chan mandate.", approvers: [] }]);
    const d = effectiveSoulForChannel("C0OTHER999");
    expect(d.mandate).toBe("Global mandate.");
  });

  test("matching channel replaces mandate", () => {
    seed([{ channel: "C0CHAN0001", mandate: "Chan mandate.", approvers: [] }]);
    const d = effectiveSoulForChannel("C0CHAN0001");
    expect(d.mandate).toBe("Chan mandate.");
    // approvers empty in override → keep global
    expect(d.approvers.map((a) => a.userId)).toEqual(["U0GLOBAL01"]);
  });

  test("empty mandate in override → keeps global mandate", () => {
    seed([{ channel: "C0CHAN0001", approvers: [{ userId: "U0CHANAPP1", scope: "x", catchall: false }] }]);
    const d = effectiveSoulForChannel("C0CHAN0001");
    expect(d.mandate).toBe("Global mandate.");
  });

  test("matching channel replaces approvers AND always retains manager + backup", () => {
    seed([{ channel: "C0CHAN0001", approvers: [{ userId: "U0CHANAPP1", scope: "deploys", catchall: false }] }]);
    const d = effectiveSoulForChannel("C0CHAN0001");
    const ids = d.approvers.map((a) => a.userId);
    expect(ids).toContain("U0CHANAPP1");
    expect(ids).toContain("U0MGR00001");   // manager auto-injected
    expect(ids).toContain("U0BACKUP01");   // backup auto-injected
    expect(ids).not.toContain("U0GLOBAL01"); // global approver replaced
    // manager/backup injected as catchall
    expect(d.approvers.find((a) => a.userId === "U0MGR00001")!.catchall).toBe(true);
  });

  test("manager already listed in channel approvers is not duplicated", () => {
    seed([{ channel: "C0CHAN0001", approvers: [{ userId: "U0MGR00001", scope: "anything", catchall: true }] }]);
    const d = effectiveSoulForChannel("C0CHAN0001");
    expect(d.approvers.filter((a) => a.userId === "U0MGR00001")).toHaveLength(1);
  });

  test("malformed channelOverride entry → falls back to global view, never throws", () => {
    // setSoulData bypasses schema validation; a null override entry makes the
    // resolver's `.find()` throw. The catch must return the global view so a
    // corrupt cache can never take the approval gate down.
    const base = SoulDataSchema.parse({
      manager: { userId: "U0MGR00001" },
      approvers: [{ userId: "U0GLOBAL01", scope: "anything", catchall: true }],
    });
    setSoulData({ ...base, channelOverrides: [null as any] });
    expect(() => effectiveSoulForChannel("C0CHAN0001")).not.toThrow();
    const d = effectiveSoulForChannel("C0CHAN0001");
    expect(d.approvers.map((a) => a.userId)).toContain("U0GLOBAL01");
  });
});

describe("channelMandate", () => {
  test("a block's own mandate, else null", () => {
    const soul = SoulDataSchema.parse({
      mandate: "global",
      channelOverrides: [
        { channel: "C0A", mandate: "  for A  ", approvers: [] },
        { channel: "C0B", approvers: [] },
      ],
    });
    expect(channelMandate(soul, "C0A")).toBe("for A");
    expect(channelMandate(soul, "C0B")).toBeNull();
    expect(channelMandate(soul, "C0NONE")).toBeNull();
  });
});
