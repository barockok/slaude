/**
 * The skills layout contract between the gateway and the nodes (WS-C §4.3.1).
 * Both mount one $SLAUDE_HOME. The gateway lists and writes skills under
 *   $SLAUDE_HOME/skills/<slug>/SKILL.md                    (global)
 *   $SLAUDE_HOME/personas/<name>/skills/<slug>/SKILL.md    (a persona's overlay)
 * the runtime bundle names the same roots, and a node's SDK discovers the
 * global root through the plugin mounted at $SLAUDE_HOME (<plugin>/skills/).
 * Moving either root, or one side's idea of it, fails here.
 */
import { afterAll, beforeAll, describe, expect, test, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realSdk = await import("@anthropic-ai/claude-agent-sdk");
const realQuery = realSdk.query;
let captured: any[] = [];
let fakeActive = false;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...realSdk,
  query: (args: { prompt: AsyncIterable<any>; options: any }) => {
    if (!fakeActive) return realQuery(args as any);
    captured.push(args.options);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const _ of args.prompt) {
          yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
          yield { type: "result", subtype: "success", is_error: false };
        }
      },
      setPermissionMode: async () => ({}),
      mcpServerStatus: async () => [],
      interrupt: async () => {},
    };
  },
}));

const { paths, ensureHome } = await import("../src/config/home");
const { globalSkillsRoot, personaSkillsRoot, skillRootsFor } = await import("../src/skills/loader");
const { skillOps } = await import("../src/skills/mcp-tools");
const { handleTenantRuntime } = await import("../src/gateway/api/tenants");
const { AgentManager } = await import("../src/agent/manager");

const ENV = ["SLAUDE_AUTO_EVOLVE", "SLAUDE_IDLE_MINUTES"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  ensureHome();
  fakeActive = true;
  process.env.SLAUDE_AUTO_EVOLVE = "0";
  process.env.SLAUDE_IDLE_MINUTES = "0";
});
afterAll(() => {
  fakeActive = false;
  rmSync(join(paths.personas, "layout-ana"), { recursive: true, force: true });
  rmSync(join(paths.skills, "layout-global"), { recursive: true, force: true });
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("skills layout contract", () => {
  test("the two roots sit where the contract says, under $SLAUDE_HOME", () => {
    expect(globalSkillsRoot()).toBe(join(paths.home, "skills"));
    expect(personaSkillsRoot("layout-ana")).toBe(join(paths.home, "personas", "layout-ana", "skills"));
    expect(skillRootsFor()).toEqual([join(paths.home, "skills")]);
    expect(skillRootsFor("default")).toEqual([join(paths.home, "skills")]);
    expect(skillRootsFor("layout-ana")).toEqual([join(paths.home, "skills"), join(paths.home, "personas", "layout-ana", "skills")]);
  });

  test("the gateway lists a skill written at either literal path, with its provenance", () => {
    mkdirSync(join(paths.home, "skills", "layout-global"), { recursive: true });
    writeFileSync(join(paths.home, "skills", "layout-global", "SKILL.md"), "---\nname: g\n---\nbody\n");
    mkdirSync(join(paths.home, "personas", "layout-ana", "skills", "layout-own"), { recursive: true });
    writeFileSync(join(paths.home, "personas", "layout-ana", "skills", "layout-own", "SKILL.md"), "---\nname: o\n---\nbody\n");
    const by = new Map(skillOps.list("layout-ana").map((s) => [s.slug, s.source]));
    expect(by.get("layout-global")).toBe("global");
    expect(by.get("layout-own")).toBe("persona");
  });

  test("the runtime bundle a node receives names the same roots", async () => {
    // A filesystem persona (tier 2) and the default persona (tier 3).
    mkdirSync(join(paths.personas, "layout-ana"), { recursive: true });
    writeFileSync(join(paths.personas, "layout-ana", "config.json"), JSON.stringify({ slackUserId: "ULAYOUT", name: "layout-ana" }));
    writeFileSync(join(paths.personas, "layout-ana", "SOUL.md"), "soul");
    const { __resetPersonaRegistry } = await import("../src/persona/registry");
    __resetPersonaRegistry();
    const bundle = async (p: string) =>
      (await (await handleTenantRuntime(new Request("http://gw/x"), "default", p)).json()) as { skillsPaths: string[] };
    expect((await bundle("layout-ana")).skillsPaths).toEqual(skillRootsFor("layout-ana"));
    expect((await bundle("default")).skillsPaths).toEqual(skillRootsFor());
  });

  test("a session's SDK discovers the global root through the plugin at $SLAUDE_HOME", async () => {
    captured = [];
    const mgr = new AgentManager();
    const events: any[] = [];
    mgr.on("event", (e: any) => events.push(e));
    const row = { id: "s-layout", model: "", working_dir: mkdtempSync(join(tmpdir(), "slaude-layout-")), permission_mode: "default",
      persona_id: "default", engaged: 1, claude_started: 0, status: "idle", title: null, created_at: 0, updated_at: 0,
      slack_team_id: "T1", slack_channel_id: "C1", slack_thread_ts: "1.1" };
    mgr.setSessionStore({
      findById: async () => row, findByThread: async () => row, createForThread: async () => row,
      markStarted: async () => {}, clearStarted: async () => {}, setStatus: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
    } as any);
    mgr.setPersonaSoulResolver(async () => ({ soulMd: "soul", soulJson: null }));
    mgr.setSessionLockResolver(async () => null);
    mgr.setMemoryProvider({ prefetch: async () => null, syncTurn: async () => {} });
    await mgr.sendMessage(row.id, "hi");
    const t0 = Date.now();
    while (!events.some((e) => e.type === "done" || e.type === "error") && Date.now() - t0 < 3000) await Bun.sleep(5);
    mgr.reload(row.id);
    const plugin = (captured[0].plugins as Array<{ type: string; path: string }>).find((p) => p.path === paths.home);
    expect(plugin).toBeDefined();
    expect(join(plugin!.path, "skills")).toBe(globalSkillsRoot());
  });
});
