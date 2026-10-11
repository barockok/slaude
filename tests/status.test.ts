import { describe, expect, test } from "bun:test";
import { Status } from "../src/gateway/slack/status";

function fake(throwOn?: (call: any) => any) {
  const calls: any[] = [];
  const c: any = {
    assistant: {
      threads: {
        setStatus: async (args: any) => {
          calls.push(args);
          if (throwOn) {
            const e = throwOn(args);
            if (e) throw e;
          }
        },
      },
    },
  };
  return { client: c, calls };
}

describe("Status", () => {
  test("set + clear roundtrip", async () => {
    const f = fake();
    const s = new Status(f.client);
    await s.set("S", "C", "T", "thinking");
    await s.clear("S");
    expect(f.calls.length).toBe(2);
    expect(f.calls[0].status).toBe("thinking");
    expect(f.calls[1].status).toBe("");
  });

  test("clear without prior set is no-op", async () => {
    const f = fake();
    const s = new Status(f.client);
    await s.clear("nope");
    expect(f.calls.length).toBe(0);
  });

  test("missing_scope auto-disables", async () => {
    const err: any = new Error("x");
    err.data = { error: "missing_scope" };
    const f = fake(() => err);
    const s = new Status(f.client);
    await s.set("S", "C", "T", "x");
    await s.set("S", "C", "T", "y"); // disabled
    expect(f.calls.length).toBe(1);
  });

  // D1.2: each session's status goes out as that session's app.
  test("a per-session resolver picks the client for each set and clear", async () => {
    const a = fake();
    const b = fake();
    const s = new Status((sid: string) => (sid === "SB" ? b.client : a.client));
    await s.set("SB", "C", "T", "thinking");
    await s.set("SA", "C", "T2", "thinking");
    await s.clear("SB");
    expect(b.calls.map((c) => c.status)).toEqual(["thinking", ""]);
    expect(a.calls.map((c) => c.status)).toEqual(["thinking"]);
  });

  test("a resolver that throws is a failed set, not an unhandled rejection", async () => {
    const s = new Status(() => {
      throw new Error("no registered Slack app");
    });
    await s.set("S", "C", "T", "x");
    await s.clear("S");
  });

  test("clear swallows error", async () => {
    const f = fake((args) => (args.status === "" ? new Error("boom") : null));
    const s = new Status(f.client);
    await s.set("S", "C", "T", "x");
    await s.clear("S"); // would throw — should be swallowed
  });
});
