/**
 * Mono voice wiring: the voice server mounts only when voice is enabled AND
 * configured, and a /1on1-locked thread (the session runs as a person) is
 * refused through the real lock row.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { SimSession } from "../../../src/gateway/sim/engine";
import * as Sessions from "../../../src/db/sessions";
import * as OneOnOne from "../../../src/db/one-on-one";
import { VOICE_MCP_NAME } from "../../../src/agent/voice-mcp";

const VOICE_ENV = {
  SLAUDE_VOICE_ENABLED: "1",
  SLAUDE_VOICE_API_KEY: "test-key",
  SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS: "https://wb.example.com",
};

function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}
afterEach(async () => {
  for (const k of [...Object.keys(VOICE_ENV), "SLAUDE_VOICE_WORKBENCH_URL"]) delete process.env[k];
  await OneOnOne._wipeForTests();
});

async function callTool(cfg: any, name: string, args: Record<string, unknown>): Promise<any> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(serverT);
  const client = new Client({ name: "t", version: "0.0.0" });
  await client.connect(clientT);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

async function sessionWith(thread: string) {
  const s = await SimSession.create({ agent: "stub", layer: "trusted", as: "member" });
  s.thread = thread;
  await s.send({ text: "hello" });
  const row = await Sessions.findByThread({ team_id: "T0SIM", channel_id: "C0TEAM", thread_ts: thread });
  return { s, sid: row!.id };
}

describe("mono voice wiring", () => {
  it("does not mount the voice server when voice is off", async () => {
    const { s, sid } = await sessionWith("T-VOICE-OFF");
    try {
      expect((await s.handle.__resolveMcp(sid))![VOICE_MCP_NAME]).toBeUndefined();
    } finally {
      await s.dispose();
    }
  });

  it("does not mount it when enabled but not configured", async () => {
    setEnv({ SLAUDE_VOICE_ENABLED: "1" });
    const { s, sid } = await sessionWith("T-VOICE-NOCFG");
    try {
      expect((await s.handle.__resolveMcp(sid))![VOICE_MCP_NAME]).toBeUndefined();
    } finally {
      await s.dispose();
    }
  });

  it("deny by default: enabled with a key but no audio allowlist does not mount it, and says why", async () => {
    const { __resetVoiceConfigLogs } = await import("../../../src/voice/config");
    __resetVoiceConfigLogs();
    setEnv({ SLAUDE_VOICE_ENABLED: "1", SLAUDE_VOICE_API_KEY: "test-key" });
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
    let s: Awaited<ReturnType<typeof sessionWith>>["s"] | undefined;
    try {
      const made = await sessionWith("T-VOICE-NOACL");
      s = made.s;
      expect((await s.handle.__resolveMcp(made.sid))![VOICE_MCP_NAME]).toBeUndefined();
    } finally {
      console.warn = warn;
      await s?.dispose();
    }
    expect(warned.filter((l) => l.includes("SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS")).length).toBe(1);
  });

  it("the deprecated SLAUDE_VOICE_WORKBENCH_URL alone still mounts it", async () => {
    setEnv({ SLAUDE_VOICE_ENABLED: "1", SLAUDE_VOICE_API_KEY: "test-key", SLAUDE_VOICE_WORKBENCH_URL: "https://wb.example.com/ui" });
    const warn = console.warn;
    console.warn = () => {};
    let s: Awaited<ReturnType<typeof sessionWith>>["s"] | undefined;
    try {
      const made = await sessionWith("T-VOICE-ALIAS");
      s = made.s;
      expect((await s.handle.__resolveMcp(made.sid))![VOICE_MCP_NAME]).toBeDefined();
    } finally {
      console.warn = warn;
      await s?.dispose();
    }
  });

  /** A registered call that records how it was ended. */
  const fakeCall = () => {
    const stops: string[] = [];
    const says: string[] = [];
    return { stops, says, call: { say: (t: string) => { says.push(t); }, stop: async (r: string) => { stops.push(r); } } as any };
  };

  it("mono shutdown ends every live call (goodbye, then node_drain) before the transport stops", async () => {
    setEnv(VOICE_ENV);
    const { s, sid } = await sessionWith("T-VOICE-SHUTDOWN");
    const f = fakeCall();
    s.handle.__voiceCalls!.add(sid, f.call);
    await s.dispose();
    expect(f.says.length).toBe(1);
    expect(f.stops).toEqual(["node_drain"]);
  });

  it("a session exit ends that session's call session_rebooted", async () => {
    setEnv(VOICE_ENV);
    const { s, sid } = await sessionWith("T-VOICE-EXIT");
    try {
      const f = fakeCall();
      s.handle.__voiceCalls!.add(sid, f.call);
      (s.agent as any).emit("sessionExit", "some-other-session");
      expect(f.stops).toEqual([]);
      (s.agent as any).emit("sessionExit", sid);
      expect(f.stops).toEqual(["session_rebooted"]);
    } finally {
      s.handle.__voiceCalls!.remove(sid);
      await s.dispose();
    }
  });

  it("with voice off nothing listens for session exit", async () => {
    const { s, sid } = await sessionWith("T-VOICE-EXIT-OFF");
    try {
      const f = fakeCall();
      s.handle.__voiceCalls!.add(sid, f.call);
      (s.agent as any).emit("sessionExit", sid);
      expect(f.stops).toEqual([]);
    } finally {
      s.handle.__voiceCalls!.remove(sid);
      await s.dispose();
    }
  });

  it("mounts it when enabled and configured; a /1on1-locked thread is refused", async () => {
    setEnv(VOICE_ENV);
    const { s, sid } = await sessionWith("T-VOICE-ON");
    try {
      await s.send({ text: "/1on1" });
      expect(await OneOnOne.find("C0TEAM", "T-VOICE-ON")).not.toBeNull();
      const servers = (await s.handle.__resolveMcp(sid))!;
      expect(servers[VOICE_MCP_NAME]).toBeDefined();
      const r = await callTool(servers[VOICE_MCP_NAME], "voice_start", {
        brief: "standup",
        audio: { stream_url: "https://wb.example.com/s", clear_url: "https://wb.example.com/c", headers: { "X-Browser-Session": "rk" } },
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toStartWith("VOICE_AGENT_ONLY");
    } finally {
      await s.dispose();
    }
  });
});
