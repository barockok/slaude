/**
 * Optional: the resolver against a real dev-mode Vault, token auth.
 * Runs only when SLAUDE_VAULT_TEST_ADDR is set, e.g.
 *   docker run --rm -d --name slaude-test-vault -p 18200:8200 -e VAULT_DEV_ROOT_TOKEN_ID=test hashicorp/vault
 *   SLAUDE_VAULT_TEST_ADDR=http://127.0.0.1:18200 SLAUDE_VAULT_TEST_TOKEN=test bun test tests/secrets/vault-real.test.ts
 */
import { describe, expect, test } from "bun:test";
import { createSecretResolver, loadVaultConfig, parseRef } from "../../src/secrets/index";

const addr = process.env.SLAUDE_VAULT_TEST_ADDR;
const token = process.env.SLAUDE_VAULT_TEST_TOKEN ?? "test";

describe.skipIf(!addr)("secrets against a real Vault (dev mode)", () => {
  test("KV v2 read through the resolver; missing field and sibling folder refused", async () => {
    const persona = `itest-${Date.now().toString(36)}`;
    const put = await fetch(`${addr}/v1/secret/data/slaude/personas/${persona}`, {
      method: "POST",
      headers: { "X-Vault-Token": token, "content-type": "application/json" },
      body: JSON.stringify({ data: { api_key: "fake-real-vault-key" } }),
    });
    expect(put.ok).toBe(true);

    const env = {
      SLAUDE_VAULT_ADDR: addr!,
      SLAUDE_VAULT_AUTH: "token",
      SLAUDE_VAULT_ALLOW_INSECURE: "1",
      SLAUDE_VAULT_TOKEN: token,
      SLAUDE_VAULT_ALLOWED_PREFIXES: "secret/slaude/personas/{persona}",
    };
    const r = createSecretResolver({ env, vault: loadVaultConfig(env), onEvent: () => {} });
    const ref = parseRef(`vault://secret/slaude/personas/${persona}#api_key`);
    expect(await r.resolve(ref, { persona })).toBe("fake-real-vault-key");
    await expect(
      r.resolve(parseRef(`vault://secret/slaude/personas/${persona}#nope`), { persona }),
    ).rejects.toMatchObject({ reason: "missing_field" });
    await expect(
      r.resolve(parseRef(`vault://secret/slaude/personas/${persona}-none#api_key`), { persona: `${persona}-none` }),
    ).rejects.toMatchObject({ reason: "missing_secret" });
    await expect(r.resolve(ref, { persona: "someone-else" })).rejects.toMatchObject({ reason: "prefix" });
  });
});
