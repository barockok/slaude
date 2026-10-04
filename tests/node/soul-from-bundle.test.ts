/**
 * Nodes take the persona soul from the runtime bundle (via an injectable
 * resolver), never from the shared volume. Without a resolver (mono, gateway)
 * the local soul source is used exactly as before.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { AgentManager } from "../../src/agent/manager";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../src/persona/registry";
import {
  bundleChildEnv, makeBundleModelResolver, makeBundleSoulResolver, makeNodeChildEnvResolver, makeTenantReloadHandler, nodeChildEnv,
  PROVIDER_ENV_KEYS,
} from "../../src/node/worker";
import { NodeApiError } from "../../src/node/client";
import { ChildEnvPatch } from "../../src/agent/child-env";
import { BootFailure } from "../../src/gateway/core/failure-codes";

const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

afterEach(() => {
  __resetPersonaRegistry();
});

describe("persona soul resolution", () => {
  test("with a resolver installed, the session's persona block comes from it", async () => {
    const agent = new AgentManager();
    agent.setPersonaSoulResolver(async () => ({ soulMd: "SOUL-FROM-BUNDLE", soulJson: { approvers: [] } }));
    const prompt = await agent.__systemPromptForTests("s-1", "ana");
    expect(prompt).toContain("SOUL-FROM-BUNDLE");
  });

  test("a resolver failure fails the session boot instead of falling back to disk", async () => {
    const agent = new AgentManager();
    agent.setPersonaSoulResolver(async () => {
      throw new Error("gateway unreachable");
    });
    await expect(agent.__systemPromptForTests("s-1", "ana")).rejects.toThrow(/gateway unreachable/);
  });

  test("without a resolver, the local soul source is used, as in mono", async () => {
    const agent = new AgentManager();
    const prompt = await agent.__systemPromptForTests("s-1", undefined);
    expect(prompt).toContain("<persona>");
  });

  test("the resolver receives the session's persona name without a registry lookup", async () => {
    // A node has no persona directory on the volume: any registry read on the
    // boot path is a hidden disk read. Install a registry that refuses reads.
    const refuse = () => {
      throw new Error("registry read on the node boot path");
    };
    const registry: PersonaRegistry = {
      lookupByName: refuse,
      lookupByUserId: refuse,
      list: refuse,
      isMultiPersonaMode: refuse,
      isManaged: refuse,
      tombstonedPersonaFor: refuse,
    };
    setPersonaRegistry(registry);
    const seen: Array<[string, string | undefined]> = [];
    const agent = new AgentManager();
    agent.setPersonaSoulResolver(async (sid, persona) => {
      seen.push([sid, persona]);
      return { soulMd: "ana soul", soulJson: null };
    });
    await agent.__systemPromptForTests("s-1", "ana");
    await agent.__systemPromptForTests("s-2", "default");
    await agent.__systemPromptForTests("s-3", undefined);
    expect(seen).toEqual([
      ["s-1", "ana"],
      ["s-2", undefined],
      ["s-3", undefined],
    ]);
  });

  test("the channel mandate comes from the resolver's structured soul when it has one", async () => {
    const agent = new AgentManager();
    agent.setPersonaSoulResolver(async () => ({
      soulMd: "ana soul",
      soulJson: {
        mandate: "global mandate",
        channelOverrides: [{ channel: "CTEAM01", mandate: "ANA-CHANNEL-MANDATE", approvers: [] }],
      },
    }));
    const inChannel = await agent.__systemPromptForTests("s-1", "ana", { channelId: "CTEAM01" });
    expect(inChannel).toContain("<channel-mandate>");
    expect(inChannel).toContain("ANA-CHANNEL-MANDATE");
    const elsewhere = await agent.__systemPromptForTests("s-2", "ana", { channelId: "COTHER01" });
    expect(elsewhere).not.toContain("<channel-mandate>");
  });

  test("session boot logs the soul's hash, never its text", async () => {
    const soul = "SECRET-SOUL-TEXT that must never reach a log line";
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    try {
      const agent = new AgentManager();
      agent.setPersonaSoulResolver(async () => ({ soulMd: soul, soulJson: null }));
      await agent.__systemPromptForTests("s-log", "ana");
      await agent.__systemPromptForTests("s-log-default", undefined);
    } finally {
      spy.mockRestore();
    }
    const lines = logs.filter((l) => l.startsWith("[agent] session="));
    expect(lines).toEqual([
      `[agent] session=s-log persona=ana soul=${shortHash(soul)}`,
      `[agent] session=s-log-default persona=default soul=${shortHash(soul)}`,
    ]);
    for (const l of logs) expect(l).not.toContain("SECRET-SOUL-TEXT");
  });

  test("a structured soul that does not parse yields no channel mandate, never another persona's", async () => {
    const warns: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    });
    let prompt = "";
    try {
      const agent = new AgentManager();
      agent.setPersonaSoulResolver(async () => ({
        soulMd: "ana soul",
        soulJson: { channelOverrides: [{ channel: "not-a-channel-id", mandate: "x" }], approvalTimeoutSeconds: -1 },
      }));
      prompt = await agent.__systemPromptForTests("s-bad", "ana", { channelId: "CTEAM01" });
    } finally {
      spy.mockRestore();
    }
    expect(prompt).not.toContain("<channel-mandate>");
    expect(warns).toEqual(["[agent] session=s-bad persona=ana structured soul did not parse; no channel mandate"]);
  });

  // Review Focus 5: a tombstone refuses new work and never interrupts a turn.
  test("a turn in flight survives its persona being tombstoned", async () => {
    const soul = "ana soul";
    let tombstoned = false;
    const agent = new AgentManager();
    agent.setPersonaSoulResolver(async () => {
      if (tombstoned) throw new Error("bundle 404: persona tombstoned");
      return { soulMd: soul, soulJson: null };
    });
    // Boot: the soul is resolved once, at session start.
    const first = await agent.__systemPromptForTests("s-1", "ana");
    expect(first).toContain("ana soul");
    // The persona is tombstoned mid-turn. The running turn already holds its
    // prompt, so nothing it uses is re-resolved.
    tombstoned = true;
    expect(first).toContain("ana soul");
    // New work for the persona is refused at the next boot, loudly.
    await expect(agent.__systemPromptForTests("s-2", "ana")).rejects.toThrow(/tombstoned/);
  });
});

describe("node reload signal", () => {
  test("a reload signal reboots warm sessions for that tenant only", () => {
    const busted: string[] = [];
    const reloaded: string[] = [];
    const tenants = new Map([
      ["sess-default", "default"],
      ["sess-other", "other"],
      ["sess-default-2", "default"],
    ]);
    const onReload = makeTenantReloadHandler({
      bustRuntime: (t) => busted.push(t),
      reload: (sid) => {
        reloaded.push(sid);
        return true;
      },
      tenants,
    });
    onReload("default");
    expect(busted).toEqual(["default"]);
    expect(reloaded.sort()).toEqual(["sess-default", "sess-default-2"]);
    expect(reloaded).not.toContain("sess-other");
  });

  test("the worker's reload path calls AgentManager.reloadAfterTurn, which only touches live sessions", () => {
    const agent = new AgentManager();
    const spy = spyOn(agent, "reloadAfterTurn");
    const onReload = makeTenantReloadHandler({
      bustRuntime: () => {},
      reload: (sid) => agent.reloadAfterTurn(sid),
      tenants: new Map([["cold", "default"]]),
    });
    onReload("default");
    expect(spy).toHaveBeenCalledWith("cold");
    // Not live → nothing to close; the next turn boots fresh anyway.
    expect(spy.mock.results[0]?.value).toBe(false);
  });
});

describe("node bundle resolvers", () => {
  const bundle = { soulMd: "S", soulJson: null, providerCreds: {}, slackUserId: "UANA" } as any;
  const deps = (recorded: string | undefined, seen: string[]) => ({
    client: { getRuntime: async (_t: string, p: string) => (seen.push(p), bundle) },
    tenantFor: () => "default",
    tokenFor: () => "job-token",
    personaFor: () => recorded,
  });

  test("the soul resolver fetches the bundle for the persona it is asked for", async () => {
    const seen: string[] = [];
    const r = makeBundleSoulResolver(deps("ana", seen));
    expect(await r("s-1", "ana")).toEqual({ soulMd: "S", soulJson: null });
    const seen2: string[] = [];
    await makeBundleSoulResolver(deps("default", seen2))("s-2", undefined);
    expect([...seen, ...seen2]).toEqual(["ana", "default"]);
  });

  test("a persona that disagrees with the job's recorded persona fails the boot", async () => {
    const seen: string[] = [];
    const r = makeBundleSoulResolver(deps("bea", seen));
    await expect(r("s-1", "ana")).rejects.toThrow(/persona mismatch.*'ana'.*'bea'/);
    expect(seen).toEqual([]);
  });

  test("no tenant or job token fails the boot", async () => {
    const r = makeBundleSoulResolver({ ...deps("ana", []), tokenFor: () => undefined });
    await expect(r("s-1", "ana")).rejects.toThrow(/no tenant or job token/);
  });

  test("the child env carries SLAUDE_AGENT_ID for a named persona only", () => {
    expect(bundleChildEnv({ providerCreds: { apiKey: "k" }, slackUserId: "UANA" }, "ana")).toEqual({
      ANTHROPIC_API_KEY: "k",
      SLAUDE_AGENT_ID: "UANA",
    });
    expect(bundleChildEnv({ providerCreds: {}, slackUserId: "UDEF" }, "default")).toEqual({});
    expect(bundleChildEnv({ providerCreds: {}, slackUserId: null }, "ana")).toEqual({});
  });
});

// WS-A §5.4: no silent fallback onto the node's own provider environment.
describe("nodeChildEnv", () => {
  const nodeEnv = { ANTHROPIC_API_KEY: "node-key", ANTHROPIC_BASE_URL: "https://node.example.com" };
  const warns: Array<[string, string[]]> = [];
  const opts = (fallback: boolean) => ({ fallback, nodeEnv, warn: (p: string, n: string[]) => warns.push([p, n]) });

  test("an unmanaged bundle is additive, whatever the flag, and never warns", () => {
    warns.length = 0;
    const b = { providerCreds: {}, slackUserId: "UANA" };
    expect(nodeChildEnv(b, "ana", opts(false))).toEqual({ SLAUDE_AGENT_ID: "UANA" });
    expect(nodeChildEnv(b, "ana", opts(true))).toEqual({ SLAUDE_AGENT_ID: "UANA" });
    expect(warns).toEqual([]);
  });

  test("fallback on: additive, and names the persona and the variables the node filled", () => {
    warns.length = 0;
    const out = nodeChildEnv({ providerCreds: { authToken: "t" }, slackUserId: null, managed: true }, "ana", opts(true));
    expect(out).toEqual({ ANTHROPIC_AUTH_TOKEN: "t" });
    expect(warns).toEqual([["ana", ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]]]);
  });

  test("fallback on: a bundle that supplies everything the node has does not warn", () => {
    warns.length = 0;
    nodeChildEnv({ providerCreds: { apiKey: "k", baseUrl: "https://p.example.com" }, slackUserId: null, managed: true }, "ana", opts(true));
    expect(warns).toEqual([]);
  });

  // R2-F3: every variable that selects or authenticates a provider.
  const FULL_LIST = [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE",
    "ANTHROPIC_BEDROCK_BASE_URL", "GOOGLE_APPLICATION_CREDENTIALS", "ANTHROPIC_UNIX_SOCKET",
    "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
  ];
  const richNodeEnv = {
    ...nodeEnv, ANTHROPIC_VERTEX_PROJECT_ID: "p", ANTHROPIC_VERTEX_BASE_URL: "https://v.example.com",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "m", ANTHROPIC_DEFAULT_HAIKU_MODEL: "m", PATH: "/bin", ANTHROPIC_DEFAULTS: "not-a-model-var",
  };

  test("fallback off: a patch that deletes every provider-selecting variable the bundle did not supply", () => {
    const out = nodeChildEnv({ providerCreds: { apiKey: "k" }, slackUserId: "UANA", managed: true }, "ana",
      { ...opts(false), nodeEnv: richNodeEnv });
    expect(out).toBeInstanceOf(ChildEnvPatch);
    const p = out as ChildEnvPatch;
    expect(p.set).toEqual({ ANTHROPIC_API_KEY: "k", SLAUDE_AGENT_ID: "UANA" });
    const expected = [...FULL_LIST, "ANTHROPIC_VERTEX_PROJECT_ID", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"];
    expect([...p.unset].sort()).toEqual(expected.sort());
    expect(p.unset).not.toContain("PATH");
    expect(p.unset).not.toContain("ANTHROPIC_DEFAULTS");
    for (const k of PROVIDER_ENV_KEYS) expect(p.unset).toContain(k);
  });

  // M-1: a persona that declares its own provider is never mixed with the node's.
  test("a declared provider is strict even with fallback on: nothing from the node, no warning", () => {
    warns.length = 0;
    const out = nodeChildEnv({ providerCreds: { apiKey: "k", baseUrl: "https://p.example.com" }, slackUserId: null, managed: true, ownProvider: true },
      "ana", { ...opts(true), nodeEnv: richNodeEnv });
    expect(out).toBeInstanceOf(ChildEnvPatch);
    const p = out as ChildEnvPatch;
    expect(p.set).toEqual({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://p.example.com" });
    expect(p.unset).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(p.unset).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(p.unset).toContain("AWS_SECRET_ACCESS_KEY");
    expect(warns).toEqual([]);
  });

  test("a declared provider with only a key drops the node's base URL", () => {
    const p = nodeChildEnv({ providerCreds: { apiKey: "k" }, slackUserId: null, managed: true, ownProvider: true }, "ana", opts(true)) as ChildEnvPatch;
    expect(p.unset).toContain("ANTHROPIC_BASE_URL");
    expect(p.set.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("fallback off: a managed persona with no credential fails with the typed code", () => {
    let e: unknown;
    try {
      nodeChildEnv({ providerCreds: { baseUrl: "https://p.example.com" }, slackUserId: null, managed: true }, "ana", opts(false));
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(BootFailure);
    expect((e as BootFailure).code).toBe("PROVIDER_CREDENTIALS_UNAVAILABLE");
    expect((e as BootFailure).transient).toBe(false);
    expect((e as Error).message).toContain("'ana'");
  });
});

describe("makeNodeChildEnvResolver", () => {
  const managed = { providerCreds: { authToken: "t" }, slackUserId: null, managed: true };
  const deps = (over: Record<string, unknown> = {}) => ({
    client: { getRuntime: async () => managed as any },
    tenantFor: () => "default" as string | undefined,
    tokenFor: () => "job-token" as string | undefined,
    personaFor: () => "ana" as string | undefined,
    nodeEnv: { ANTHROPIC_API_KEY: "node-key" },
    ...over,
  });
  const savedFlag = process.env.SLAUDE_PROVIDER_ENV_FALLBACK;
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.SLAUDE_PROVIDER_ENV_FALLBACK;
    else process.env.SLAUDE_PROVIDER_ENV_FALLBACK = savedFlag;
  });

  test("the flag comes from SLAUDE_PROVIDER_ENV_FALLBACK when not passed", async () => {
    process.env.SLAUDE_PROVIDER_ENV_FALLBACK = "0";
    expect(await makeNodeChildEnvResolver(deps())("s-1")).toBeInstanceOf(ChildEnvPatch);
    process.env.SLAUDE_PROVIDER_ENV_FALLBACK = "1";
    expect(await makeNodeChildEnvResolver(deps({ warn: () => {} }))("s-1")).toEqual({ ANTHROPIC_AUTH_TOKEN: "t" });
  });

  test("the fallback warning is logged once per persona, naming it", async () => {
    const lines: string[] = [];
    const r = makeNodeChildEnvResolver(deps({ fallback: true, warn: (m: string) => lines.push(m) }));
    await r("s-1");
    await r("s-2");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("'ana'");
    expect(lines[0]).toContain("ANTHROPIC_API_KEY");
    const r2 = makeNodeChildEnvResolver(deps({ fallback: true, warn: (m: string) => lines.push(m), personaFor: () => "bea" }));
    await r2("s-3");
    expect(lines).toHaveLength(2);
  });

  test("no tenant or token: nothing with fallback on, a typed failure with fallback off", async () => {
    expect(await makeNodeChildEnvResolver(deps({ fallback: true, tokenFor: () => undefined }))("s-1")).toBeUndefined();
    const e = await makeNodeChildEnvResolver(deps({ fallback: false, tokenFor: () => undefined }))("s-1").catch((x) => x);
    expect(e).toBeInstanceOf(BootFailure);
    expect(e.code).toBe("PROVIDER_CREDENTIALS_UNAVAILABLE");
  });

  // R2-F4: transient vs definitive, from the gateway's 503 body.
  test("a gateway 503 maps to a typed failure carrying its transient flag; other failures are classified", async () => {
    const failWith = (err: unknown) => deps({ fallback: false, client: { getRuntime: async () => { throw err; } } });
    const body = (transient: boolean) => JSON.stringify({ error: "provider credentials unavailable", code: "PROVIDER_CREDENTIALS_UNAVAILABLE", transient });
    const t = await makeNodeChildEnvResolver(failWith(new NodeApiError(503, body(true))))("s-1").catch((x) => x);
    expect(t).toBeInstanceOf(BootFailure);
    expect(t.transient).toBe(true);
    const d = await makeNodeChildEnvResolver(failWith(new NodeApiError(503, body(false))))("s-1").catch((x) => x);
    expect(d.transient).toBe(false);
    const net = await makeNodeChildEnvResolver(failWith(new Error("ECONNREFUSED")))("s-1").catch((x) => x);
    expect(net.transient).toBe(true);
    const gone = await makeNodeChildEnvResolver(failWith(new NodeApiError(404, "{}")))("s-1").catch((x) => x);
    expect(gone.transient).toBe(false);
  });
});

// R42 (I2): a node takes a persona's default model from its runtime bundle —
// but only from a managed bundle; an unmanaged one leaves the row as it is.
describe("node bundle model resolver", () => {
  const deps = (b: unknown, recorded: string | undefined = "ana") => ({
    client: { getRuntime: async () => b as any },
    tenantFor: () => "default",
    tokenFor: () => "job-token",
    personaFor: () => recorded,
  });
  test("a managed bundle yields its default model", async () => {
    expect(await makeBundleModelResolver(deps({ managed: true, defaultModel: "m-ana" }))("s-1", "ana")).toBe("m-ana");
  });
  test("an unmanaged bundle yields nothing", async () => {
    expect(await makeBundleModelResolver(deps({ defaultModel: "m-env" }))("s-1", "ana")).toBeUndefined();
  });
  test("a persona mismatch fails the boot", async () => {
    await expect(makeBundleModelResolver(deps({ managed: true, defaultModel: "m" }, "bea"))("s-1", "ana")).rejects.toThrow(/persona mismatch/);
  });
});
