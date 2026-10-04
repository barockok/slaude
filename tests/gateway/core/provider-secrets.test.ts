import { describe, expect, test } from "bun:test";
import { metrics } from "../../../src/metrics";
import { assertNoProviderRefsInMono, bootProviderSecretResolver, buildProviderSecretResolver, logResolveEvent } from "../../../src/gateway/core/provider-secrets";
import { VaultConfigError } from "../../../src/secrets";
import { startFakeVault } from "../../secrets/fake-vault";

function capture<T>(fn: () => T): { lines: string[]; result: T } {
  const log = console.log; const err = console.error; const lines: string[] = [];
  console.log = (m: string) => { lines.push(`log ${m}`); };
  console.error = (m: string) => { lines.push(`error ${m}`); };
  try { return { lines, result: fn() }; } finally { console.log = log; console.error = err; }
}

describe("mono refuses provider references (WS-A §5.2)", () => {
  test("mono with a persona that sets provider refuses, naming the persona", () => {
    expect(() => assertNoProviderRefsInMono("mono", ["default", "ana"])).toThrow(/SLAUDE_ROLE=mono.*default, ana/);
  });
  test("mono with none, and gateway with some, are fine", () => {
    expect(() => assertNoProviderRefsInMono("mono", [])).not.toThrow();
    expect(() => assertNoProviderRefsInMono("gateway", ["ana"])).not.toThrow();
  });
});

describe("bootProviderSecretResolver", () => {
  const vault = { SLAUDE_VAULT_ADDR: "https://vault.example.com", SLAUDE_VAULT_ROLE: "r", SLAUDE_VAULT_ALLOWED_PREFIXES: "secret/slaude/personas/{persona}" };
  test("a gateway with Vault builds a resolver", () => {
    expect(bootProviderSecretResolver("gateway", vault)).not.toBeNull();
  });
  test("a node resolves nothing, and refuses any Vault variable", () => {
    expect(bootProviderSecretResolver("node", {})).toBeNull();
    expect(() => bootProviderSecretResolver("node", { VAULT_TOKEN: "x" })).toThrow(VaultConfigError);
  });
  test("mono refuses Vault; mono without Vault builds an env-only resolver", () => {
    expect(() => bootProviderSecretResolver("mono", vault)).toThrow(/SLAUDE_ROLE=mono/);
    expect(bootProviderSecretResolver("mono", {})).not.toBeNull();
  });
  test("Vault with an empty allowlist refuses to start", () => {
    expect(() => bootProviderSecretResolver("gateway", { ...vault, SLAUDE_VAULT_ALLOWED_PREFIXES: "" })).toThrow(/ALLOWED_PREFIXES/);
  });
});

describe("provider credential resolver wiring", () => {
  test("events count by scheme and outcome; a refusal logs at error level with its reason", () => {
    const { lines } = capture(() => {
      logResolveEvent({ event: "provider.cred.resolve", persona: "ana", scheme: "vault", outcome: "ok", durationMs: 3.4 });
      logResolveEvent({ event: "provider.cred.resolve", persona: "ana", scheme: "vault", outcome: "denied", durationMs: 1, reason: "prefix" });
    });
    expect(lines[0]).toBe("log [provider.cred.resolve] persona=ana scheme=vault outcome=ok duration_ms=3");
    expect(lines[1]).toBe("error [provider.cred.resolve] persona=ana scheme=vault outcome=denied duration_ms=1 reason=prefix");
    const out = metrics.render();
    expect(out).toMatch(/provider_cred_resolve_total\{[^}]*outcome="denied"[^}]*\} \d+/);
    expect(out).toMatch(/provider_cred_resolve_total\{[^}]*scheme="vault"/);
  });

  test("an env-only gateway resolves env:// through the project sink, never logging the value", async () => {
    const r = buildProviderSecretResolver({ PERSONA_ANA_KEY: "ana-key-value" });
    const log = console.log; const lines: string[] = [];
    console.log = (m: string) => { lines.push(m); };
    try {
      expect(await r.resolve({ scheme: "env", name: "PERSONA_ANA_KEY" }, { persona: "ana" })).toBe("ana-key-value");
    } finally { console.log = log; }
    expect(lines.join("\n")).toContain("outcome=ok");
    expect(lines.join("\n")).not.toContain("ana-key-value");
    expect(lines.join("\n")).not.toContain("PERSONA_ANA_KEY");
  });

  test("Vault enabled with an empty allowlist refuses to build", () => {
    expect(() => buildProviderSecretResolver({
      SLAUDE_VAULT_ADDR: "https://vault.example.com", SLAUDE_VAULT_ROLE: "slaude-gateway",
    })).toThrow(VaultConfigError);
  });

  test("a Vault gateway resolves through the fake Vault, and a stale serve increments its counter", async () => {
    const fv = startFakeVault();
    try {
      fv.secrets.set("secret/data/slaude/personas/ana", { api_key: "fake-ana-key" });
      let t = 1_000_000;
      const r = buildProviderSecretResolver({
        SLAUDE_VAULT_ADDR: fv.addr, SLAUDE_VAULT_ALLOW_INSECURE: "1", SLAUDE_VAULT_ROLE: "slaude-gateway",
        SLAUDE_VAULT_ALLOWED_PREFIXES: "secret/slaude/personas/{persona}",
      }, { now: () => t, readFile: async () => "fake-sa-jwt" });
      const ref = { scheme: "vault" as const, path: "secret/slaude/personas/ana", field: "api_key" };
      const staleCount = () => Number(/provider_cred_stale_served_total (\d+)/.exec(metrics.render())?.[1] ?? 0);
      const before = staleCount();
      const { result } = capture(() => r.resolve(ref, { persona: "ana" }));
      expect(await result).toBe("fake-ana-key");
      t += 120_000;
      fv.kvStatus = 503;
      const second = capture(() => r.resolve(ref, { persona: "ana" }));
      expect(await second.result).toBe("fake-ana-key");
      expect(staleCount()).toBe(before + 1);
    } finally {
      fv.stop();
    }
  });
});
