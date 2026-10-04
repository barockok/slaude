import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadVaultConfig } from "../../src/secrets/config";
import { createEnvBackend } from "../../src/secrets/env-backend";
import { SecretResolutionError } from "../../src/secrets/errors";
import { createSecretResolver, type ResolveEvent } from "../../src/secrets/index";
import { parseRef } from "../../src/secrets/ref";
import { startFakeVault, type FakeVault } from "./fake-vault";

describe("env backend", () => {
  test("reads a PERSONA_ variable from the injected env", () => {
    expect(createEnvBackend({ PERSONA_X: "fake-x" }).read("PERSONA_X")).toBe("fake-x");
  });

  test("missing or empty is a typed failure", () => {
    const b = createEnvBackend({ PERSONA_EMPTY: "" });
    for (const name of ["PERSONA_EMPTY", "PERSONA_MISSING"]) {
      try {
        b.read(name);
        throw new Error("expected a throw");
      } catch (e) {
        expect(e).toBeInstanceOf(SecretResolutionError);
        expect((e as SecretResolutionError).reason).toBe("env_missing");
      }
    }
  });

  test("a non-PERSONA_ name is never read, even if the caller skipped parsing", () => {
    expect(() => createEnvBackend({ SLAUDE_MASTER_KEY: "fake" }).read("SLAUDE_MASTER_KEY")).toThrow();
  });
});

describe("createSecretResolver", () => {
  let fv: FakeVault;
  let t: number;
  let events: ResolveEvent[];
  let stale: number;

  beforeEach(() => {
    fv = startFakeVault();
    fv.secrets.set("secret/data/slaude/personas/support-bot", { api_key: "fake-support-key" });
    fv.secrets.set("secret/data/slaude/personas/billing-bot", { api_key: "fake-billing-key" });
    t = 5_000_000;
    events = [];
    stale = 0;
  });
  afterEach(() => fv.stop());

  function make(envOver: Record<string, string> = {}) {
    const env = {
      SLAUDE_VAULT_ADDR: fv.addr,
      SLAUDE_VAULT_ALLOW_INSECURE: "1", // the fake Vault speaks plain http
      SLAUDE_VAULT_ROLE: "slaude-gateway",
      SLAUDE_VAULT_ALLOWED_PREFIXES: "secret/slaude/personas/{persona}",
      PERSONA_SUPPORT_URL: "https://llm.example.com",
      ...envOver,
    };
    return createSecretResolver({
      env,
      vault: loadVaultConfig(env),
      now: () => t,
      readFile: async () => "fake-sa-jwt",
      onEvent: (e) => events.push(e),
      onStale: () => stale++,
    });
  }

  const supportRef = parseRef("vault://secret/slaude/personas/support-bot#api_key");

  test("resolves a vault ref and caches it", async () => {
    const r = make();
    expect(await r.resolve(supportRef, { persona: "support-bot" })).toBe("fake-support-key");
    expect(await r.resolve(supportRef, { persona: "support-bot" })).toBe("fake-support-key");
    expect(fv.counts.kv).toBe(1);
    expect(events.map((e) => e.outcome)).toEqual(["ok", "cached"]);
    expect(events[0]).toMatchObject({ event: "provider.cred.resolve", persona: "support-bot", scheme: "vault" });
    expect(typeof events[0]!.durationMs).toBe("number");
  });

  test("resolves an env ref", async () => {
    const r = make();
    expect(await r.resolve(parseRef("env://PERSONA_SUPPORT_URL"), { persona: "support-bot" })).toBe(
      "https://llm.example.com",
    );
    expect(events[0]).toMatchObject({ scheme: "env", outcome: "ok" });
  });

  test("a sibling persona's folder is refused before any network call", async () => {
    const r = make();
    const billing = parseRef("vault://secret/slaude/personas/billing-bot#api_key");
    await expect(r.resolve(billing, { persona: "support-bot" })).rejects.toMatchObject({ reason: "prefix" });
    expect(fv.counts.kv + fv.counts.login).toBe(0);
    expect(events[0]).toMatchObject({ outcome: "denied", reason: "prefix" });
  });

  test("a hand-built ref that would not parse is refused at resolution too", async () => {
    const r = make();
    const evil = { scheme: "vault" as const, path: "secret/slaude/personas/support-bot/../../gateway", field: "k" };
    await expect(r.resolve(evil, { persona: "support-bot" })).rejects.toMatchObject({ reason: "invalid_ref" });
    expect(fv.counts.kv).toBe(0);
    expect(events[0]).toMatchObject({ outcome: "error", reason: "invalid_ref" });
  });

  test("vault ref without Vault configured is a typed 'disabled' failure", async () => {
    const r = createSecretResolver({ env: {}, onEvent: (e) => events.push(e) });
    await expect(r.resolve(supportRef, { persona: "support-bot" })).rejects.toMatchObject({ reason: "disabled" });
    expect(events[0]).toMatchObject({ outcome: "error", reason: "disabled" });
  });

  test("stale serving goes through the resolver: outcome 'stale' and the counter hook", async () => {
    const r = make();
    await r.resolve(supportRef, { persona: "support-bot" });
    t += 120_000;
    fv.kvStatus = 503;
    expect(await r.resolve(supportRef, { persona: "support-bot" })).toBe("fake-support-key");
    expect(stale).toBe(1);
    expect(events.at(-1)).toMatchObject({ outcome: "stale" });
    t += 600_000;
    await expect(r.resolve(supportRef, { persona: "support-bot" })).rejects.toMatchObject({
      reason: "server_error",
    });
    expect(events.at(-1)).toMatchObject({ outcome: "error", reason: "server_error" });
  });

  test("Vault policy denial is outcome 'denied'", async () => {
    fv.denied.add("secret/data/slaude/personas/support-bot");
    const r = make();
    await expect(r.resolve(supportRef, { persona: "support-bot" })).rejects.toMatchObject({ reason: "denied" });
    expect(events[0]).toMatchObject({ outcome: "denied", reason: "denied" });
  });

  test("TTL 0 fetches on every resolve", async () => {
    const r = make({ SLAUDE_VAULT_CACHE_TTL: "0" });
    await r.resolve(supportRef, { persona: "support-bot" });
    await r.resolve(supportRef, { persona: "support-bot" });
    expect(fv.counts.kv).toBe(2);
  });

  test("single flight through the resolver: N concurrent resolves, one upstream read", async () => {
    const r = make();
    await Promise.all(Array.from({ length: 30 }, () => r.resolve(supportRef, { persona: "support-bot" })));
    expect(fv.counts.kv).toBe(1);
    expect(fv.counts.login).toBe(1);
  });

  test("the logging hook never receives a path, field or value", async () => {
    const r = make();
    await r.resolve(supportRef, { persona: "support-bot" });
    await r.resolve(parseRef("env://PERSONA_SUPPORT_URL"), { persona: "support-bot" });
    await r
      .resolve(parseRef("vault://secret/slaude/personas/billing-bot#api_key"), { persona: "support-bot" })
      .catch(() => {});
    await r.resolve(parseRef("vault://secret/slaude/personas/support-bot#nope"), { persona: "support-bot" }).catch(() => {});
    const dump = JSON.stringify(events);
    for (const needle of [
      "fake-support-key",
      "fake-billing-key",
      "llm.example.com",
      "slaude/personas",
      "api_key",
      "nope",
      "PERSONA_SUPPORT_URL",
      "fake-sa-jwt",
      "fake-token",
    ]) {
      expect(dump).not.toContain(needle);
    }
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(
        e.reason === undefined
          ? ["durationMs", "event", "outcome", "persona", "scheme"]
          : ["durationMs", "event", "outcome", "persona", "reason", "scheme"],
      );
    }
  });
});
