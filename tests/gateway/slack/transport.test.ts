import { describe, it, expect } from "bun:test";

describe("slack transport binding", () => {
  it("exposes createSlackTransport without constructing bolt (smoke import)", async () => {
    const mod = await import("../../../src/gateway/slack/transport");
    expect(typeof mod.createSlackTransport).toBe("function");
  });
});
