import { describe, expect, it } from "bun:test";
import { makePrivateSender } from "../../../src/gateway/slack/private";

const fake = (over: { eph?: () => Promise<unknown>; dm?: () => Promise<unknown> } = {}) => {
  const calls: Array<{ m: string; a: any }> = [];
  return {
    calls,
    client: {
      chat: {
        postEphemeral: async (a: any) => {
          calls.push({ m: "eph", a });
          return (over.eph ?? (async () => ({ ok: true })))();
        },
        postMessage: async (a: any) => {
          calls.push({ m: "post", a });
          return (over.dm ?? (async () => ({ ok: true })))();
        },
      },
    } as any,
  };
};
const refused = async () => {
  throw Object.assign(new Error("x"), { data: { error: "user_not_in_channel" } });
};
const base = { cls: "info" as const, kind: "help", userId: "U1", channel: "C1", thread: "1.1", text: "hi" };

describe("sendPrivate", () => {
  it("sends an ephemeral to the user in the thread", async () => {
    const f = fake();
    expect(await makePrivateSender().send(f.client, base)).toBe("ephemeral");
    expect(f.calls).toEqual([{ m: "eph", a: { channel: "C1", user: "U1", thread_ts: "1.1", text: "hi" } }]);
  });

  it("falls back to a DM when the ephemeral is refused, never to the channel", async () => {
    const f = fake({ eph: refused });
    expect(await makePrivateSender().send(f.client, base)).toBe("dm");
    expect(f.calls.map((c) => c.m)).toEqual(["eph", "post"]);
    expect(f.calls[1]!.a.channel).toBe("U1");
  });

  it("drops when both fail, and posts nothing public", async () => {
    const boom = async () => {
      throw new Error("x");
    };
    const f = fake({ eph: boom, dm: boom });
    expect(await makePrivateSender().send(f.client, base)).toBe("dropped");
    expect(f.calls.some((c) => c.a.channel === "C1" && c.m === "post")).toBe(false);
  });

  it("sensitive goes straight to a DM", async () => {
    const f = fake();
    expect(await makePrivateSender().send(f.client, { ...base, cls: "sensitive" })).toBe("dm");
    expect(f.calls.map((c) => c.m)).toEqual(["post"]);
  });

  it("limits an unsolicited notice and spends the token only after delivery", async () => {
    let t = 0;
    const s = makePrivateSender({ now: () => t, windowMs: () => 600_000 });
    const n = { ...base, limitKey: "p:C1:1.1:U1:ignored" };
    const boom = async () => {
      throw new Error("x");
    };
    expect(await s.send(fake({ eph: boom, dm: boom }).client, n)).toBe("dropped");
    const ok = fake();
    expect(await s.send(ok.client, n)).toBe("ephemeral");
    expect(await s.send(ok.client, n)).toBe("limited");
    t = 600_001;
    expect(await s.send(ok.client, n)).toBe("ephemeral");
  });

  it("never limits a notice without a limit key", async () => {
    const s = makePrivateSender();
    const f = fake();
    await s.send(f.client, base);
    await s.send(f.client, base);
    expect(f.calls.length).toBe(2);
  });

  it("with the switch off, runs the public fallback instead of anything private", async () => {
    const f = fake();
    let ran = false;
    const r = await makePrivateSender({ enabled: () => false }).send(f.client, {
      ...base,
      publicFallback: async () => {
        ran = true;
      },
    });
    expect(r).toBe("disabled");
    expect(ran).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it("adds a permalink to a DM so it has context", async () => {
    const f = fake({ eph: refused });
    await makePrivateSender().send(f.client, { ...base, permalink: "https://example.test/p/1" });
    expect(f.calls[1]!.a.text).toContain("https://example.test/p/1");
  });

  it("does not add a thread to an ephemeral when none is given", async () => {
    const f = fake();
    await makePrivateSender().send(f.client, { ...base, thread: undefined });
    expect("thread_ts" in f.calls[0]!.a).toBe(false);
  });

  it("reports where a DM landed so it can be edited later", async () => {
    const seen: any[] = [];
    const f = fake({ eph: refused, dm: async () => ({ ok: true, channel: "D9", ts: "5.5" }) });
    await makePrivateSender().send(f.client, { ...base, onDelivered: (d) => seen.push(d) });
    expect(seen).toEqual([{ path: "dm", channel: "D9", ts: "5.5" }]);
  });

  it("a throwing onDelivered does not undo a delivery", async () => {
    const f = fake();
    const r = await makePrivateSender().send(f.client, { ...base, onDelivered: () => { throw new Error("x"); } });
    expect(r).toBe("ephemeral");
  });
});
