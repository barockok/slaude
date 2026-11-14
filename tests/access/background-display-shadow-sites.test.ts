/**
 * Slice C task 18: background recipients, the proactive rule tool and /bash go
 * through the shadow seam and keep the legacy answer under every source mode
 * and a broken resolver or engine. The recipient sites have no workspace on
 * their call, so they count `no_team` and never reach the engine.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { __setGrantsReader } from "../../src/access/role";
import { settleShadows } from "../../src/access/wired";
import { AgentManager } from "../../src/agent/manager";
import { createGateway } from "../../src/gateway/core/gateway";
import { digestRecipientOf } from "../../src/background/digest";
import { personaManager } from "../../src/background/scheduler";
import * as Actor from "../../src/refs/actor";
import * as OneOnOne from "../../src/db/one-on-one";
import { writeSoulFixture, WORLD } from "../../src/gateway/sim/soul-fixture";
import type { SlackContext } from "../../src/gateway/slack/mcp-tools";
import { agentSourceId } from "../../src/knowledge/scope";
import { backgroundAgentId } from "../../src/background/skill-check";
import { proactiveRule } from "../../src/proactive/rule-tool";
import { __setProactiveSoulSource } from "../../src/soul/proactive";
import { fakeBrain } from "../memory/fake-brain";
import { count, compared, decisions, legacyUnderEveryMode, sameAsLegacyBaseline, useShadowEnv } from "../helpers/shadow-modes";

useShadowEnv({
  before: () => {
    writeSoulFixture(WORLD);
    __setGrantsReader(async () => []);
  },
  after: () => __setGrantsReader(null),
});

describe("recipient sites with no workspace", () => {
  const scenario = async () => ({
    manager: personaManager("default"),
    digest: digestRecipientOf({ manager: { userId: "U0MGR" }, backupManager: { userId: "U0BAK" } }),
    digestBackup: digestRecipientOf({ manager: {}, backupManager: { userId: "U0BAK" } }),
    digestNone: digestRecipientOf({ manager: {}, backupManager: {} }),
  });
  legacyUnderEveryMode("the soul's manager, backup or nobody", scenario, { manager: WORLD.manager, digest: "U0MGR", digestBackup: "U0BAK", digestNone: null });

  test("each counts a decision and no_team, never calls the resolver", async () => {
    const acting = spyOn(Actor, "actingUser");
    await scenario();
    await settleShadows();
    for (const site of ["scheduler.persona_manager", "digest.recipient"]) {
      expect(decisions(site)).toBeGreaterThan(0);
      expect(count("slaude_access_shadow_total", { site, outcome: "no_team" })).toBeGreaterThan(0);
      expect(compared(site)).toBe(0);
    }
    expect(acting).not.toHaveBeenCalled();
  });
});

describe("proactive_rule", () => {
  const NOW = new Date("2026-10-27T10:00:00Z");
  const SOUL = ["## Proactive", "- Highest: ask", "", "## Channel <#C0TEAM>", "### Proactive", "- Highest: act", ""].join("\n");
  let brain = fakeBrain();
  let source = "";
  beforeAll(async () => {
    writeSoulFixture(WORLD);
    __setProactiveSoulSource(() => SOUL);
    source = agentSourceId(await backgroundAgentId("default"));
  });
  afterAll(() => __setProactiveSoulSource(null));

  const ctx = (userId: string, over: Partial<SlackContext> = {}): SlackContext => ({
    client: {} as any, channel: "C0TEAM", threadTs: "100.0", inboundTs: "100.0", userId, teamId: "T0EXAMPLE", origin: "slack",
    turnSenders: () => [{ userId, teamId: "T0EXAMPLE", origin: "slack" }], ...over,
  });
  const run = async (c: SlackContext, level: "ask" | "ignore", scope: "here" | "global") => {
    const r = await proactiveRule(c, { kind: "invoice emails", scope, level, quote: "ask me first" }, { call: brain.call, now: () => NOW });
    return { err: !!r.isError, text: r.content[0]!.text.slice(0, 60) };
  };
  const scenario = async () => {
    brain = fakeBrain();
    await OneOnOne._wipeForTests();
    __setGrantsReader(async () => []);
    // Order matters: a rule already at `ask` is not a raise any more.
    const stranger = await run(ctx("U0GUEST", { requestApproval: async () => ({ approved: true, by: "U0GUEST" }) }), "ask", "here");
    const cardByManager = await run(ctx("U0GUEST", { requestApproval: async () => ({ approved: true, by: WORLD.manager }) }), "ask", "here");
    const out = {
      stranger,
      cardByManager,
      manager: await run(ctx(WORLD.manager), "ignore", "here"),
      globalByStranger: await run(ctx("U0GUEST", { channel: "D0DM00001", threadTs: "200.0" }), "ask", "global"),
    };
    void source;
    return out;
  };
  sameAsLegacyBaseline("approvers and own-turn compares", scenario, (b) => {
    expect(b.stranger.err).toBe(true);
    expect(b.cardByManager.err).toBe(false);
    expect(b.manager.err).toBe(false);
    expect(b.globalByStranger.err).toBe(true);
  });

  test("counts decisions at each site", async () => {
    await scenario();
    await settleShadows();
    for (const site of ["rule_tool.approvers", "rule_tool.own_turn", "rule_tool.can_approve"]) expect(decisions(site)).toBeGreaterThan(0);
    expect(compared("rule_tool.approvers")).toBeGreaterThan(0);
  });
});

describe("/bash and the bridge connect card through the gateway", () => {
  const TEAM = "T";
  // Event timestamps are deduplicated by the gateway, so every scenario run needs fresh ones.
  let n = 70_000;
  async function gatewayScenario(): Promise<Record<string, string[]>> {
    writeSoulFixture(WORLD);
    __setGrantsReader(async () => []);
    const posts: any[] = [];
    const handlers = new Map<string, (a: any) => Promise<void>>();
    const client = {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: TEAM, url: "x" }) },
      chat: { postMessage: async (a: any) => (posts.push(a), { ok: true, ts: `${posts.length}.5` }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
      assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    } as any;
    const t = { client, action: () => {}, event: (n: string, fn: any) => handlers.set(n, fn), use: () => {}, start: async () => {}, stop: async () => {} } as any;
    const agent = new AgentManager();
    agent.sendMessage = async () => {};
    const h = createGateway(agent, t, {});
    const out: Record<string, string[]> = {};
    for (const [who, user] of [["manager", WORLD.manager], ["backup", WORLD.backup!], ["member", "U0MEMBER"]] as const) {
      const before = posts.length;
      await handlers.get("message")!({ event: { type: "message", channel: "D_BASH", channel_type: "im", user, team: TEAM, ts: `${++n}.1`, text: "/bash echo shadow-smoke" }, client, context: { teamId: TEAM } });
      out[who] = posts.slice(before).map((p) => String(p.text).slice(0, 40));
    }
    const before = posts.length;
    await h.__postBridgeConnectCard!({ persona: "default", session: "s", team: TEAM, channel: "D_BASH", thread: "1.5", initiator: WORLD.manager, runAs: "agent", app: "A1" } as never, "svc", "global", "connect");
    out.card = posts.slice(before).map((p) => String(p.text).slice(0, 30));
    await h.stop();
    return out;
  }
  sameAsLegacyBaseline("/bash role and the connect notify target", gatewayScenario, (b) => {
    expect(b.manager!.join()).toContain("shadow-smoke");
    expect(b.backup!.join()).toContain("shadow-smoke");
    expect(b.member!.join()).not.toContain("shadow-smoke");
    expect(b.card!.length).toBe(1);
  });

  test("both sites count decisions and compare", async () => {
    await gatewayScenario();
    await settleShadows();
    for (const site of ["gateway.bash.role", "gateway.connect_notify_target"]) {
      expect(decisions(site)).toBeGreaterThan(0);
      expect(compared(site)).toBeGreaterThan(0);
    }
  });
});
