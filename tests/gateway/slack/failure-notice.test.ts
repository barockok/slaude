import { describe, expect, it } from "bun:test";
import { notifyTurnFailure } from "../../../src/gateway/slack/failure-notice";

const fake = (over: { eph?: boolean; dm?: boolean } = {}) => {
  const calls: Array<{ m: string; a: any }> = [];
  return {
    calls,
    client: {
      chat: {
        postEphemeral: async (a: any) => {
          calls.push({ m: "eph", a });
          if (over.eph) throw new Error("x");
          return { ok: true };
        },
        postMessage: async (a: any) => {
          calls.push({ m: "post", a });
          if (over.dm) throw new Error("x");
          return { ok: true };
        },
      },
    } as any,
  };
};

describe("notifyTurnFailure", () => {
  it("tells the user whose turn it was, privately, in their thread", async () => {
    const f = fake();
    expect(await notifyTurnFailure(f.client, { userId: "U1", managerId: "UM", channel: "C1", thread: "1.1", text: "failed" })).toBe("user");
    expect(f.calls).toEqual([{ m: "eph", a: { channel: "C1", user: "U1", thread_ts: "1.1", text: "failed" } }]);
  });

  it("with no user, tells the agent's manager by DM and says which channel", async () => {
    const f = fake();
    expect(await notifyTurnFailure(f.client, { managerId: "UM", channel: "C1", thread: "1.1", text: "failed" })).toBe("manager");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.m).toBe("post");
    expect(f.calls[0]!.a.channel).toBe("UM");
    expect(f.calls[0]!.a.text).toContain("failed");
    expect(f.calls[0]!.a.text).toContain("<#C1>");
  });

  it("with no user and no manager, posts nothing anywhere", async () => {
    const f = fake();
    expect(await notifyTurnFailure(f.client, { channel: "C1", thread: "1.1", text: "failed" })).toBe("none");
    expect(f.calls).toEqual([]);
  });

  it("never falls back to the channel when delivery fails", async () => {
    const f = fake({ eph: true, dm: true });
    await notifyTurnFailure(f.client, { userId: "U1", channel: "C1", thread: "1.1", text: "failed" });
    await notifyTurnFailure(f.client, { managerId: "UM", channel: "C1", thread: "1.1", text: "failed" });
    expect(f.calls.some((c) => c.m === "post" && c.a.channel === "C1")).toBe(false);
  });
});
