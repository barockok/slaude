import { describe, it, expect } from "bun:test";
import { utils } from "ssh2";
import { generateSshKeyPair, isValidSshKeyPair } from "../../src/remote/keygen";

const real = (c: string) => utils.generateKeyPairSync("ed25519", { comment: c });
// A pair known to parse: ssh2 emits an unparseable key ~1/256, which would make
// a call-count assertion flaky.
const valid = (c: string) => {
  for (;;) {
    const p = real(c);
    if (isValidSshKeyPair(p.private, p.public)) return p;
  }
};
const garbage = () => ({ private: "not a key", public: "ssh-ed25519 AAAA" });

describe("generateSshKeyPair", () => {
  it("retries past invalid results and returns the first valid pair", () => {
    let calls = 0;
    const pair = generateSshKeyPair("slaude:U1", (c) => (++calls <= 5 ? garbage() : valid(c)));
    expect(calls).toBe(6);
    expect(isValidSshKeyPair(pair.privateKey, pair.publicKey)).toBe(true);
    expect(pair.publicKey).toContain("slaude:U1");
  });

  it("throws after 8 invalid results", () => {
    let calls = 0;
    expect(() => generateSshKeyPair("x", () => (calls++, garbage()))).toThrow("could not generate a valid ssh key");
    expect(calls).toBe(8);
  });

  it("rejects a pair whose halves describe different keys", () => {
    const a = real("a");
    const b = real("b");
    expect(isValidSshKeyPair(a.private, b.public)).toBe(false);
  });

  it("every key from the real generator parses (ssh2 drops a leading zero ~1/256)", () => {
    for (let i = 0; i < 300; i++) {
      const p = generateSshKeyPair(`k${i}`);
      const priv = utils.parseKey(p.privateKey);
      const pub = utils.parseKey(p.publicKey);
      expect(priv instanceof Error).toBe(false);
      expect(pub instanceof Error).toBe(false);
    }
  });
});
