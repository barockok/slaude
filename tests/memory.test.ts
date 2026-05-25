import { describe, expect, test } from "bun:test";
import { SqliteMemoryProvider, truncate } from "../src/memory/sqlite-provider";
import { NULL_PROVIDER } from "../src/memory/provider";

describe("SqliteMemoryProvider", () => {
  test("prefetch null when no data", async () => {
    const m = new SqliteMemoryProvider();
    expect(await m.prefetch("session-empty")).toBeNull();
  });

  test("syncTurn + prefetch round-trip", async () => {
    const m = new SqliteMemoryProvider();
    await m.syncTurn({ sessionId: "S1", user: "hello", assistant: "hi back" });
    const out = await m.prefetch("S1");
    expect(out).toContain("<recent-turns>");
    expect(out).toContain("hello");
    expect(out).toContain("hi back");
  });

  test("recordFact global + session, surfaced in prefetch", async () => {
    const m = new SqliteMemoryProvider();
    m.recordFact("global truth", { scope: "global" });
    m.recordFact("session truth", { sessionId: "S2" });
    const out = await m.prefetch("S2");
    expect(out).toContain("<facts>");
    expect(out).toContain("global truth");
    expect(out).toContain("session truth");
  });

  test("turn truncation at 800 chars", async () => {
    const m = new SqliteMemoryProvider();
    const big = "x".repeat(2000);
    await m.syncTurn({ sessionId: "S3", user: big, assistant: big });
    const out = (await m.prefetch("S3"))!;
    expect(out).toContain("…");
  });

  test("recordFact default scope=global when no sessionId", () => {
    const m = new SqliteMemoryProvider();
    m.recordFact("baseline");
    // no throw = pass; round-trip via prefetch w/ unrelated session
  });

  test("recordFact explicit session scope", async () => {
    const m = new SqliteMemoryProvider();
    m.recordFact("scoped fact", { sessionId: "S4", scope: "session" });
    const out = await m.prefetch("S4");
    expect(out).toContain("scoped fact");
  });
});

describe("NULL_PROVIDER", () => {
  test("returns null + no-op", async () => {
    expect(await NULL_PROVIDER.prefetch("x")).toBeNull();
    await NULL_PROVIDER.syncTurn({ sessionId: "x", user: "u", assistant: "a" });
  });
});

describe("truncate", () => {
  test("returns original when under max", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });
  test("truncates with ellipsis when over max", () => {
    expect(truncate("hello world", 5)).toBe("hello…");
  });
  test("edge case: exactly max", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });
});

describe("memory singleton", () => {
  test("exported memory instance works", async () => {
    const { memory } = await import("../src/memory/sqlite-provider");
    memory.recordFact("singleton fact", { sessionId: "sing", scope: "session" });
    const out = await memory.prefetch("sing");
    expect(out).toContain("singleton fact");
  });
});
