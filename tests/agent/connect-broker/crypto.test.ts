import { describe, it, expect } from "bun:test";
import { encryptCred, decryptCred } from "../../../src/agent/connect-broker/crypto";

const KEY = Buffer.alloc(32, 9);

describe("cred crypto", () => {
  it("round-trips a credential blob", () => {
    const blob = JSON.stringify({ token: "abc123", refresh: "xyz" });
    const ct = encryptCred(KEY, "conn-1", blob);
    expect(typeof ct).toBe("string");
    expect(ct).not.toContain("abc123");
    const pt = decryptCred(KEY, "conn-1", ct);
    expect(pt).toBe(blob);
  });

  it("uses a unique nonce each call (no reuse)", () => {
    const a = encryptCred(KEY, "c", "same");
    const b = encryptCred(KEY, "c", "same");
    expect(a).not.toBe(b); // random 96-bit nonce => different ciphertext
  });

  it("rejects a tampered ciphertext", () => {
    const ct = encryptCred(KEY, "c", "secret");
    const buf = Buffer.from(ct, "base64");
    buf[buf.length - 1] ^= 0xff; // flip a tag bit
    expect(() => decryptCred(KEY, "c", buf.toString("base64"))).toThrow();
  });

  it("rejects decryption under a mismatched AAD (connection id)", () => {
    const ct = encryptCred(KEY, "conn-A", "secret");
    expect(() => decryptCred(KEY, "conn-B", ct)).toThrow();
  });
});
