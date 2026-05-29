import { describe, it, expect } from "bun:test";
import { ApprovalGate } from "../../../src/gateway/slack/approval-gate";
import type { Transport } from "../../../src/gateway/core/transport";

function fakeTransport() {
  const actions: Array<{ id: any; h: any }> = [];
  const posted: any[] = [];
  const t: Transport & { actions: typeof actions; posted: typeof posted } = {
    actions, posted,
    client: {
      chat: { postMessage: async (a: any) => { posted.push(a); return { ok: true, ts: "1.1" }; }, update: async () => ({ ok: true }) },
    } as any,
    action: (id, h) => { actions.push({ id, h }); },
    event: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
  };
  return t;
}

describe("ApprovalGate accepts a Transport", () => {
  it("registers an action handler and posts a card, resolves on authorized click", async () => {
    const t = fakeTransport();
    const gate = new ApprovalGate(t, [], { timeoutSeconds: () => 0 });
    expect(t.actions.length).toBe(1);
    const decision = gate.request({ channel: "C1", threadTs: "1.0", summary: "do it", approvers: ["U_MGR"] });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.posted.length).toBe(1);
    const lastBlock = t.posted[0].blocks.at(-1)!;
    const approveId = lastBlock.elements[0].action_id; // slaude_appr:approve:<id>
    await t.actions[0]!.h({
      ack: async () => {},
      action: { action_id: approveId },
      body: { user: { id: "U_MGR" } },
      respond: async () => {},
    });
    expect((await decision).approved).toBe(true);
  });
});
