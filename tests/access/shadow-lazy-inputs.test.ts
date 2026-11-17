/**
 * Slice C review: an input only the shadow needs is read lazily and detached,
 * so a failed read can never stop the connect card or the approval card.
 */
import { expect, spyOn, test } from "bun:test";
import * as Role from "../../src/access/role";
import { settleShadows } from "../../src/access/wired";
import { AgentManager } from "../../src/agent/manager";
import { createGateway } from "../../src/gateway/core/gateway";
import { ApprovalGate } from "../../src/gateway/slack/approval-gate";
import { writeSoulFixture, WORLD } from "../../src/gateway/sim/soul-fixture";
import { useShadowEnv } from "../helpers/shadow-modes";

useShadowEnv({ before: () => writeSoulFixture(WORLD) });

test("the connect card is posted when the shadow's grants read fails", async () => {
  const posts: any[] = [];
  const client = {
    auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
    chat: { postMessage: async (a: any) => (posts.push(a), { ok: true, ts: "1.5" }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
  } as any;
  const t = { client, action: () => {}, event: () => {}, use: () => {}, start: async () => {}, stop: async () => {} } as any;
  const h = createGateway(new AgentManager(), t, {});
  const grants = spyOn(Role, "loadGrants").mockRejectedValue(new Error("grants down"));
  await h.__postBridgeConnectCard!({ persona: "default", session: "s", team: "T", channel: "D_X", thread: "1.5", initiator: WORLD.manager, runAs: "agent", app: "A1" } as never, "svc", "global", "connect");
  await settleShadows();
  expect(grants).toHaveBeenCalled();
  expect(posts.length).toBe(1);
  await h.stop();
});

test("an approval card for a named persona reads the persona's grants once, in the foreground, and starts no second read", async () => {
  const posts: any[] = [];
  const app: any = { action: () => {}, client: { chat: { postMessage: async (x: any) => (posts.push(x), { ok: true, ts: "1.1" }), update: async () => ({ ok: true }) } } };
  const gate = new ApprovalGate(app, [], { gateBus: null, timeoutSeconds: () => 0 });
  // The card reads the persona's grants itself (it needs them for the answer); the shadow works from the same read.
  const real = Role.loadGrants;
  let scoutReads = 0;
  spyOn(Role, "loadGrants").mockImplementation((p) => (p === "scout" && ++scoutReads, real(p)));
  const { pendingId } = await gate.open({ channel: "C0EXAMPLE", threadTs: "1.1", summary: "x", sessionId: "S-lazy", persona: "scout", app: { teamId: "T" } });
  await settleShadows();
  expect(pendingId).toBeTruthy();
  expect(scoutReads).toBe(1);
});
