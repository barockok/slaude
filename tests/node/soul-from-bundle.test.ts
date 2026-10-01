/**
 * Nodes take the persona soul from the runtime bundle (via an injectable
 * resolver), never from the shared volume. Without a resolver (mono, gateway)
 * the local soul source is used exactly as before.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { AgentManager } from "../../src/agent/manager";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../src/persona/registry";
import { bundleChildEnv, makeBundleModelResolver, makeBundleSoulResolver, makeTenantReloadHandler } from "../../src/node/worker";

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
