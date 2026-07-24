import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  agentIdSync, setAgentId, resetAgentId, resolveAgentId, agentIdReady, agentScope,
} from "../src/knowledge/agent-identity";
import { AGENT_SOURCE, agentSourceId } from "../src/knowledge/scope";

const ENV = "SLAUDE_AGENT_ID";
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env[ENV];
  delete process.env[ENV];
  resetAgentId();
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = prevEnv;
  resetAgentId();
});

describe("agentIdSync", () => {
  test("falls back to 'default' with no cache and no env", () => {
    expect(agentIdSync()).toBe("default");
  });
  test("uses SLAUDE_AGENT_ID (trimmed) when set", () => {
    process.env[ENV] = "  U_ENV  ";
    expect(agentIdSync()).toBe("U_ENV");
  });
  test("cached value wins over env", () => {
    setAgentId("U_CACHE");
    process.env[ENV] = "U_ENV";
    expect(agentIdSync()).toBe("U_CACHE");
  });
  test("blank env is ignored → default", () => {
    process.env[ENV] = "   ";
    expect(agentIdSync()).toBe("default");
  });
});

describe("setAgentId / resetAgentId", () => {
  test("setAgentId pins (trimmed); resetAgentId clears it", () => {
    setAgentId("  U_PIN  ");
    expect(agentIdSync()).toBe("U_PIN");
    resetAgentId();
    expect(agentIdSync()).toBe("default");
  });
});

describe("resolveAgentId", () => {
  test("env override wins immediately — authTest never called", async () => {
    process.env[ENV] = "U_ENV";
    let called = false;
    const id = await resolveAgentId(async () => { called = true; return { user_id: "U_AUTH" }; });
    expect(id).toBe("U_ENV");
    expect(called).toBe(false);
  });
  test("resolves the auth.test user_id when no env", async () => {
    const id = await resolveAgentId(async () => ({ user_id: "U_BOT" }));
    expect(id).toBe("U_BOT");
    expect(agentIdSync()).toBe("U_BOT"); // cached
  });
  test("empty user_id falls back to 'default'", async () => {
    const id = await resolveAgentId(async () => ({ user_id: "" }));
    expect(id).toBe("default");
  });
  test("authTest throwing falls back to agentIdSync()", async () => {
    const id = await resolveAgentId(async () => { throw new Error("boom-auth"); });
    expect(id).toBe("default");
  });
  test("cached short-circuits — authTest not called again", async () => {
    setAgentId("U_PRE");
    let called = false;
    const id = await resolveAgentId(async () => { called = true; return { user_id: "U_AUTH" }; });
    expect(id).toBe("U_PRE");
    expect(called).toBe(false);
  });
  test("in-flight resolution is reused (idempotent)", async () => {
    let calls = 0;
    const auth = async () => { calls++; return { user_id: "U_ONCE" }; };
    const [a, b] = await Promise.all([resolveAgentId(auth), resolveAgentId(auth)]);
    expect(a).toBe("U_ONCE");
    expect(b).toBe("U_ONCE");
    expect(calls).toBe(1);
  });
});

describe("agentIdReady", () => {
  test("returns cached immediately", async () => {
    setAgentId("U_C");
    expect(await agentIdReady()).toBe("U_C");
  });
  test("resolves env when set (and caches it)", async () => {
    process.env[ENV] = "U_ENV";
    expect(await agentIdReady()).toBe("U_ENV");
    expect(agentIdSync()).toBe("U_ENV");
  });
  test("awaits the in-flight resolution when one exists", async () => {
    const p = resolveAgentId(async () => ({ user_id: "U_FLIGHT" }));
    expect(await agentIdReady()).toBe("U_FLIGHT");
    await p;
  });
  test("falls back to sync default when nothing is wired", async () => {
    expect(await agentIdReady()).toBe("default");
  });
});

describe("agentScope", () => {
  test("writes the per-agent slice; reads it plus the legacy agent source", () => {
    setAgentId("U_ME");
    const s = agentScope();
    expect(s.clientId).toBe("U_ME");
    expect(s.sourceId).toBe(agentSourceId("U_ME"));
    expect(s.allowedSources).toEqual([agentSourceId("U_ME"), AGENT_SOURCE]);
  });
});
