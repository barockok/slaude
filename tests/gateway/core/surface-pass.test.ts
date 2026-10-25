import { describe, it, expect, afterEach } from "bun:test";
import { createGateway, type GatewayHandle } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import type { Surface, SurfaceCapability } from "../../../src/gateway/core/surface";
import { surfaceTools } from "../../../src/gateway/core/surface-mcp";
import { runtimeBaseline } from "../../../src/soul/loader";
import * as OneOnOne from "../../../src/db/one-on-one";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";

function fakeSurface(overrides: Partial<Surface> = {}): Surface {
  const s: any = {
    id: "fake",
    capabilities: new Set<SurfaceCapability>(["react"]),
    reply: async () => ({ ref: "R1" }),
    getHistory: async () => ({ messages: [], hasMore: false }),
    requestApproval: async () => ({ approved: true, by: "U1" }),
    react: async () => {},
    unreact: async () => {},
    ...overrides,
  };
  return s as Surface;
}

// Minimal transport + gateway harness (copied from gateway-branches.test.ts).
function transport() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const client = {
    auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
    chat: {
      postMessage: async () => ({ ok: true, ts: `${Date.now()}.1` }),
      update: async () => ({ ok: true }),
    },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
  } as any;
  const t: Transport = {
    client,
    action: () => {},
    event: (name: string, fn: any) => handlers.set(name, fn),
    use: () => {},
    start: async () => {},
    stop: async () => {},
  };
  const emit = async (name: string, args: any) => { await handlers.get(name)?.(args); };
  return { t, client, emit };
}

function makeGw() {
  const cap = transport();
  const agent = new AgentManager();
  let guard: ((id: string) => string | null) | undefined;
  const orig = agent.setStopGuard.bind(agent);
  agent.setStopGuard = ((fn: any) => { guard = fn; orig(fn); }) as any;
  agent.sendMessage = async () => {};
  const h: GatewayHandle = createGateway(agent, cap.t);
  return { ...cap, agent, h, guard: (id: string) => guard!(id) };
}

let tsCounter = 9100;
const nextTs = () => `${++tsCounter}.1`;
const dmArgs = (g: { client: any }, text: string, ts: string) => ({
  event: { type: "message", channel: "D_MGR", channel_type: "im", user: WORLD.manager, team: "T", ts, text },
  client: g.client,
  context: { teamId: "T" },
});

afterEach(async () => {
  await OneOnOne._wipeForTests();
});

describe("pass surface tool", () => {
  it("pass is always mounted, reacts when asked, posts nothing", async () => {
    const calls: string[] = [];
    const surface = fakeSurface({
      react: async ({ name }) => { calls.push(`react:${name}`); },
      reply: async () => { calls.push("reply"); return { ref: "r" }; },
    });
    const pass = surfaceTools(surface).find((d) => d.name === "pass")!;
    const r = await pass.handler({ reason: "talking about me, not to me", react: "eyes" });
    expect(calls).toEqual(["react:eyes"]);
    expect(r.content[0]!.text).toBe("passed");
  });

  it("pass is mounted on a surface without react, and does not react", async () => {
    const surface = fakeSurface({ capabilities: new Set<SurfaceCapability>(), react: undefined, unreact: undefined });
    const pass = surfaceTools(surface).find((d) => d.name === "pass");
    expect(pass).toBeDefined();
    const r = await pass!.handler({ reason: "not for me", react: "eyes" });
    expect(r.content[0]!.text).toBe("passed");
  });

  it("pass survives a failed reaction", async () => {
    const surface = fakeSurface({ react: async () => { throw new Error("invalid_name"); } });
    const r = await surfaceTools(surface).find((d) => d.name === "pass")!.handler({ reason: "x", react: "nope" });
    expect((r as any).isError).toBeUndefined();
    expect(r.content[0]!.text).toBe("passed (reaction failed)");
  });

  it("stop guard accepts a pass", async () => {
    writeSoulFixture(WORLD);
    const g = makeGw();
    const ts = nextTs();
    await g.emit("message", dmArgs(g, "hello", ts));
    const session = await g.agent.ensureSession({ team_id: "T", channel_id: "D_MGR", thread_ts: ts });
    expect(typeof g.guard(session.id)).toBe("string");
    g.agent.emit("event", { type: "toolCall", sessionId: session.id, tool: "mcp__slaude_surface__pass", input: { reason: "not for me" } } as any);
    await new Promise((r) => setTimeout(r, 10));
    expect(g.guard(session.id)).toBeNull();
  });

  it("the per-turn envelope offers reply or pass on the surface namespace", async () => {
    writeSoulFixture(WORLD);
    const g = makeGw();
    const sent: string[] = [];
    g.agent.sendMessage = async (_id: string, txt: string) => { sent.push(txt); };
    await g.emit("message", dmArgs(g, "hello", nextTs()));
    const env = sent.at(-1)!;
    expect(env).toContain("`mcp__slaude_surface__reply`");
    expect(env).toContain("`mcp__slaude_surface__pass`");
    expect(env).not.toContain("mcp__slaude_slack__reply");
  });

  it("stop guard text offers reply or pass", async () => {
    writeSoulFixture(WORLD);
    const g = makeGw();
    const ts = nextTs();
    await g.emit("message", dmArgs(g, "hello", ts));
    const session = await g.agent.ensureSession({ team_id: "T", channel_id: "D_MGR", thread_ts: ts });
    const text = g.guard(session.id)!;
    expect(text).toContain("`mcp__slaude_surface__reply`");
    expect(text).toContain("`mcp__slaude_surface__pass`");
    expect(text).not.toContain("Do not stop without replying");
  });

  it("stop guard still blocks a silent stop without pass", async () => {
    writeSoulFixture(WORLD);
    const g = makeGw();
    const ts = nextTs();
    await g.emit("message", dmArgs(g, "hello", ts));
    const session = await g.agent.ensureSession({ team_id: "T", channel_id: "D_MGR", thread_ts: ts });
    // A react alone is neither a reply nor a pass.
    g.agent.emit("event", { type: "toolCall", sessionId: session.id, tool: "mcp__slaude_surface__react", input: { name: "eyes" } } as any);
    await new Promise((r) => setTimeout(r, 10));
    expect(typeof g.guard(session.id)).toBe("string");
  });

  it("baseline says reply or pass", () => {
    const b = runtimeBaseline(true);
    expect(b).not.toContain("Every user message must result in at least one user-visible Slack tool call");
    expect(b).toContain("mcp__slaude_surface__pass");
  });
});
