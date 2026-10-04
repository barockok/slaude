import { describe, expect, test } from "bun:test";
import { isAllowed, parseAllowedPrefixes, requestPathFor, splitMount } from "../../src/secrets/allowlist";
import { assertVaultAllowedInRole, loadVaultConfig, VaultConfigError } from "../../src/secrets/config";
import { SecretResolutionError } from "../../src/secrets/errors";

const MOUNTS = ["secret"];

describe("allowed prefixes", () => {
  const prefixes = parseAllowedPrefixes("secret/slaude/personas/{persona}, secret/slaude/shared/", MOUNTS);

  test("inside a static prefix", () => {
    expect(isAllowed("secret/data/slaude/shared/llm", "a", prefixes)).toBe(true);
  });

  test("exactly the prefix", () => {
    expect(isAllowed("secret/data/slaude/shared", "a", prefixes)).toBe(true);
  });

  test("outside every prefix", () => {
    expect(isAllowed("secret/data/slaude/gateway/master", "a", prefixes)).toBe(false);
    expect(isAllowed("secret/data/other", "a", prefixes)).toBe(false);
  });

  test("prefix boundary: …/shared does not allow …/shared-evil", () => {
    expect(isAllowed("secret/data/slaude/shared-evil/x", "a", prefixes)).toBe(false);
    expect(isAllowed("secret/data/slaude/sharedx", "a", prefixes)).toBe(false);
  });

  test("checked against the FINAL path: the mount's data/ must be there", () => {
    // A path that skips data/ (KV v1 shape, metadata/, or the prefix itself) is not allowed.
    expect(isAllowed("secret/slaude/shared/llm", "a", prefixes)).toBe(false);
    expect(isAllowed("secret/metadata/slaude/shared/llm", "a", prefixes)).toBe(false);
  });

  test("{persona}: own folder passes, a sibling's does not", () => {
    expect(isAllowed("secret/data/slaude/personas/support-bot/llm", "support-bot", prefixes)).toBe(true);
    expect(isAllowed("secret/data/slaude/personas/billing-bot/llm", "support-bot", prefixes)).toBe(false);
    // boundary inside the token too
    expect(isAllowed("secret/data/slaude/personas/support-bot-evil/llm", "support-bot", prefixes)).toBe(false);
  });

  test("{persona} never expands to a name that is not a valid persona name", () => {
    expect(isAllowed("secret/data/slaude/personas/../x", "..", prefixes)).toBe(false);
    expect(isAllowed("secret/data/slaude/personas/a/b/llm", "a/b", prefixes)).toBe(false);
    expect(isAllowed("secret/data/slaude/personas//llm", "", prefixes)).toBe(false);
  });

  test("{persona} must be a whole segment and not part of the mount", () => {
    expect(() => parseAllowedPrefixes("secret/slaude/x-{persona}", MOUNTS)).toThrow(VaultConfigError);
    expect(() => parseAllowedPrefixes("{persona}/slaude", ["{persona}"])).toThrow(VaultConfigError);
  });

  test("a prefix must be under a configured mount and name a path below it", () => {
    expect(() => parseAllowedPrefixes("kv/slaude", MOUNTS)).toThrow(VaultConfigError);
    expect(() => parseAllowedPrefixes("secret", MOUNTS)).toThrow(VaultConfigError);
    expect(() => parseAllowedPrefixes("secret/../x", MOUNTS)).toThrow(VaultConfigError);
    expect(() => parseAllowedPrefixes("secret/a%2fb", MOUNTS)).toThrow(VaultConfigError);
  });
});

describe("mount split", () => {
  test("single-segment mount", () => {
    expect(splitMount("secret/slaude/a", ["secret"])).toEqual({ mount: "secret", path: "slaude/a" });
  });

  test("multi-segment mount: the longest configured mount that is a segment prefix", () => {
    const mounts = ["team/kv", "secret"];
    expect(splitMount("team/kv/slaude/a", mounts)).toEqual({ mount: "team/kv", path: "slaude/a" });
    expect(requestPathFor({ scheme: "vault", path: "team/kv/slaude/a", field: "f" }, mounts)).toBe(
      "team/kv/data/slaude/a",
    );
  });

  test("segment-boundary: mount 'secret' does not match 'secrets/…'", () => {
    expect(() => splitMount("secrets/a/b", ["secret"])).toThrow(SecretResolutionError);
  });

  test("a ref that is only the mount is refused", () => {
    expect(() => splitMount("team/kv", ["team/kv"])).toThrow(SecretResolutionError);
  });

  test("no configured mount", () => {
    try {
      splitMount("other/a", ["secret"]);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as SecretResolutionError).reason).toBe("no_mount");
    }
  });
});

describe("loadVaultConfig", () => {
  const base = {
    SLAUDE_VAULT_ADDR: "https://vault.example.com:8200",
    SLAUDE_VAULT_ROLE: "slaude-gateway",
    SLAUDE_VAULT_ALLOWED_PREFIXES: "secret/slaude/personas/{persona}",
  };

  test("unset address ⇒ Vault disabled", () => {
    expect(loadVaultConfig({})).toBeNull();
  });

  test("defaults", () => {
    const c = loadVaultConfig(base)!;
    expect(c.addr).toBe("https://vault.example.com:8200");
    expect(c.auth).toBe("kubernetes");
    expect(c.role).toBe("slaude-gateway");
    expect(c.cacheTtlMs).toBe(60_000);
    expect(c.staleMaxMs).toBe(600_000);
    expect(c.mounts).toEqual(["secret"]);
    expect(c.jwtPath).toBe("/var/run/secrets/kubernetes.io/serviceaccount/token");
    expect(c.namespace).toBeUndefined();
  });

  test("empty allowlist with Vault enabled refuses to start", () => {
    expect(() => loadVaultConfig({ ...base, SLAUDE_VAULT_ALLOWED_PREFIXES: "" })).toThrow(VaultConfigError);
    expect(() => loadVaultConfig({ ...base, SLAUDE_VAULT_ALLOWED_PREFIXES: " , ," })).toThrow(/ALLOWED_PREFIXES/);
    const { SLAUDE_VAULT_ALLOWED_PREFIXES: _, ...noList } = base;
    expect(() => loadVaultConfig(noList)).toThrow(VaultConfigError);
  });

  test("kubernetes auth needs a role; token auth needs a token", () => {
    const { SLAUDE_VAULT_ROLE: _, ...noRole } = base;
    expect(() => loadVaultConfig(noRole)).toThrow(/SLAUDE_VAULT_ROLE/);
    expect(() => loadVaultConfig({ ...base, SLAUDE_VAULT_AUTH: "token" })).toThrow(/SLAUDE_VAULT_TOKEN/);
    expect(loadVaultConfig({ ...base, SLAUDE_VAULT_AUTH: "token", SLAUDE_VAULT_TOKEN: "fake" })!.auth).toBe("token");
    expect(() => loadVaultConfig({ ...base, SLAUDE_VAULT_AUTH: "approle" })).toThrow(/SLAUDE_VAULT_AUTH/);
  });

  test("TTL and stale max parse as seconds; 0 is allowed; junk refused", () => {
    const c = loadVaultConfig({ ...base, SLAUDE_VAULT_CACHE_TTL: "0", SLAUDE_VAULT_STALE_MAX: "30" })!;
    expect(c.cacheTtlMs).toBe(0);
    expect(c.staleMaxMs).toBe(30_000);
    expect(() => loadVaultConfig({ ...base, SLAUDE_VAULT_CACHE_TTL: "-1" })).toThrow(VaultConfigError);
    expect(() => loadVaultConfig({ ...base, SLAUDE_VAULT_CACHE_TTL: "1m" })).toThrow(VaultConfigError);
  });

  test("address must be http(s) with no path, query or credentials", () => {
    expect(() => loadVaultConfig({ ...base, SLAUDE_VAULT_ADDR: "vault.example.com" })).toThrow(VaultConfigError);
    expect(() => loadVaultConfig({ ...base, SLAUDE_VAULT_ADDR: "ftp://vault.example.com" })).toThrow(VaultConfigError);
    expect(() => loadVaultConfig({ ...base, SLAUDE_VAULT_ADDR: "https://u:p@vault.example.com" })).toThrow(
      VaultConfigError,
    );
    expect(loadVaultConfig({ ...base, SLAUDE_VAULT_ADDR: "http://127.0.0.1:8200/" })!.addr).toBe(
      "http://127.0.0.1:8200",
    );
  });

  test("explicit multi-segment mounts; nested mounts are ambiguous and refused", () => {
    const c = loadVaultConfig({
      ...base,
      SLAUDE_VAULT_MOUNTS: "team/kv",
      SLAUDE_VAULT_ALLOWED_PREFIXES: "team/kv/slaude/{persona}",
    })!;
    expect(c.mounts).toEqual(["team/kv"]);
    expect(c.prefixes[0]).toMatchObject({ mount: "team/kv", pathPrefix: "slaude/{persona}" });
    expect(() =>
      loadVaultConfig({ ...base, SLAUDE_VAULT_MOUNTS: "team, team/kv", SLAUDE_VAULT_ALLOWED_PREFIXES: "team/kv/a" }),
    ).toThrow(/ambiguous/);
  });

  test("namespace and CA cert are carried", () => {
    const c = loadVaultConfig({ ...base, SLAUDE_VAULT_NAMESPACE: "team-a", SLAUDE_VAULT_CACERT: "/etc/ca.pem" })!;
    expect(c.namespace).toBe("team-a");
    expect(c.caCertPath).toBe("/etc/ca.pem");
  });
});

describe("assertVaultAllowedInRole", () => {
  test("mono with SLAUDE_VAULT_ADDR is refused", () => {
    expect(() => assertVaultAllowedInRole("mono", { SLAUDE_VAULT_ADDR: "https://vault.example.com" })).toThrow(
      /mono/,
    );
  });

  test("mono without Vault, and gateway with Vault, are fine", () => {
    expect(() => assertVaultAllowedInRole("mono", {})).not.toThrow();
    expect(() => assertVaultAllowedInRole("gateway", { SLAUDE_VAULT_ADDR: "https://vault.example.com" })).not.toThrow();
  });

  test("a node is refused too: nodes hold no Vault configuration", () => {
    expect(() => assertVaultAllowedInRole("node", { SLAUDE_VAULT_ADDR: "https://vault.example.com" })).toThrow(
      /node/,
    );
  });
});
