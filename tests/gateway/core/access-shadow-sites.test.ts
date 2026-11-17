/**
 * Slice C task 13: the gateway's admission, role and 1on1 lock sites run through
 * the shadow seam and keep returning the legacy answer. Each scenario runs under
 * every source mode and with the resolver or the engine broken or disagreeing,
 * and the decisions (what reached the agent) must be identical.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { __setGrantsReader } from "../../../src/access/role";
import type { Grant } from "../../../src/access/grants";
import * as Authority from "../../../src/access/authority";
import { settleShadows } from "../../../src/access/wired";
import { __resetDecide } from "../../../src/access/decide";
import { AgentManager } from "../../../src/agent/manager";
import * as Domain from "../../../src/db/domain";
import * as OneOnOne from "../../../src/db/one-on-one";
import { createGateway } from "../../../src/gateway/core/gateway";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { metrics } from "../../../src/metrics";
import * as Actor from "../../../src/refs/actor";

const MEMBER = "U0MEMBER";
const MEMBER2 = "U0TWO";
const STRANGER = "U0NOBODY";
const TEAM = "T";

function transport() {
  const posts: any[] = [];
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const client = {
    auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: TEAM, url: "x" }) },
    chat: { postMessage: async (a: any) => (posts.push(a), { ok: true, ts: `${posts.length}.1` }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
  } as any;
  const t: Transport = { client, action: () => {}, event: (n: string, fn: any) => handlers.set(n, fn), use: () => {}, start: async () => {}, stop: async () => {} };
  return { t, client, posts, emit: async (n: string, a: any) => void (await handlers.get(n)?.(a)) };
}

function gateway() {
  const tr = transport();
  const agent = new AgentManager();
  const sends: string[] = [];
  agent.sendMessage = async (_id: string, txt: string) => void sends.push(txt);
  createGateway(agent, tr.t, {});
  return { ...tr, sends };
}

let n = 9000;
const dm = (g: { client: any }, user: string, text: string, ts = `${++n}.1`) => ({
  event: { type: "message", channel: "D_X", channel_type: "im", user, team: TEAM, ts, text },
  client: g.client,
  context: { teamId: TEAM },
});

const email = (address: string, role: Grant["role"]): Grant => ({ subjectKind: "user", subjectId: `email:${address}`, role, deny: false, dmOnly: false, source: "console", subject: { service: "email", address } });
const member = (id: string): Grant => ({ subjectKind: "user", subjectId: id, role: "member", deny: false, dmOnly: false, source: "console", subject: { service: "slack" } });

function raw(text: string, name: string, labels: Record<string, string>): number {
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  return text
    .split("\n")
    .filter((l) => l.startsWith(name + "{") && want.every((w) => l.includes(w)))
    .reduce((sum, l) => sum + Number(l.split(" ").pop()), 0);
}
let baseline = "";
const count = (name: string, labels: Record<string, string>) => raw(metrics.render(), name, labels) - raw(baseline, name, labels);

let savedSource: string | undefined;
beforeEach(async () => {
  // Shadows another test file left running would otherwise land in this test's counts.
  await settleShadows();
  baseline = metrics.render();
  savedSource = process.env.SLAUDE_ACCESS_SOURCE;
  delete process.env.SLAUDE_ACCESS_SOURCE;
  writeSoulFixture(WORLD);
  __setGrantsReader(async () => [member(MEMBER), member(MEMBER2), email("a@example.com", "manager")]);
  await Domain._wipeForTests();
  await OneOnOne._wipeForTests();
  Actor.invalidateActors();
  __resetDecide();
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await settleShadows();
  __setGrantsReader(null);
  await OneOnOne._wipeForTests();
  if (savedSource === undefined) delete process.env.SLAUDE_ACCESS_SOURCE;
  else process.env.SLAUDE_ACCESS_SOURCE = savedSource;
  mock.restore();
});

type Break = "none" | "resolver_throws" | "engine_throws" | "engine_disagrees";
function breakIt(how: Break) {
  if (how === "resolver_throws") {
    spyOn(Actor, "actingUser").mockRejectedValue(new Error("db down"));
    spyOn(Actor, "sameUser").mockRejectedValue(new Error("db down"));
  } else if (how === "engine_throws") {
    for (const f of ["admitInternal", "roleInternal", "usersWithRoleInternal"] as const) spyOn(Authority, f).mockImplementation(() => { throw new Error("engine bug"); });
    spyOn(Actor, "sameUser").mockImplementation(() => { throw new Error("engine bug"); });
  } else if (how === "engine_disagrees") {
    spyOn(Authority, "admitInternal").mockReturnValue({ ok: true });
    spyOn(Authority, "roleInternal").mockReturnValue("manager");
    spyOn(Actor, "sameUser").mockResolvedValue(true);
  }
}

/** What reached the agent, per speaker, for one scenario. */
async function scenario(): Promise<Record<string, number>> {
  const g = gateway();
  const out: Record<string, number> = {};
  for (const [who, user] of [["manager", WORLD.manager], ["member", MEMBER], ["stranger", STRANGER]] as const) {
    const before = g.sends.length;
    await g.emit("message", dm(g, user, `hello from ${who}`));
    out[who] = g.sends.length - before;
  }
  // A 1on1 thread locked to the member: the stranger-in-lock and the manager.
  const ts = `${++n}.2`;
  await OneOnOne.lock({ channelId: "D_X", threadTs: ts, lockedUser: MEMBER, createdBy: MEMBER, teamId: TEAM });
  for (const [who, user] of [["lock_owner", MEMBER], ["lock_manager", WORLD.manager], ["lock_other", MEMBER2]] as const) {
    const before = g.sends.length;
    const a = dm(g, user, `in the lock from ${who}`, `${++n}.3`);
    (a.event as { thread_ts?: string }).thread_ts = ts;
    await g.emit("message", a);
    out[who] = g.sends.length - before;
  }
  return out;
}

describe("gateway sites keep the legacy decision", () => {
  test("the legacy baseline", async () => {
    process.env.SLAUDE_ACCESS_SOURCE = "legacy";
    expect(await scenario()).toEqual({ manager: 1, member: 1, stranger: 0, lock_owner: 1, lock_manager: 1, lock_other: 0 });
  });

  for (const mode of ["legacy", "shadow"] as const) {
    for (const how of ["none", "resolver_throws", "engine_throws", "engine_disagrees"] as Break[]) {
      test(`${mode} source, ${how}: same decisions as the legacy baseline`, async () => {
        process.env.SLAUDE_ACCESS_SOURCE = mode;
        breakIt(how);
        expect(await scenario()).toEqual({ manager: 1, member: 1, stranger: 0, lock_owner: 1, lock_manager: 1, lock_other: 0 });
        await settleShadows();
      });
    }
  }

  test("every wired site on the path counts a decision, and shadow compares them", async () => {
    await scenario();
    await settleShadows();
    for (const site of ["gateway.admit", "gateway.one_on_one_gate.role", "gateway.one_on_one_gate.lock_owner"]) {
      expect(count("slaude_access_decision_total", { source: "legacy", site })).toBeGreaterThan(0);
      const compared = count("slaude_access_shadow_total", { site, outcome: "match" }) + count("slaude_access_shadow_total", { site, outcome: "mismatch" }) + count("slaude_access_shadow_total", { site, outcome: "new_error" });
      expect(compared).toBeGreaterThan(0);
    }
  });

  test("a message without a workspace never reaches the engine", async () => {
    const acting = spyOn(Actor, "actingUser");
    const g = gateway();
    const a = dm(g, MEMBER, "hi");
    (a.event as any).team = undefined;
    (a.context as any) = {};
    await g.emit("message", a);
    await settleShadows();
    expect(acting).not.toHaveBeenCalled();
  });
});
