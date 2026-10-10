import { describe, it, expect, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import {
  voiceRefusalFromClaims,
  makeMonoVoiceHost,
  makeNodeVoiceHost,
  type MonoThread,
  instructionsFrom,
  drainVoiceCalls,
  voiceServersFor,
} from "../../src/voice/hosts";
import { VOICE_MCP_NAME, voiceHandlers, type VoiceHost } from "../../src/agent/voice-mcp";
import { VoiceAuthLost } from "../../src/voice/runners";
import { VoiceCall, VoiceCalls } from "../../src/voice/call";
import { fakeChild, until } from "./fakes";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceConfig } from "../../src/voice/config";

/** A turn whose call was not cancelled. */
const no = () => false;

/** An agent that finishes every turn at once and records what it was asked. */
class FakeAgent extends EventEmitter {
  sent: string[] = [];
  holds: Array<[string, boolean]> = [];
  holdResult = true;
  identity: string | undefined = undefined;
  identityCalls: Array<[string, string | null | undefined, string | null | undefined]> = [];
  suppressNextTurn() {}
  isTurnInFlight() { return false; }
  isLive() { return true; }
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

/** A stand-in child script: if a host ever ran it, its marker would show. */
const markerDir = mkdtempSync(join(tmpdir(), "voice-hosts-"));
const markerEntry = join(markerDir, "marker-entry.ts");
writeFileSync(markerEntry, `process.stdout.write(JSON.stringify({ type: "log", level: "info", message: "MARKER-ENTRY-RAN" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "ended", reason: "stopped" }) + "\\n");
process.exit(0);
`);
/** Spawn through a host with an extra `entry` key and report what ran. */
async function spawnWithEntry(host: VoiceHost): Promise<string> {
  const child = host.spawn({ apiKey: "k", entry: markerEntry } as any);
  child.send({ type: "context", text: "not an init" });
  const got: unknown[] = [];
  for await (const m of child.messages) got.push(m);
  child.kill();
  return JSON.stringify(got);
}

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
    // Strict: an allowed call needs runAs "agent" AND an explicit lock claim.
    expect(voiceRefusalFromClaims({})).toBe("VOICE_UNAVAILABLE");
    expect(voiceRefusalFromClaims({ lock: null })).toBe("VOICE_UNAVAILABLE");
    expect(voiceRefusalFromClaims({ runAs: "agent" })).toBe("VOICE_UNAVAILABLE");
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
  function mono(o: { thread?: MonoThread | null; remote?: unknown; soul?: (t: MonoThread) => unknown | null } = {}) {
    const agent = new FakeAgent();
    const remoteCalls: Array<[string, string]> = [];
    const souls: MonoThread[] = [];
    const host = makeMonoVoiceHost({
      agent: agent as any,
      config: () => cfg,
      findThread: async () => (o.thread === undefined ? { channel: "C1", threadTs: "1.1", personaId: null } : o.thread),
      remoteTarget: async (c, t) => { remoteCalls.push([c, t]); return o.remote ?? null; },
      workingDir: async (sid) => `/work/${sid}`,
      soul: (t) => { souls.push(t); return o.soul ? o.soul(t) : soul; },
    });
    return { host, agent, remoteCalls, souls };
  }

  it("spawn passes only the provider key: the test-only entry seam cannot be reached", async () => {
    const out = await spawnWithEntry(mono().host);
    expect(out).not.toContain("MARKER-ENTRY-RAN");
    expect(out).toContain("loop_crashed");
  });

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
  it("is unavailable when the thread persona's soul cannot be resolved", async () => {
    const { host } = mono({ thread: { channel: "C1", threadTs: "1.1", personaId: "retired" }, soul: () => null });
    expect(await host.refusal("s1")).toBe("VOICE_UNAVAILABLE");
    await expect(host.instructions("s1", "b")).rejects.toThrow(/persona soul/);
  });
  it("speaks with the thread persona's soul", async () => {
    const ops = { identity: { name: "Ops Bot" }, values: [] };
    const { host, souls } = mono({ thread: { channel: "C1", threadTs: "1.1", personaId: "ops-bot" }, soul: (t) => (t.personaId === "ops-bot" ? ops : soul) });
    expect(await host.instructions("s1", "b")).toContain("You are Ops Bot");
    expect(souls.at(-1)).toEqual({ channel: "C1", threadTs: "1.1", personaId: "ops-bot" });
  });
  it("a lock appearing mid-call refuses the next injected turn before it is sent", async () => {
    const { host, agent } = mono();
    const r = host.runner("s1");
    await r.run("s1", "a", { suppress: false, voice: true, cancelled: no });
    expect(await host.stillAllowed("s1")).toBe(true);
    agent.identity = "U1"; // /1on1 lock row
    expect(await host.stillAllowed("s1")).toBe(false);
    await expect(r.run("s1", "b", { suppress: true, voice: true, cancelled: no })).rejects.toBeInstanceOf(VoiceAuthLost);
    expect(agent.sent).toEqual(["a"]);
  });
  it("an identity check that throws refuses the turn (fail closed)", async () => {
    const { host, agent } = mono();
    agent.resolveEffectiveIdentity = async () => { throw new Error("db down"); };
    const err = spyOn(console, "error").mockImplementation(() => {});
    await expect(host.runner("s1").run("s1", "a", { suppress: false, voice: true, cancelled: no })).rejects.toBeInstanceOf(VoiceAuthLost);
    expect(agent.sent).toEqual([]);
    err.mockRestore();
  });
  it("end to end: a throwing identity check sends nothing and ends the call auth_lost", async () => {
    const { host, agent } = mono();
    agent.resolveEffectiveIdentity = async () => { throw new Error("db down"); };
    const err = spyOn(console, "error").mockImplementation(() => {});
    const child = fakeChild();
    const call = new VoiceCall({ sessionId: "s1", runner: host.runner("s1"), child, transcriptDir: mkdtempSync(join(tmpdir(), "vh-")),
      holdIdle: () => true, onClosed: () => {} });
    const p = call.start({ callId: call.callId, audio: { streamUrl: "/s", clearUrl: "/c", headers: {}, sampleRate: 24000 },
      workbenchUrl: "https://wb.example.com", instructions: "x", provider: "openai", model: "m", maxMinutes: 120, staleSeq: 6 });
    child.push({ type: "started", callId: call.callId, sampleRate: 24000 });
    await p;
    child.push({ type: "delegate", id: "1", task: "x", asOf: 0 });
    await until(() => child.sent.some((m) => m.type === "stop"));
    expect(child.sent.at(-1)).toEqual({ type: "stop", reason: "auth_lost" });
    child.push({ type: "ended", reason: "auth_lost" });
    expect(await call.done).toBe("auth_lost");
    expect(agent.sent).toEqual([]);
    err.mockRestore();
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
    await host.runner("s1").run("s1", "hello", { suppress: false, voice: true, cancelled: no });
    expect(agent.sent).toEqual(["hello"]);
  });
});

describe("node voice host", () => {
  /** A token whose (unverified) payload carries these claims. */
  const tok = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  const decode = (t: string) => { try { return JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString()); } catch { return null; } };
  const AGENT = { job: "j1", lock: null, runAs: "agent" };
  const agentIdentity = { runAs: "agent", lock: null, remote: false };
  const base = {
    agent: new FakeAgent() as any, bindToken: () => {}, claims: decode,
    refresh: async (_j: string, t: string) => ({ jobToken: t + "+", identity: agentIdentity as unknown }),
    lock: async <T>(_id: string, fn: (s: AbortSignal) => Promise<T>) => fn(new AbortController().signal), workingDir: async () => "/tmp",
    tokenFor: (): string | undefined => tok(AGENT), bundle: async () => null, draining: () => false,
  };
  const voice = { model: "openai/gpt-realtime", apiKey: "k", workbenchUrl: "https://wb.example.com", maxMinutes: 30, staleSeq: 3 };

  it("is unavailable while draining", async () => {
    const h = makeNodeVoiceHost({ ...base, draining: () => true });
    expect(await h.refusal("s1")).toBe("VOICE_UNAVAILABLE");
  });
  it("spawn passes only the provider key: the test-only entry seam cannot be reached", async () => {
    const out = await spawnWithEntry(makeNodeVoiceHost(base));
    expect(out).not.toContain("MARKER-ENTRY-RAN");
    expect(out).toContain("loop_crashed");
  });
  it("is unavailable without a bound job token, or one without a job claim", async () => {
    expect(await makeNodeVoiceHost({ ...base, tokenFor: () => undefined }).refusal("s1")).toBe("VOICE_UNAVAILABLE");
    expect(await makeNodeVoiceHost({ ...base, tokenFor: () => tok({ lock: null, runAs: "agent" }) }).refusal("s1")).toBe("VOICE_UNAVAILABLE");
  });
  it("refuses from the job token's claims, failing closed without them", async () => {
    const cases: Array<[string, string | null]> = [
      ["garbage", "VOICE_UNAVAILABLE"],
      [tok({ job: "j1" }), "VOICE_UNAVAILABLE"],
      [tok(AGENT), null],
      [tok({ ...AGENT, lock: { user: "U1", openScope: null } }), "VOICE_AGENT_ONLY"],
      [tok({ ...AGENT, remote: { addr: "a", dir: "/d" } }), "VOICE_AGENT_ONLY"],
      [tok({ ...AGENT, runAs: "user:U1" }), "VOICE_AGENT_ONLY"],
    ];
    for (const [token, want] of cases) {
      expect(await makeNodeVoiceHost({ ...base, tokenFor: () => token }).refusal("s1")).toBe(want as any);
    }
  });
  it("reads voice config (incl. limits) from the bundle, never node env", async () => {
    process.env.SLAUDE_VOICE_MAX_MINUTES = "7";
    try {
      const h = makeNodeVoiceHost({ ...base, bundle: async () => ({ voice, soulJson: null }) });
      const c = (await h.config("s1"))!;
      expect(c.apiKey).toBe("k");
      expect(c.maxMinutes).toBe(30);
      expect(c.staleSeq).toBe(3);
    } finally {
      delete process.env.SLAUDE_VOICE_MAX_MINUTES;
    }
  });
  it("has no config when the bundle has no voice block", async () => {
    const h = makeNodeVoiceHost({ ...base, bundle: async () => ({ voice: null, soulJson: null }) });
    expect(await h.config("s1")).toBeNull();
  });
  it("refusal has no side effect; the runner chains the checked token through refresh before each turn", async () => {
    const agent = new FakeAgent();
    const bound: string[] = [];
    const refreshed: Array<[string, string]> = [];
    const signals: AbortSignal[] = [];
    const t0 = tok(AGENT);
    const h = makeNodeVoiceHost({
      ...base, agent: agent as any, tokenFor: () => t0,
      bindToken: (_id, t) => bound.push(t),
      refresh: async (j, t) => { refreshed.push([j, t]); return { jobToken: t + "+", identity: agentIdentity }; },
      lock: async (_id, fn) => { const ac = new AbortController(); signals.push(ac.signal); return fn(ac.signal); },
    });
    expect(await h.refusal("s1")).toBeNull();
    expect(refreshed).toEqual([]);
    expect(await h.stillAllowed("s1")).toBe(false); // no chain before the runner
    const r = h.runner("s1");
    await r.run("s1", "a", { suppress: false, voice: true, cancelled: no });
    await r.run("s1", "b", { suppress: true, voice: true, cancelled: no });
    expect(refreshed).toEqual([["j1", t0], ["j1", t0 + "+"]]);
    expect(bound).toEqual([t0 + "+", t0 + "++"]);
    expect(agent.sent).toEqual(["a", "b"]);
    expect(signals.length).toBe(2);
    expect(await h.stillAllowed("s1")).toBe(true);
  });
  it("a newer person-scoped job claimed for the session is never bound to a voice turn", async () => {
    const agentTok = tok(AGENT);
    const personTok = tok({ job: "j2", lock: { user: "U1", openScope: null }, runAs: "user:U1" });
    let current = agentTok;
    const refreshed: Array<[string, string]> = [];
    const bound: string[] = [];
    const h = makeNodeVoiceHost({
      ...base, tokenFor: () => current, bindToken: (_id, t) => bound.push(t),
      refresh: async (j, t) => { refreshed.push([j, t]); return { jobToken: `${j}-fresh`, identity: agentIdentity }; },
    });
    expect(await h.refusal("s1")).toBeNull();
    current = personTok; // job j2 (a /1on1 turn) bound for the session meanwhile
    await h.runner("s1").run("s1", "a", { suppress: false, voice: true, cancelled: no });
    expect(refreshed).toEqual([["j1", agentTok]]);
    expect(bound).toEqual(["j1-fresh"]);
  });
  it("an identity changed since the start ends the chain: nothing bound, no turn", async () => {
    const agent = new FakeAgent();
    const bound: string[] = [];
    let identity: unknown = agentIdentity;
    const h = makeNodeVoiceHost({
      ...base, agent: agent as any, bindToken: (_id, t) => bound.push(t),
      refresh: async (_j, t) => ({ jobToken: t + "+", identity }),
    });
    expect(await h.refusal("s1")).toBeNull();
    const r = h.runner("s1");
    await r.run("s1", "a", { suppress: false, voice: true, cancelled: no });
    for (const changed of [
      { runAs: "user:U1", lock: { user: "U1", openScope: null }, remote: false },
      undefined, // an older gateway reports no identity: fail closed
    ]) {
      identity = changed;
      const h2 = makeNodeVoiceHost({ ...base, agent: agent as any, refresh: async (_j, t) => ({ jobToken: t + "+", identity }) });
      expect(await h2.refusal("s2")).toBeNull();
      await expect(h2.runner("s2").run("s2", "x", { suppress: false, voice: true, cancelled: no })).rejects.toBeInstanceOf(VoiceAuthLost);
      expect(await h2.stillAllowed("s2")).toBe(false);
    }
    identity = { runAs: "agent", lock: null, remote: true };
    await expect(r.run("s1", "b", { suppress: false, voice: true, cancelled: no })).rejects.toBeInstanceOf(VoiceAuthLost);
    expect(agent.sent).toEqual(["a"]);
    expect(bound).toHaveLength(1);
    expect(await h.stillAllowed("s1")).toBe(false);
  });
  it("voice_start confirms the identity with one fresh refresh before spawning (lock set after dispatch)", async () => {
    const lockedLater = { runAs: "user:U1", lock: { user: "U1", openScope: null }, remote: false };
    for (const [identity, want] of [[lockedLater, "VOICE_AGENT_ONLY"], [undefined, "VOICE_UNAVAILABLE"]] as const) {
      const refreshed: string[] = [];
      const bound: string[] = [];
      const h = makeNodeVoiceHost({
        ...base, bundle: async () => ({ voice, soulJson: null }), bindToken: (_id, t) => bound.push(t),
        refresh: async (j, t) => { refreshed.push(j); return { jobToken: t + "+", identity }; },
      });
      let spawned = 0;
      const host = { ...h, spawn: () => { spawned++; throw new Error("must not spawn"); } };
      const calls = new VoiceCalls();
      const r = await voiceHandlers.start("s1", host, calls, {
        brief: "b",
        audio: { stream_url: "/s", clear_url: "/c", headers: {}, sample_rate: 24000 },
      });
      expect((r as { isError?: boolean }).isError).toBe(true);
      expect(r.content[0]!.text).toStartWith(want);
      expect(spawned).toBe(0);
      expect(refreshed).toEqual(["j1"]);
      expect(bound).toEqual([]);
    }
  });
  it("confirmStart passes for a thread still run by the agent, binding the fresh token", async () => {
    const bound: string[] = [];
    const h = makeNodeVoiceHost({ ...base, bindToken: (_id, t) => bound.push(t) });
    expect(await h.refusal("s1")).toBeNull();
    h.runner("s1");
    expect(await h.confirmStart("s1")).toBeNull();
    expect(bound).toHaveLength(1);
    expect(await makeNodeVoiceHost({ ...base }).confirmStart("s9")).toBe("VOICE_UNAVAILABLE"); // no chain
  });
  it("a refused refresh surfaces as VoiceAuthLost", async () => {
    const h = makeNodeVoiceHost({ ...base, refresh: async () => { throw new Error("401 label changed"); } });
    expect(await h.refusal("s1")).toBeNull();
    await expect(h.runner("s1").run("s1", "a", { suppress: false, voice: true, cancelled: no })).rejects.toBeInstanceOf(VoiceAuthLost);
  });
  it("a runner with no checked token is auth lost", async () => {
    const h = makeNodeVoiceHost({ ...base });
    await expect(h.runner("s1").run("s1", "a", { suppress: false, voice: true, cancelled: no })).rejects.toBeInstanceOf(VoiceAuthLost);
  });
  it("instructions come from the bundle's soul; holdIdle forwards and releases the chain", async () => {
    const agent = new FakeAgent();
    const h = makeNodeVoiceHost({ ...base, agent: agent as any, bundle: async () => ({ voice, soulJson: soul }) });
    expect(await h.instructions("s1", "b")).toBe(instructionsFrom(soul, "b"));
    expect(await h.transcriptDir("s1")).toBe("/tmp");
    await h.refusal("s1");
    await h.runner("s1").run("s1", "a", { suppress: false, voice: true, cancelled: no });
    expect(await h.stillAllowed("s1")).toBe(true);
    agent.holdResult = false;
    expect(h.holdIdle("s1", true)).toBe(false);
    h.holdIdle("s1", false);
    expect(agent.holds).toEqual([["s1", true], ["s1", false]]);
    expect(await h.stillAllowed("s1")).toBe(false);
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
