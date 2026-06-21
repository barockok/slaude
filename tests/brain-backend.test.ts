import { afterEach, describe, expect, test } from "bun:test";
import {
  LocalBackend,
  getBackend,
  registerRemoteBackend,
  resetBackend,
  type BrainBackend,
} from "../src/knowledge/backend";

afterEach(() => {
  resetBackend();
  delete process.env.SLAUDE_BRAIN_MODE;
  delete process.env.SLAUDE_BRAIN_URL;
});

describe("getBackend selection", () => {
  test("defaults to LocalBackend", () => {
    expect(getBackend()).toBeInstanceOf(LocalBackend);
  });

  test("remote mode uses the registered remote factory with the configured url", () => {
    let seenUrl: string | undefined;
    const fake: BrainBackend = { call: async () => "c", adminCall: async () => "a" };
    registerRemoteBackend((url) => {
      seenUrl = url;
      return fake;
    });
    process.env.SLAUDE_BRAIN_MODE = "remote";
    process.env.SLAUDE_BRAIN_URL = "https://brain.example/mcp";
    resetBackend();
    expect(getBackend()).toBe(fake);
    expect(seenUrl).toBe("https://brain.example/mcp");
  });

  test("backend is cached across calls", () => {
    const first = getBackend();
    expect(getBackend()).toBe(first);
  });
});
