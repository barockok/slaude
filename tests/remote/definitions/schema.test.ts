import { describe, expect, test } from "bun:test";
import { parseEnvironmentYaml } from "../../../src/remote/definitions/parse";
import { PayloadError } from "../../../src/persona/sync/payload";

const FP = "SHA256:" + "A".repeat(43);
const base = (over: { top?: string; ssh?: string; host?: string } = {}) => `name: team-sandbox
description: Shared build box.
kind: ssh
shared: true
trust: unlocked
defaultDir: /srv/work
${over.top ?? ""}
ssh:
  host: ${over.host ?? "build-box.example.com"}
  user: dev
  port: 22
  hostKey: "${FP}"
${over.ssh ?? ""}
`;

function refusal(text: string, file = "team-sandbox"): string {
  try {
    parseEnvironmentYaml(file, text);
  } catch (e) {
    expect(e).toBeInstanceOf(PayloadError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("environment definition parser", () => {
  test("a valid ssh definition", () => {
    const d = parseEnvironmentYaml("team-sandbox", base());
    expect(d.name).toBe("team-sandbox");
    expect(d.kind).toBe("ssh");
    expect(d.defaultDir).toBe("/srv/work");
    expect(d.config).toEqual({ host: "build-box.example.com", user: "dev", port: "22", hostKey: FP, shared: "true", trust: "unlocked" });
    expect(d.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the hash ignores key order and changes with content", () => {
    const a = parseEnvironmentYaml("team-sandbox", base());
    const reordered = `ssh:\n  hostKey: "${FP}"\n  port: 22\n  user: dev\n  host: build-box.example.com\ndefaultDir: /srv/work\ntrust: unlocked\nshared: true\nkind: ssh\ndescription: Shared build box.\nname: team-sandbox\n`;
    expect(parseEnvironmentYaml("team-sandbox", reordered).hash).toBe(a.hash);
    expect(parseEnvironmentYaml("team-sandbox", base({ host: "other.example.com" })).hash).not.toBe(a.hash);
  });

  test("unknown keys are refused without their value", () => {
    const top = refusal(base({ top: "colour: SECRETVALUE123" }));
    expect(top).toContain("colour");
    expect(top).not.toContain("SECRETVALUE123");
    const nested = refusal(base({ ssh: "  proxy: SECRETVALUE123" }));
    expect(nested).toContain("ssh.proxy");
    expect(nested).not.toContain("SECRETVALUE123");
  });

  test("the name equals the file and matches the pattern", () => {
    expect(refusal(base(), "other-name")).toContain("must equal the file name");
    expect(refusal(base().replace("name: team-sandbox", "name: Team_Sandbox"), "Team_Sandbox")).toContain("name must match");
    const long = "a".repeat(42);
    expect(refusal(base().replace("name: team-sandbox", `name: ${long}`), long)).toContain("name must match");
    const ok = "a".repeat(41);
    expect(parseEnvironmentYaml(ok, base().replace("name: team-sandbox", `name: ${ok}`)).name).toBe(ok);
  });

  test("shared and trust are required and must say so", () => {
    expect(refusal(base().replace("shared: true\n", ""))).toContain("shared must be true");
    expect(refusal(base().replace("trust: unlocked\n", ""))).toContain('trust must be "unlocked"');
    expect(refusal(base().replace("shared: true", "shared: false"))).toContain("shared must be true");
    expect(refusal(base().replace("trust: unlocked", "trust: locked"))).toContain("unlocked");
  });

  test("tailcat and provisioned are refused with the stated message and no value", () => {
    for (const kind of ["tailcat", "provisioned"]) {
      const m = refusal(`name: team-sandbox\nkind: ${kind}\naddr: 100.64.0.9\n`);
      expect(m).toContain(`${kind} is not supported for shared environments yet`);
      expect(m).not.toContain("100.64.0.9");
    }
    expect(refusal(base().replace("kind: ssh", "kind: docker"))).toContain("kind must be ssh");
  });

  test("a key named like a secret gets the dedicated refusal", () => {
    for (const k of ["privateKey", "password", "token", "secret", "apiKey", "passphrase"]) {
      const m = refusal(base({ ssh: `  ${k}: hunter2` }));
      expect(m).toContain("looks like a secret");
      expect(m).toContain("slaude generates the key pair");
      expect(m).not.toContain("hunter2");
    }
    expect(refusal(base({ top: "password: hunter2" }))).toContain("looks like a secret");
  });

  test("a token or PEM shaped value is refused and not echoed", () => {
    const tok = "gh" + "p_" + "a1".repeat(18);
    const m = refusal(base().replace("Shared build box.", tok));
    expect(m).toContain("looks like a token or private key");
    expect(m).not.toContain(tok);
    const pem = refusal(base({ ssh: `  user: "-----BEGIN OPENSSH PRIV${"ATE"} KEY-----"` }).replace("  user: dev\n", ""));
    expect(pem).toContain("looks like a token or private key");
    expect(refusal(base().replace("/srv/work", "xo" + "xb-123-abc"))).toContain("looks like a token");
  });

  test("honest long text is not mistaken for a credential, real token shapes still are", () => {
    const longLabel = "build-" + "x".repeat(40) + "-node.example.com";
    const ok = parseEnvironmentYaml("team-sandbox", base({ host: longLabel }).replace("/srv/work", "/srv/9f1c2b7e-3d4a-4e5f-8a6b-7c8d9e0f1a2b/work").replace("Shared build box.", "Uses bearer authentication, set by the platform team."));
    expect(ok.config.host).toBe(longLabel);
    expect(ok.defaultDir).toContain("9f1c2b7e-3d4a");
    const secrets = [
      "gh" + "p_" + "a1".repeat(18),
      "sk" + "-" + "Ab3".repeat(10),
      "AK" + "IA" + "ABCDEFGHIJKLMNOP",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
      "Bearer " + "abcdef0123456789abcdef",
      "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
    ];
    for (const v of secrets) {
      const m = refusal(base().replace("Shared build box.", v));
      expect(m).toContain("looks like a token or private key");
      expect(m).not.toContain(v);
    }
  });

  test("hostKey is required and must be a fingerprint", () => {
    const m = refusal(base().replace(`  hostKey: "${FP}"\n`, ""));
    expect(m).toContain("ssh.hostKey is required");
    expect(refusal(base().replace(FP, "SHA256:short"))).toContain("ssh.hostKey");
  });

  test("address literals are refused unless allowPrivateAddress", () => {
    const cases: Array<[string, string]> = [
      ["127.0.0.1", "loopback"],
      ["10.1.2.3", "private"],
      ["192.168.0.5", "private"],
      ["169.254.169.254", "link-local"],
      ["169.254.1.1", "link-local"],
      ["::1", "loopback"],
      ["fe80::1", "link-local"],
      ["localhost", "loopback"],
      ["2130706433", "numeric"],
    ];
    for (const [host, word] of cases) {
      const m = refusal(base({ host: `"${host}"` }));
      expect(m).toContain("ssh.host");
      expect(m).toContain(word);
      expect(m).not.toContain(host.replace(/\./g, "\\."));
      expect(m).not.toContain(`'${host}'`);
      const ok = parseEnvironmentYaml("team-sandbox", base({ host: `"${host}"`, ssh: "  allowPrivateAddress: true" }));
      expect(ok.config.allowPrivateAddress).toBe("true");
    }
    // A public literal is fine.
    expect(parseEnvironmentYaml("team-sandbox", base({ host: "8.8.8.8" })).config.host).toBe("8.8.8.8");
  });

  test("invalid YAML and non-mappings are refused without the source line", () => {
    expect(refusal("name: [unclosed\nSECRETLINE")).not.toContain("SECRETLINE");
    expect(refusal("- a\n- b\n")).toContain("must be a mapping");
  });

  test("port must be a number in range", () => {
    expect(refusal(base().replace("port: 22", "port: 70000"))).toContain("ssh.port");
    expect(refusal(base().replace("port: 22", "port: abc"))).toContain("ssh.port");
  });
});
