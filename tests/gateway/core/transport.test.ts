import { describe, it, expect } from "bun:test";
import type { Transport, WebClientLike } from "../../../src/gateway/core/transport";

describe("Transport port", () => {
  it("a minimal in-memory object satisfies the Transport shape", () => {
    const t: Transport = {
      client: {} as WebClientLike,
      action: () => {},
      event: () => {},
      use: () => {},
      start: async () => {},
      stop: async () => {},
    };
    expect(typeof t.action).toBe("function");
    expect(typeof t.start).toBe("function");
  });
});
