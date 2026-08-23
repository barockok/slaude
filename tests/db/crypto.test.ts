import { describe, expect, test, beforeEach } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  encrypt,
  decrypt,
  isEncrypted,
  masterKey,
  MasterKeyError,
  __resetMasterKeyCache,
} from "../../src/db/crypto";

const KEY = randomBytes(32);

describe("db/crypto", () => {
  beforeEach(() => __resetMasterKeyCache());

  test("round-trips utf8 text", () => {
    const ct = encrypt("token-placeholder ünïcödé 🙂", KEY);
    expect(isEncrypted(ct)).toBe(true);
    expect(ct.startsWith("v1:")).toBe(true);
    expect(decrypt(ct, KEY)).toBe("token-placeholder ünïcödé 🙂");
  });

  test("fresh iv per call: same plaintext never yields same ciphertext", () => {
    expect(encrypt("same", KEY)).not.toBe(encrypt("same", KEY));
  });

  test("wrong key fails authentication", () => {
    const ct = encrypt("secret", KEY);
    expect(() => decrypt(ct, randomBytes(32))).toThrow();
  });

  test("tampered ciphertext fails authentication", () => {
    const ct = encrypt("secret", KEY);
    const [v, iv, tag, body] = ct.split(":") as [string, string, string, string];
    const flipped = Buffer.from(body, "base64");
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => decrypt([v, iv, tag, flipped.toString("base64")].join(":"), KEY)).toThrow();
  });

  test("rejects unknown envelope versions", () => {
    expect(() => decrypt("v9:a:b:c", KEY)).toThrow(/envelope/);
    expect(() => decrypt("plain-text", KEY)).toThrow(/envelope/);
    expect(isEncrypted("plain-text")).toBe(false);
  });

  test("masterKey reads SLAUDE_MASTER_KEY and validates length", () => {
    expect(() => masterKey({})).toThrow(MasterKeyError);
    expect(() => masterKey({ SLAUDE_MASTER_KEY: Buffer.from("short").toString("base64") })).toThrow(/32 bytes/);
    const good = randomBytes(32).toString("base64");
    expect(masterKey({ SLAUDE_MASTER_KEY: good }).equals(Buffer.from(good, "base64"))).toBe(true);
    // cached: a different env on the next call is ignored until reset
    expect(masterKey({})).toEqual(Buffer.from(good, "base64"));
    __resetMasterKeyCache();
    expect(() => masterKey({})).toThrow(MasterKeyError);
  });

  test("default key path uses process.env", () => {
    const prev = process.env.SLAUDE_MASTER_KEY;
    process.env.SLAUDE_MASTER_KEY = randomBytes(32).toString("base64");
    try {
      expect(decrypt(encrypt("via env"))).toBe("via env");
    } finally {
      if (prev === undefined) delete process.env.SLAUDE_MASTER_KEY;
      else process.env.SLAUDE_MASTER_KEY = prev;
      __resetMasterKeyCache();
    }
  });
});
