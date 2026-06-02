import { describe, it, expect } from "bun:test";
import { loadEncryptionKey } from "../../src/config/env";

describe("loadEncryptionKey", () => {
  it("returns a 32-byte buffer from a base64 env value", () => {
    const raw = Buffer.alloc(32, 7).toString("base64");
    const key = loadEncryptionKey({ SLAUDE_ENCRYPTION_KEY: raw });
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it("throws when the key is missing", () => {
    expect(() => loadEncryptionKey({})).toThrow(/SLAUDE_ENCRYPTION_KEY/);
  });

  it("throws when the decoded key is not 32 bytes", () => {
    const raw = Buffer.alloc(16, 1).toString("base64");
    expect(() => loadEncryptionKey({ SLAUDE_ENCRYPTION_KEY: raw })).toThrow(/32 bytes/);
  });
});
