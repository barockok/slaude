import { describe, it, expect, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import {
  voiceRefusalFromClaims,
  makeMonoVoiceHost,
  makeNodeVoiceHost,
  instructionsFrom,
  drainVoiceCalls,
  voiceServersFor,
} from "../../src/voice/hosts";
import { VOICE_MCP_NAME, type VoiceHost } from "../../src/agent/voice-mcp";
import { VoiceAuthLost } from "../../src/voice/runners";
import { VoiceCalls } from "../../src/voice/call";
import type { VoiceConfig } from "../../src/voice/config";

/** An agent that finishes every turn at once and records what it was asked. */
class FakeAgent extends EventEmitter {
  sent: string[] = [];
  holds: Array<[string, boolean]> = [];
  holdResult = true;
  identity: string | undefined = undefined;
  identityCalls: Array<[string, string | null | undefined, string | null | undefined]> = [];
  suppressNextTurn() {}
  isTurnInFlight() { return false; }
  holdIdle(id: string, h: boolean) { this.holds.push([id, h]); return this.holdResult; }
  async resolveEffectiveIdentity(sid: string, ch?: string | null, ts?: string | null) {
    this.identityCalls.push([sid, ch, ts]);
    return this.identity;
  }
  async sendMessage(id: string, text: string) {
    this.sent.push(text);
    queueMicrotask(() => this.emit("event", { type: "done", sessionId: id }));
  }
}

const cfg: VoiceConfig = {
  provider: "openai", model: "gpt-realtime", apiKey: "k", workbenchUrl: "https://wb.example.com", maxMinutes: 90, staleSeq: 4,
};
const soul = { identity: { name: "Ada", role: "release helper", voice: "calm" }, values: ["be brief"], mandate: "ship safely" };

describe("voiceRefusalFromClaims", () => {
  it("refuses locked, remote, or person-identity turns", () => {
    expect(voiceRefusalFromClaims({ lock: { user: "U1", openScope: null } })).toBe("VOICE_AGENT_ONLY");
    expect(voiceRefusalFromClaims({ lock: null, remote: { addr: "a", dir: "/d" } })).toBe("VOICE_AGENT_ONLY");
    expect(voiceRefusalFromClaims({ lock: null, runAs: "user:U1" })).toBe("VOICE_AGENT_ONLY");
    expect(voiceRefusalFromClaims({ lock: null, runAs: "agent" })).toBeNull();
    expect(voiceRefusalFromClaims({ lock: null, runAs: "agent", remote: null })).toBeNull();
  });
  it("fails closed when the claims are unknown", () => {
    expect(voiceRefusalFromClaims(null)).toBe("VOICE_UNAVAILABLE");
  });
});

describe("instructionsFrom", () => {
  it("reads identity, values and mandate from a soul object", () => {
    const s = instructionsFrom(soul, "standup");
    expect(s).toContain("You are Ada, release helper.");
    expect(s).toContain("Voice and tone: calm");
    expect(s).toContain("Values: be brief");
    expect(s).toContain("Mandate: ship safely");
    expect(s).toContain("<call-brief>\nstandup\n</call-brief>");
  });
  it("tolerates a missing or malformed soul", () => {
    for (const bad of [null, undefined, "x", { values: "nope" }]) {
      const s = instructionsFrom(bad, "");
      expect(s).not.toContain("Values:");
      expect(s).toContain("speaking live");
    }
  });
});

describe("mono voice host", () => {
  function mono(o: { thread?: { channel: string; threadTs: string } | null; remote?: unknown } = {}) {
    const agent = new FakeAgent();
    const remoteCalls: Array<[string, string]> = [];
    const host = makeMonoVoiceHost({
      agent: agent as any,
      config: () => cfg,
      findThread: async () => (o.thread === undefined ? { channel: "C1", threadTs: "1.1" } : o.thread),
      remoteTarget: async (c, t) => { remoteCalls.push([c, t]); return o.remote ?? null; },
      workingDir: async (sid) => `/work/${sid}`,
      soul: () => soul,
    });
    return { host, agent, remoteCalls };
  }

  it("allows an agent-identity thread", async () => {
    const { host, agent } = mono();
    expect(await host.refusal("s1")).toBeNull();
    expect(agent.identityCalls).toEqual([["s1", "C1", "1.1"]]);
  });
  it("refuses a /1on1-locked thread (the effective identity is a person)", async () => {
    const { host, agent } = mono();
    agent.identity = "U1";
    expect(await host.refusal("s1")).toBe("VOICE_AGENT_ONLY");
  });
  it("refuses a thread with an active remote target", async () => {
    const { host, remoteCalls } = mono({ remote: { userId: "U1", addr: "a", dir: "/d" } });
    expect(await host.refusal("s1")).toBe("VOICE_AGENT_ONLY");
    expect(remoteCalls).toEqual([["C1", "1.1"]]);
  });
  it("without a Slack thread fails closed, and still names a captured cron identity", async () => {
    const { host, agent, remoteCalls } = mono({ thread: null });
    expect(await host.refusal("s1")).toBe("VOICE_UNAVAILABLE");
    expect(remoteCalls).toEqual([]);
    agent.identity = "U9";
    expect(await host.refusal("s1")).toBe("VOICE_AGENT_ONLY");
    expect(agent.identityCalls.at(-1)).toEqual(["s1", undefined, undefined]);
  });
  it("forwards holdIdle and its result", () => {
    const { host, agent } = mono();
    expect(host.holdIdle("s1", true)).toBe(true);
    agent.holdResult = false;
    expect(host.holdIdle("s1", false)).toBe(false);
    expect(agent.holds).toEqual([["s1", true], ["s1", false]]);
  });
  it("serves config, transcript dir, instructions and a runner on the agent", async () => {
    const { host, agent } = mono();
    expect(await host.config("s1")).toEqual(cfg);
    expect(await host.transcriptDir("s7")).toBe("/work/s7");
    expect(await host.instructions("s1", "b")).toBe(instructionsFrom(soul, "b"));
    await host.runner("s1").run("s1", "hello", { suppress: false, voice: true });
    expect(agent.sent).toEqual(["hello"]);
  });
});

describe("node voice host", () => {
  const base = {
    agent: new FakeAgent() as any, bindToken: () => {}, refresh: async (_j: string, t: string) => t + "+",
    lock: async <T>(_id: string, fn: (s: AbortSignal) => Promise<T>) => fn(new AbortController().signal), workingDir: async () => "/tmp",
    claims: (): { lock?: unknown; remote?: unknown; runAs?: string } | null => ({ lock: null, runAs: "agent" }),
  };
  const voice = { model: "openai/gpt-realtime", apiKey: "k", workbenchUrl: "https://wb.example.com", maxMinutes: 30, staleSeq: 3 };

  it("is unavailable while draining", async () => {
    const h = makeNodeVoiceHost({ ...base, currentJob: () => ({ jobId: "j", token: "t" }), bundle: async () => null, draining: () => true });
    expect(await h.refusal("s1")).toBe("VOICE_UNAVAILABLE");
  });
  it("is unavailable without a current job to refresh from", async () => {
    const h = makeNodeVoiceHost({ ...base, currentJob: () => undefined, bundle: async () => null, draining: () => false });
    expect(await h.refusal("s1")).toBe("VOICE_UNAVAILABLE");
  });
  it("refuses from the job token's claims, failing closed without them", async () => {
    const cases: Array<[ReturnType<typeof base.claims>, string | null]> = [
      [null, "VOICE_UNAVAILABLE"],
      [{ lock: null, runAs: "agent" }, null],
      [{ lock: { user: "U1", openScope: null }, runAs: "agent" }, "VOICE_AGENT_ONLY"],
      [{ lock: null, remote: { addr: "a", dir: "/d" }, runAs: "agent" }, "VOICE_AGENT_ONLY"],
      [{ lock: null, runAs: "user:U1" }, "VOICE_AGENT_ONLY"],
    ];
    for (const [claims, want] of cases) {
      const h = makeNodeVoiceHost({
        ...base, currentJob: () => ({ jobId: "j", token: "t" }), bundle: async () => null, draining: () => false,
        claims: () => claims,
      });
      expect(await h.refusal("s1")).toBe(want as any);
    }
  });
  it("reads voice config (incl. limits) from the bundle, never node env", async () => {
    process.env.SLAUDE_VOICE_MAX_MINUTES = "7";
    try {
      const h = makeNodeVoiceHost({ ...base, currentJob: () => ({ jobId: "j", token: "t" }), draining: () => false,
        bundle: async () => ({ voice, soulJson: null }) });
      const c = (await h.config("s1"))!;
      expect(c.apiKey).toBe("k");
      expect(c.maxMinutes).toBe(30);
      expect(c.staleSeq).toBe(3);
    } finally {
      delete process.env.SLAUDE_VOICE_MAX_MINUTES;
    }
  });
  it("has no config when the bundle has no voice block", async () => {
    const h = makeNodeVoiceHost({ ...base, currentJob: () => undefined, draining: () => false, bundle: async () => ({ voice: null, soulJson: null }) });
    expect(await h.config("s1")).toBeNull();
  });
  it("refusal has no side effect; the runner chains the job token through refresh before each turn", async () => {
    const agent = new FakeAgent();
    const bound: string[] = [];
    const refreshed: Array<[string, string]> = [];
    const signals: AbortSignal[] = [];
    const h = makeNodeVoiceHost({
      ...base, agent: agent as any, draining: () => false, bundle: async () => null,
      currentJob: () => ({ jobId: "j1", token: "t0" }),
      bindToken: (_id, t) => bound.push(t),
      refresh: async (j, t) => { refreshed.push([j, t]); return t + "+"; },
      lock: async (_id, fn) => { const ac = new AbortController(); signals.push(ac.signal); return fn(ac.signal); },
    });
    expect(await h.refusal("s1")).toBeNull();
    expect(refreshed).toEqual([]);
    const r = h.runner("s1");
    await r.run("s1", "a", { suppress: false, voice: true });
    await r.run("s1", "b", { suppress: true, voice: true });
    expect(refreshed).toEqual([["j1", "t0"], ["j1", "t0+"]]);
    expect(bound).toEqual(["t0+", "t0++"]);
    expect(agent.sent).toEqual(["a", "b"]);
    expect(signals.length).toBe(2);
  });
  it("a refused refresh surfaces as VoiceAuthLost", async () => {
    const h = makeNodeVoiceHost({
      ...base, draining: () => false, bundle: async () => null, currentJob: () => ({ jobId: "j1", token: "t0" }),
      refresh: async () => { throw new Error("401 label changed"); },
    });
    await expect(h.runner("s1").run("s1", "a", { suppress: false, voice: true })).rejects.toBeInstanceOf(VoiceAuthLost);
  });
  it("a runner with no job to chain from is auth lost", async () => {
    const h = makeNodeVoiceHost({ ...base, draining: () => false, bundle: async () => null, currentJob: () => undefined });
    await expect(h.runner("s1").run("s1", "a", { suppress: false, voice: true })).rejects.toBeInstanceOf(VoiceAuthLost);
  });
  it("instructions come from the bundle's soul; holdIdle forwards", async () => {
    const agent = new FakeAgent();
    const h = makeNodeVoiceHost({
      ...base, agent: agent as any, currentJob: () => undefined, draining: () => false,
      bundle: async () => ({ voice, soulJson: soul }),
    });
    expect(await h.instructions("s1", "b")).toBe(instructionsFrom(soul, "b"));
    expect(await h.transcriptDir("s1")).toBe("/tmp");
    agent.holdResult = false;
    expect(h.holdIdle("s1", true)).toBe(false);
    expect(agent.holds).toEqual([["s1", true]]);
  });
});

describe("drainVoiceCalls", () => {
  it("ends every call with node_drain", async () => {
    const calls = new VoiceCalls();
    const reasons: string[] = [];
    calls.endAll = async (r) => { reasons.push(r); };
    await drainVoiceCalls(calls, 1000);
    expect(reasons).toEqual(["node_drain"]);
  });
  it("gives up at the grace when a call's end hangs", async () => {
    const calls = new VoiceCalls();
    calls.endAll = () => new Promise<void>(() => {});
    const t0 = Date.now();
    await drainVoiceCalls(calls, 30);
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it("swallows an endAll failure", async () => {
    const calls = new VoiceCalls();
    calls.endAll = async () => { throw new Error("x"); };
    const err = spyOn(console, "error").mockImplementation(() => {});
    await expect(drainVoiceCalls(calls, 1000)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("voiceServersFor", () => {
  const host = (config: VoiceHost["config"]) => ({ config } as VoiceHost);
  it("mounts the voice server when the host has config", async () => {
    const s = await voiceServersFor("s1", host(async () => cfg), new VoiceCalls());
    expect(Object.keys(s)).toEqual([VOICE_MCP_NAME]);
  });
  it("mounts nothing without config", async () => {
    expect(await voiceServersFor("s1", host(async () => null), new VoiceCalls())).toEqual({});
  });
  it("mounts nothing (and does not throw) when config cannot be read", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(await voiceServersFor("s1", host(async () => { throw new Error("bundle fetch failed"); }), new VoiceCalls())).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
