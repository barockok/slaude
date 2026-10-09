/**
 * Runtime bundle carries the gateway's voice config to nodes (spec §10,
 * plan deviation 2). In the gateway topology nodes never hold voice keys
 * in their own environment. Tenant isolation via SLAUDE_VOICE_TENANTS gating.
 */
import { describe, it, expect, beforeAll, afterEach } from "bun:test";

const { ensureHome } = await import("../../../src/config/home");
const { handleTenantRuntime } = await import("../../../src/gateway/api/tenants");
const { __resetPersonaRegistry } = await import("../../../src/persona/registry");

const KEYS = ["SLAUDE_VOICE_ENABLED", "SLAUDE_VOICE_API_KEY", "SLAUDE_VOICE_WORKBENCH_URL", "SLAUDE_VOICE_MODEL", "SLAUDE_VOICE_TENANTS"];
beforeAll(() => {
  ensureHome();
  __resetPersonaRegistry();
});
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

const fetchBundle = async (tenantId = "default", etag?: string) =>
  handleTenantRuntime(
    new Request("http://gw/x", etag ? { headers: { "if-none-match": etag } } : {}),
    tenantId,
    "default"
  );

describe.skipIf(process.env.SLAUDE_DB === "pg")("runtime bundle voice block", () => {
  it("is null when voice is disabled", async () => {
    const r = await fetchBundle();
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).voice).toBeNull();
  });

  it("is null when SLAUDE_VOICE_TENANTS is unset, even if voice is configured", async () => {
    process.env.SLAUDE_VOICE_ENABLED = "1";
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
    process.env.SLAUDE_VOICE_MODEL = "openai/gpt-realtime";
    // SLAUDE_VOICE_TENANTS not set
    const r = await fetchBundle();
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).voice).toBeNull();
  });

  it("carries voice to allowed tenant in SLAUDE_VOICE_TENANTS", async () => {
    process.env.SLAUDE_VOICE_ENABLED = "1";
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
    process.env.SLAUDE_VOICE_MODEL = "openai/gpt-realtime";
    process.env.SLAUDE_VOICE_TENANTS = "default";

    const r = await fetchBundle("default");
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).voice).toEqual({
      model: "openai/gpt-realtime",
      apiKey: "k",
      workbenchUrl: "https://wb.example.com",
      maxMinutes: 120,
      staleSeq: 6,
    });
  });

  it("does not carry voice to tenant not in SLAUDE_VOICE_TENANTS", async () => {
    process.env.SLAUDE_VOICE_ENABLED = "1";
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
    process.env.SLAUDE_VOICE_MODEL = "openai/gpt-realtime";
    process.env.SLAUDE_VOICE_TENANTS = "other-tenant";

    const r = await fetchBundle("default");
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).voice).toBeNull();
  });

  it("carries voice to all tenants when SLAUDE_VOICE_TENANTS is *", async () => {
    process.env.SLAUDE_VOICE_ENABLED = "1";
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
    process.env.SLAUDE_VOICE_MODEL = "openai/gpt-realtime";
    process.env.SLAUDE_VOICE_TENANTS = "*";

    const r = await fetchBundle("default");
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).voice).toEqual({
      model: "openai/gpt-realtime",
      apiKey: "k",
      workbenchUrl: "https://wb.example.com",
      maxMinutes: 120,
      staleSeq: 6,
    });
  });

  it("carries the gateway's voice env when enabled, and changes the ETag", async () => {
    process.env.SLAUDE_VOICE_TENANTS = "default";
    const before = (await fetchBundle()).headers.get("etag")!;
    process.env.SLAUDE_VOICE_ENABLED = "1";
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
    process.env.SLAUDE_VOICE_MODEL = "openai/gpt-realtime";
    const r = await fetchBundle("default", before);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).voice).toEqual({
      model: "openai/gpt-realtime",
      apiKey: "k",
      workbenchUrl: "https://wb.example.com",
      maxMinutes: 120,
      staleSeq: 6,
    });
  });

  it("bad SLAUDE_VOICE_MODEL does not 500, ships voice null instead", async () => {
    process.env.SLAUDE_VOICE_ENABLED = "1";
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
    process.env.SLAUDE_VOICE_MODEL = "nope/x";
    process.env.SLAUDE_VOICE_TENANTS = "default";
    const r = await fetchBundle();
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).voice).toBeNull();
  });

  it("another bad SLAUDE_VOICE_MODEL shape also ships voice null", async () => {
    process.env.SLAUDE_VOICE_ENABLED = "1";
    process.env.SLAUDE_VOICE_API_KEY = "k";
    process.env.SLAUDE_VOICE_WORKBENCH_URL = "https://wb.example.com";
    process.env.SLAUDE_VOICE_MODEL = "x";
    process.env.SLAUDE_VOICE_TENANTS = "default";
    const r = await fetchBundle();
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).voice).toBeNull();
  });
});
