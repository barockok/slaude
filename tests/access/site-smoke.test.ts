/**
 * Slice C task 18, the scripted smoke. Under SLAUDE_ACCESS_SOURCE=shadow every
 * registered access site (src/access/sites.ts) is driven through its real code
 * path (a function call, or the sim-style gateway with a fake Slack transport)
 * and must count a decision. `scripts/verify-access-sites.sh` runs this file
 * and prints the per-site counts (SLAUDE_SMOKE_REPORT names the output file).
 *
 * A site that only a live Slack interaction or a live agent session reaches is
 * listed in LIVE_ONLY with the reason; the live smoke covers it before the flip.
 * The test fails when a site is neither counted nor listed, and when a listed
 * site did count (so the list cannot rot).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { __setGrantsReader } from "../../src/access/role";
import type { Grant } from "../../src/access/grants";
import { SITES } from "../../src/access/sites";
import { settleShadows } from "../../src/access/wired";
import { AgentManager } from "../../src/agent/manager";
import { decideProposal, mayDecide, restoreRetiredSkill } from "../../src/background/proposal-cards";
import * as Proposals from "../../src/db/proposals";
import { digestRecipientOf } from "../../src/background/digest";
import { personaManager } from "../../src/background/scheduler";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as Domain from "../../src/db/domain";
import * as Envs from "../../src/db/environments";
import * as OneOnOne from "../../src/db/one-on-one";
import * as Remote from "../../src/db/remote";
import { db } from "../../src/db/schema";
import { canDecidePermission } from "../../src/access/permission-auth";
import { ApprovalGate } from "../../src/gateway/slack/approval-gate";
import { handleEnvCommand, useEnvironment } from "../../src/gateway/core/env-command";
import { createGateway, type GatewayHandle } from "../../src/gateway/core/gateway";
import { handleRemoteCommand, decodeRemoteOffer, encodeRemoteOffer } from "../../src/gateway/core/remote-command";
import { createV1Api } from "../../src/gateway/api/index";
import { JOB_HEADER, mintJobToken } from "../../src/gateway/api/auth";
import { threadIdentity } from "../../src/gateway/core/thread-identity";
import { surfaceTools } from "../../src/gateway/core/surface-mcp";
import type { Surface } from "../../src/gateway/core/surface";
import type { Transport } from "../../src/gateway/core/transport";
import { canTriggerIngest } from "../../src/gateway/slack/ingest-auth";
import { isManagerOrApprover } from "../../src/gateway/slack/mcp-tools";
import { canChangeModel } from "../../src/gateway/slack/model-auth";
import { stampFromSenders } from "../../src/gateway/slack/permission-gate";
import { writeSoulFixture, WORLD } from "../../src/gateway/sim/soul-fixture";
import { classifyBrainOp, gatedBrainCall, resetStandingGrants, turnBrainScope, type GateInput } from "../../src/knowledge/gated-dispatch";
import { brainHandlers, type BrainToolDeps } from "../../src/knowledge/mcp-tools";
import { agentSourceId, resolveBrainScope, userSourceId } from "../../src/knowledge/scope";
import { memoryScopeFor, withClaimLock } from "../../src/memory/scope";
import { metrics } from "../../src/metrics";
import { checkProactive, type RestraintContext } from "../../src/proactive/restraint";
import { proactiveRule } from "../../src/proactive/rule-tool";
import { backgroundAgentId } from "../../src/background/skill-check";
import { activeRemoteTarget } from "../../src/remote/active";
import { SoulDataSchema } from "../../src/soul/data";
import { setSoulData } from "../../src/soul/extract";
import { mutateOverride } from "../../src/soul/overrides";
import { __setProactiveSoulSource, parseProactive } from "../../src/soul/proactive";
import { NO_PREFS } from "../../src/proactive/prefs";
import { fakeBrain } from "../memory/fake-brain";

const TEAM = "T";
const MGR = WORLD.manager;
const BAK = WORLD.backup!;

/** Sites only a live Slack interaction or a live agent session reaches, with the reason. */
export const LIVE_ONLY: Record<string, string> = {
  "gateway.brain_managers": "the managers callback of the kb tools, called when a kb-admin approval is decided inside a live agent turn",
  "gateway.background_managers": "the scheduler's managers callback, called by the background timer when it posts a digest or a person's proposals",
  "bridge.card_scope_lock_same": "cardScope inside the MCP bridge, reached when a node's tool call needs a connect card",
  "approval.resolve_default_managers": "the fallback of a named persona that has no approver or manager of its own; the smoke world's souls always name a manager",
  "pass_tools.profile_subject": "the background pass's memory tool, reached from a model-driven pass turn",
};

let ts = 40_000;
const nextTs = () => `${++ts}.1`;

function transport() {
  const posts: any[] = [];
  const handlers = new Map<string, (a: any) => Promise<void>>();
  const actions: { pattern: RegExp | string; fn: any }[] = [];
  const client = {
    auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: TEAM, url: "x" }) },
    chat: { postMessage: async (a: any) => (posts.push(a), { ok: true, ts: `${posts.length}.5` }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
  } as any;
  const t: Transport = { client, action: (p: any, fn: any) => actions.push({ pattern: p, fn }), event: (n: string, fn: any) => handlers.set(n, fn), use: () => {}, start: async () => {}, stop: async () => {} };
  const emit = async (n: string, a: any) => void (await handlers.get(n)?.(a));
  const click = async (actionId: string, userId: string, team: string | null = TEAM) => {
    for (const { pattern, fn } of actions) {
      if (typeof pattern === "string" ? pattern === actionId : pattern.test(actionId)) {
        await fn({ ack: async () => {}, action: { action_id: actionId }, body: { user: { id: userId }, ...(team ? { team: { id: team } } : {}) }, respond: async () => {} });
      }
    }
  };
  return { t, client, posts, emit, click };
}

const dm = (client: any, user: string, text: string, o: { thread?: string; channel?: string; type?: string } = {}) => ({
  event: { type: "message", channel: o.channel ?? "D_SMOKE", channel_type: o.type ?? "im", user, team: TEAM, ts: nextTs(), ...(o.thread ? { thread_ts: o.thread } : {}), text },
  client,
  context: { teamId: TEAM },
});

const slackGrant = (id: string, role: Grant["role"]): Grant => ({ subjectKind: "user", subjectId: id, role, deny: false, dmOnly: false, source: "console", subject: { service: "slack" } });
const gateOf = (o: Partial<GateInput> = {}): GateInput => ({
  userId: "U0ONE", teamId: TEAM, interactive: true, origin: "slack", lockedUser: null, lockedTeamId: TEAM, channelTrust: "trusted", isManager: false, agentId: "U0AGENT", threadKey: "C0EXAMPLE:1.1", ...o,
});

/** Each exerciser runs real code; an exerciser that throws fails the smoke, so a site is never "covered" by a swallowed error. */
const exercisers: Record<string, () => Promise<void>> = {
  async permissionAndApproval() {
    for (const clicker of ["U0ALICE", "U0LOCK", MGR, "U0RAND"]) await canDecidePermission({ clicker, initiator: "U0ALICE", lockOwner: "U0LOCK", persona: "default", channel: "C0EXAMPLE", teamId: TEAM, lockTeamId: TEAM });
    const handlers: { m: RegExp; fn: any }[] = [];
    const posts: any[] = [];
    const app: any = { action: (m: RegExp, fn: any) => handlers.push({ m, fn }), client: { chat: { postMessage: async (x: any) => (posts.push(x), { ok: true, ts: "1.1" }), update: async () => ({ ok: true }) } } };
    const gate = new ApprovalGate(app, ["U0APPR"], { gateBus: null });
    const fire = async (id: string, user: string) => {
      for (const h of handlers) if (h.m.test(id)) await h.fn({ ack: async () => {}, action: { action_id: id }, body: { user: { id: user }, team: { id: TEAM } }, respond: async () => {} });
    };
    const done = gate.request({ channel: "C0EXAMPLE", threadTs: "1.1", summary: "x", sessionId: "S-smoke", app: { teamId: TEAM } });
    for (let i = 0; i < 500 && posts.length === 0; i++) await Bun.sleep(1);
    const approve = posts[0].blocks.find((b: any) => b.type === "actions").elements.find((e: any) => e.action_id.includes("approve")).action_id;
    await fire(approve, "U0OTHER");
    await fire(approve, "U0APP");
    await done;
    // The poll path and a named persona's approver list.
    const poll = new ApprovalGate(app, ["U0APPR"], { gateBus: null });
    const { pendingId } = await poll.open({ channel: "C0EXAMPLE", threadTs: "1.1", summary: "poll", sessionId: "S-smoke-poll", app: { teamId: TEAM }, persona: "scout" });
    await fire(`slaude_appr:approve:${pendingId}`, "U0APPR");
  },
  async managedDefaultApproval() {
    // An agent.yaml default persona: its file's managers are the whole answer.
    const { __resetPersonaRegistry, setPersonaRegistry } = await import("../../src/persona/registry");
    const { __resetSoulDataMemo } = await import("../../src/soul/extract");
    setSoulData(SoulDataSchema.parse({ manager: { userId: MGR }, backupManager: { userId: BAK } }));
    setPersonaRegistry({
      lookupByUserId: () => null, lookupByName: () => null, list: () => [], isMultiPersonaMode: () => false, isManaged: () => true,
      tombstonedPersonaFor: () => null, defaultPersona: () => ({ definition: {} }),
    } as never);
    try {
      const app: any = { action: () => {}, client: { chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) } } };
      await new ApprovalGate(app, [], { gateBus: null }).open({ channel: "C0EXAMPLE", threadTs: "1.1", summary: "managed", sessionId: "S-smoke-managed", app: { teamId: TEAM } });
    } finally {
      __resetPersonaRegistry();
      __resetSoulDataMemo();
    }
  },
  async soulFields() {
    const soul = SoulDataSchema.parse({ manager: { userId: MGR }, backupManager: { userId: BAK }, approvers: [{ userId: "U0APP", scope: "anything", catchall: true }], dmAllowedUsers: ["U0DM"] });
    for (const u of [MGR, "U0DM", "U0X"]) {
      (await canChangeModel(u, soul, { persona: "default", teamId: TEAM }));
      (await canTriggerIngest(u, soul, { persona: "default", teamId: TEAM }));
      await isManagerOrApprover("default", u, "C0EXAMPLE", TEAM);
    }
    await mutateOverride({ field: "block", action: "add", value: "U0Z", by: MGR }, { managerId: MGR, teamId: TEAM });
    await db.run("DELETE FROM soul_overrides");
    setSoulData(soul);
    const surface: Surface = { id: "fake", capabilities: new Set() as any, reply: async () => ({ ref: "r" }), getHistory: async () => ({ messages: [], hasMore: false }), requestApproval: async () => ({ approved: true, by: MGR }) };
    const tool = surfaceTools(surface, { initiator: () => MGR, teamId: () => TEAM, auditContext: () => ({ persona: "default" }) as any }).find((d) => d.name === "soul_override")!;
    await tool.handler({ field: "trust", action: "list" });
  },
  async knowledgeAndMemory() {
    resetStandingGrants();
    const own = userSourceId("U0ONE");
    (await classifyBrainOp("put_page", { clientId: "x", sourceId: own, allowedSources: [own] }, gateOf({ lockedUser: "U0ONE" })));
    (await resolveBrainScope({ ...gateOf({ lockedUser: "U0ONE" }), kbSources: [] }));
    (await turnBrainScope(gateOf({ turnSenders: [{ userId: "U0ONE", teamId: TEAM, origin: "slack" }] }), []));
    const g = gateOf();
    await gatedBrainCall("sync_brain", { scope: (await resolveBrainScope({ ...g, kbSources: [] })), gate: g, managers: [MGR], describe: "x", requestApproval: async () => ({ approved: true, by: MGR }), call: async () => "ok" });
    const brain = fakeBrain();
    const deps = (gate: GateInput): BrainToolDeps => ({ scope: async () => (await resolveBrainScope({ ...gate, kbSources: [] })), gate: () => gate, managers: () => [], requestApproval: async () => ({ approved: true, by: MGR }), call: (n, p, s) => brain.call(n, p, s) });
    const sender = { userId: "U0ONE", teamId: TEAM, origin: "slack" as const };
    await brainHandlers.kb_memoize({ pages: [{ slug: "n", content: "hello", type: "person-note" } as never], target: "mine" }, deps(gateOf({ lockedUser: "U0ONE" })));
    await brainHandlers.kb_memoize({ pages: [{ slug: "profile", content: "hi", type: "profile" } as never], target: "profile", subject: "U0ONE" } as never, deps(gateOf({ turnSenders: [sender] })));
    const profileScope = (await resolveBrainScope({ ...gateOf({ turnSenders: [sender] }), kbSources: [] }));
    await brain.call("put_page", { slug: "people/u0one", content: "---\ntype: person-note\nas_of: 2026-10-20\nconfidence: told\nsubject: U0ONE\n---\nlikes diffs" }, { ...profileScope, sourceId: agentSourceId("U0AGENT"), allowedSources: [agentSourceId("U0AGENT")] });
    await brainHandlers.memory_about({ userId: "U0ONE" }, deps(gateOf({ turnSenders: [sender] })));
    (await memoryScopeFor(gateOf({ lockedUser: "U0ONE" })));
    (await memoryScopeFor(gateOf(), { runAsUser: "U0ONE" }));
    (await memoryScopeFor(gateOf({ userId: null, lockedUser: "U0TWO" }), { runAsUser: "U0ONE" }));
    (await withClaimLock(gateOf({ lockedUser: "U0TWO" }), "U0ONE"));
    (await withClaimLock(gateOf({ lockedUser: "U0ONE" }), "U0TWO"));
    (await mayDecide({ toKind: "person", toUser: "U0ONE" }, "U0ONE", [], { teamId: TEAM }));
    (await mayDecide({ toKind: "manager", toUser: null }, MGR, [MGR], { teamId: TEAM }));
    // A proposal card click that applies a write, and a retired skill restore.
    const agentId = await backgroundAgentId("default");
    const pid = await Proposals.insert({ agentId, kind: "team-fact", toKind: "manager", toUser: null, scope: "agent", payload: { pages: [{ slug: "fact", content: "x", type: "team-fact", confidence: "told" }], target: "shared" } as never, createdAt: Date.now() });
    await decideProposal({ id: pid, verb: "approve", by: MGR, from: { teamId: TEAM } as never }, { managers: async () => [MGR], call: brain.call, now: () => new Date() });
    const rid = await Proposals.recordSkillRetired({ agentId, payload: { slug: "s", retiredId: "r1" } as never, at: Date.now() } as never);
    await restoreRetiredSkill({ id: rid, by: MGR, from: { teamId: TEAM } as never }, { managers: async () => [MGR], now: () => new Date() });
  },
  async remoteAndEnv() {
    const ctx = (userId: string, o: { threadTs?: string; manager?: boolean; offer?: boolean } = {}) => ({
      teamId: TEAM, channelId: "C0EXAMPLE", threadTs: o.threadTs ?? "1.0", userId, sessionId: "S1", isManager: !!o.manager,
      reply: async () => {}, sayPrivately: async () => {}, reload: () => {}, reloadThread: async () => {}, ...(o.offer ? { offerConnect: async () => {} } : {}),
    });
    const deps: any = { preflight: async (i: any) => ({ ok: true, dir: `/abs${String(i.dir).replace(/^~/, "/h")}` }), cleanup: async () => {}, status: async () => "ok", provision: async () => {}, generateKeyPair: (c: string) => ({ privateKey: `P-${c}`, publicKey: `ssh-ed25519 A ${c}` }), validKey: () => true, listForeignThreadCrons: async () => 0 };
    await Remote.putKeyIfAbsent(TEAM, "U0OWNER", { privateKey: "PRIV", publicKey: "PUB" });
    await Remote.setTarget({ channelId: "C0EXAMPLE", threadTs: "9.0", teamId: TEAM, userId: "U0OWNER", addr: "tcA", dir: "/r", lockByRemote: true });
    await OneOnOne.lock({ channelId: "C0EXAMPLE", threadTs: "9.0", lockedUser: "U0OWNER", createdBy: "U0OWNER", teamId: TEAM });
    await activeRemoteTarget("C0EXAMPLE", "9.0");
    await threadIdentity("C0EXAMPLE", "9.0", async () => "U0OWNER");
    await handleRemoteCommand({ kind: "remote", action: "status" } as never, ctx("U0OWNER", { threadTs: "5.0", offer: true }) as never, deps);
    await OneOnOne.lock({ channelId: "C0EXAMPLE", threadTs: "5.0", lockedUser: "U0OWNER", createdBy: "U0OWNER", teamId: TEAM });
    await handleRemoteCommand({ kind: "remote", action: "status" } as never, ctx("U0OWNER", { threadTs: "5.0", offer: true }) as never, deps);
    const env = await Envs.createEnv({ teamId: TEAM, userId: "U0OWNER", name: "lap", kind: "tailcat", config: { addr: "tcA" }, defaultDir: "/r" });
    await useEnvironment(env, undefined, ctx("U0OTHER", { threadTs: "2.0" }) as never, deps);
    await handleEnvCommand({ kind: "env", action: "use", name: "lap" }, ctx("U0OWNER", { threadTs: "1.0" }) as never, deps);
    await handleEnvCommand({ kind: "env", action: "use", name: "lap" }, ctx("U0OWNER", { threadTs: "1.0" }) as never, deps);
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcA", dir: "/r" } as never, ctx("U0OWNER", { threadTs: "1.0" }) as never, deps);
    await handleEnvCommand({ kind: "env", action: "off" }, ctx("U0GUEST", { threadTs: "1.0" }) as never, deps);
    await handleEnvCommand({ kind: "env", action: "off" }, ctx("U0OWNER", { threadTs: "1.0" }) as never, deps);
    await handleEnvCommand({ kind: "env", action: "use", name: "lap" }, ctx("U0OWNER", { threadTs: "1.0" }) as never, deps);
    await handleEnvCommand({ kind: "env", action: "rm", name: "lap" }, ctx("U0OWNER", { threadTs: "1.0" }) as never, deps);
    // The environment endpoint serves a personal environment to its owner's turn only.
    const bound = (await activeRemoteTarget("C0EXAMPLE", "1.0")) ?? (await activeRemoteTarget("C0EXAMPLE", "9.0"));
    const api = createV1Api({ tools: {} as any });
    await Envs.createEnv({ teamId: TEAM, userId: "U0OWNER", name: "api", kind: "tailcat", config: { addr: "tcA" }, defaultDir: "/r" });
    await handleEnvCommand({ kind: "env", action: "use", name: "api" }, ctx("U0OWNER", { threadTs: "7.0" }) as never, deps);
    const t7 = await activeRemoteTarget("C0EXAMPLE", "7.0");
    void bound;
    if (t7?.env) {
      const tok = mintJobToken({ tenant: "t1", persona: "default", session: "S1", team: TEAM, channel: "C0EXAMPLE", thread: "7.0", initiator: "U0OWNER", scope: "turn", runAs: "user:U0OWNER", remote: { addr: t7.addr, dir: t7.dir, env: t7.env } } as any);
      await api.fetch(new Request("http://gw/v1/tenants/t1/remote-env", { headers: { authorization: "Bearer smoke-node-token", [JOB_HEADER]: tok } }));
    }
    (await decodeRemoteOffer(encodeRemoteOffer({ sessionId: "S", teamId: TEAM, channelId: "C", threadTs: "1.0", userId: "U0OWNER", issuedAt: Date.now() }), "U0OWNER"));
  },
  async backgroundAndRules() {
    personaManager("default");
    digestRecipientOf({ manager: { userId: MGR }, backupManager: {} });
    const on = parseProactive("## Proactive\n- Enabled: yes\n");
    const ctx: RestraintContext = { config: () => on, managerId: MGR, prefs: NO_PREFS, now: new Date("2026-10-26T12:00:00Z"), timeZone: "UTC", history: [] };
    checkProactive({ audience: "manager", recipient: MGR, topic: "deploys", text: "x" }, ctx);
    stampFromSenders([{ userId: "U0ONE", origin: "slack" }], { expect: "U0ONE" });
    __setProactiveSoulSource(() => "## Proactive\n- Highest: ask\n");
    const brain = fakeBrain();
    const sc: any = { client: {}, channel: "C0TEAM", threadTs: "100.0", inboundTs: "100.0", userId: "U0GUEST", teamId: TEAM, origin: "slack", turnSenders: () => [{ userId: "U0GUEST", teamId: TEAM, origin: "slack" }], requestApproval: async () => ({ approved: true, by: MGR }) };
    await proactiveRule(sc, { kind: "invoice emails", scope: "here", level: "ask", quote: "ask me first" }, { call: brain.call, now: () => new Date("2026-10-27T10:00:00Z") });
    __setProactiveSoulSource(null);
  },
  async gatewaySlashAndHandles() {
    const tr = transport();
    const agent = new AgentManager();
    agent.sendMessage = async () => {};
    const h: GatewayHandle = createGateway(agent, tr.t, {});
    const say = async (user: string, text: string, o: { thread?: string; channel?: string; type?: string } = {}) => tr.emit("message", dm(tr.client, user, text, o));
    await say(MGR, "hello");
    // /heartbeat: the backup is not the recipient, so the role is asked; the manager is the recipient.
    for (const who of [MGR, BAK, "U0NOBODY"]) {
      await say(who, "/heartbeat status");
      await say(who, "/heartbeat now");
    }
    // /1on1 and the lock gate, /mcp, /cron, /model, /soul, /bash, /env.
    const thread = nextTs();
    await say("U0MEMBER", "hi", { thread });
    await Remote.setTarget({ channelId: "D_SMOKE", threadTs: thread, teamId: TEAM, userId: "U0PREV", addr: "tcB", dir: "/r", lockByRemote: false });
    await say("U0MEMBER", "/1on1", { thread });
    await say("U0OTHER", "talking in someone's 1on1", { thread });
    await say(MGR, "talking in someone's 1on1", { thread });
    await say("U0OTHER", "/1on1 lock", { thread });
    await say(MGR, "/1on1 lock", { thread });
    await say("U0MEMBER", "/mcp", { thread });
    await say(MGR, "/mcp");
    await say(MGR, "/cron list");
    await say(MGR, "/model");
    await say(BAK, "/model");
    await say(MGR, "/soul list");
    await say(BAK, "/soul list");
    await say(MGR, "/bash echo smoke");
    await say(BAK, "/bash echo smoke");
    await say(MGR, "/env");
    await say(MGR, "/remote");
    // Handles the gateway exposes for the paths a live Slack session would take.
    const session = await agent.ensureSession({ team_id: TEAM, channel_id: "D_SMOKE", thread_ts: thread });
    await Remote.setTarget({ channelId: "D_SMOKE", threadTs: thread, teamId: TEAM, userId: "U0PREV", addr: "tcB", dir: "/r", lockByRemote: false });
    await h.__agentOneOnOne!(session.id, "lock");
    await h.__agentOneOnOne!(session.id, "off");
    await h.__agentConnect!(session.id, "svc");
    await OneOnOne.lock({ channelId: "D_SMOKE", threadTs: thread, lockedUser: "U0OTHER", createdBy: "U0OTHER", teamId: TEAM });
    await h.__agentConnect!(session.id, "svc");
    await OneOnOne.unlock("D_SMOKE", thread);
    await h.__brainGate!(session.id);
    await h.__postBridgeConnectCard!({ persona: "default", session: session.id, team: TEAM, channel: "D_SMOKE", thread, initiator: MGR, runAs: "agent", app: "A1" } as never, "svc", "global", "connect");
    const card = tr.posts.filter((p) => p.blocks).at(-1);
    const btn = card?.blocks?.find((b: any) => b.type === "actions")?.elements?.[0];
    if (btn) await tr.click(btn.action_id, MGR);
    // An initiator-scope card: the lock owner clicks.
    await OneOnOne.lock({ channelId: "D_SMOKE", threadTs: thread, lockedUser: "U0MEMBER", createdBy: "U0MEMBER", teamId: TEAM });
    const before = tr.posts.length;
    await h.__postBridgeConnectCard!({ persona: "default", session: session.id, team: TEAM, channel: "D_SMOKE", thread, initiator: "U0MEMBER", runAs: "user:U0MEMBER", app: "A1" } as never, "svc", "initiator", "connect");
    const card2 = tr.posts.slice(before).filter((p) => p.blocks).at(-1);
    const btn2 = card2?.blocks?.find((b: any) => b.type === "actions")?.elements?.[0];
    if (btn2) await tr.click(btn2.action_id, "U0MEMBER");
    await OneOnOne.unlock("D_SMOKE", thread);
    // A proposal card click goes through the registered handler.
    const agentId = await backgroundAgentId("default");
    const pid = await Proposals.insert({ agentId, kind: "team-fact", toKind: "manager", toUser: null, scope: "agent", payload: { pages: [{ slug: "f", content: "x", type: "team-fact", confidence: "told" }], target: "shared" } as never, createdAt: Date.now() });
    await tr.click(`slaude_prop:reject:${pid}`, MGR);
    await h.stop();
  },
};

let saved: string | undefined;
beforeAll(async () => {
  saved = process.env.SLAUDE_ACCESS_SOURCE;
  process.env.SLAUDE_ACCESS_SOURCE = "shadow";
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
  process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK = "1";
  process.env.SLAUDE_REMOTE = "1";
  process.env.SLAUDE_NODE_TOKEN = "smoke-node-token";
  process.env.SLAUDE_JOB_SECRET = "smoke-job-secret";
  __resetMasterKeyCache();
  writeSoulFixture(WORLD);
  __setGrantsReader(async () => [slackGrant("U0MEMBER", "member"), slackGrant("U0APP", "approver")]);
  spyOn(console, "warn").mockImplementation(() => {});
  await Domain._wipeForTests();
  await OneOnOne._wipeForTests();
  await Remote._wipeForTests();
  await db.run("DELETE FROM cron_jobs");
});
afterAll(() => {
  __setGrantsReader(null);
  if (saved === undefined) delete process.env.SLAUDE_ACCESS_SOURCE;
  else process.env.SLAUDE_ACCESS_SOURCE = saved;
  for (const k of ["SLAUDE_REMOTE", "SLAUDE_NODE_TOKEN", "SLAUDE_JOB_SECRET", "SLAUDE_OUTBOUND_DEV_LOOPBACK"]) delete process.env[k];
});

const decisionCounts = (): Map<string, number> => {
  const out = new Map<string, number>();
  for (const l of metrics.render().split("\n")) {
    if (!l.startsWith("slaude_access_decision_total{")) continue;
    const site = /site="([^"]+)"/.exec(l)?.[1];
    if (site) out.set(site, (out.get(site) ?? 0) + Number(l.split(" ").pop()));
  }
  return out;
};

describe("scripted smoke", () => {
  test("every site counts a decision under shadow, or is listed as live only", async () => {
    const before = decisionCounts();
    const failures: string[] = [];
    for (const [name, run] of Object.entries(exercisers)) {
      if (process.env.SLAUDE_SMOKE_VERBOSE) console.error(`[smoke] ${name}`);
      try {
        await run();
      } catch (e) {
        failures.push(`${name}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      }
      await settleShadows();
    }
    expect(failures).toEqual([]);
    const after = decisionCounts();
    const rows = SITES.map((s) => ({ id: s.id, group: s.group, kind: s.kind, count: (after.get(s.id) ?? 0) - (before.get(s.id) ?? 0), live: LIVE_ONLY[s.id] }));
    const out = process.env.SLAUDE_SMOKE_REPORT;
    if (out) {
      mkdirSync(out.replace(/\/[^/]*$/, "") || ".", { recursive: true });
      writeFileSync(out, JSON.stringify(rows, null, 2));
    }
    expect(rows.filter((r) => r.count === 0 && !r.live).map((r) => r.id)).toEqual([]);
    expect(rows.filter((r) => r.count > 0 && r.live).map((r) => `${r.id} counted but listed as live only`)).toEqual([]);
    expect(Object.keys(LIVE_ONLY).filter((id) => !SITES.some((s) => s.id === id))).toEqual([]);
  }, 60_000);

  test("under internal every exerciser still runs through its real path without throwing, and every site counts", async () => {
    process.env.SLAUDE_ACCESS_SOURCE = "internal";
    // A fresh world: the first run left its environments, locks and targets behind.
    await Domain._wipeForTests();
    await OneOnOne._wipeForTests();
    await Remote._wipeForTests();
    await db.run("DELETE FROM cron_jobs");
    for (const t of ["environment_bindings", "environments"]) await db.run(`DELETE FROM ${t}`).catch(() => {});
    try {
      const before = decisionCounts();
      const failures: string[] = [];
      for (const [name, run] of Object.entries(exercisers)) {
        try {
          await run();
        } catch (e) {
          failures.push(`${name}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        }
      }
      expect(failures).toEqual([]);
      const after = decisionCounts();
      const silent = SITES.filter((s) => (after.get(s.id) ?? 0) - (before.get(s.id) ?? 0) === 0 && !LIVE_ONLY[s.id]).map((s) => s.id);
      expect(silent).toEqual([]);
    } finally {
      process.env.SLAUDE_ACCESS_SOURCE = "shadow";
    }
  }, 60_000);
});
