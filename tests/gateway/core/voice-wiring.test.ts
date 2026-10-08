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
  SLAUDE_VOICE_WORKBENCH_URL: "https://wb.example.com",
};

function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}
afterEach(async () => {
  for (const k of Object.keys(VOICE_ENV)) delete process.env[k];
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

  /** A registered call that records how it was ended. */
  const fakeCall = () => {
    const stops: string[] = [];
    return { stops, call: { stop: async (r: string) => { stops.push(r); } } as any };
  };

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
        audio: { stream_url: "https://wb.example.com/s", clear_url: "https://wb.example.com/c", stream_token: "st" },
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toStartWith("VOICE_AGENT_ONLY");
    } finally {
      await s.dispose();
    }
  });
});
