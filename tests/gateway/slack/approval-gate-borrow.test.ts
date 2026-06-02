import { describe, it, expect } from "bun:test";
import { ApprovalGate } from "../../../src/gateway/slack/approval-gate";

// Minimal fake @slack/bolt App capturing the action handler + postMessage.
function fakeApp() {
  let actionHandler: any;
  const posted: any[] = [];
  const app: any = {
    action: (_re: RegExp, h: any) => { actionHandler = h; },
    client: {
      chat: {
        postMessage: async (m: any) => { posted.push(m); return { ts: "111.1" }; },
        update: async () => ({}),
      },
    },
  };
  return { app, posted, fire: (...a: any[]) => actionHandler(...a) };
}

/** Pull the action_id of a button by its text from the last posted message. */
function actionIdFor(posted: any[], text: string): string {
  const blocks = posted.at(-1).blocks as any[];
  const actions = blocks.find((b) => b.type === "actions");
  const btn = actions.elements.find((e: any) => e.text.text === text);
  return btn.action_id;
}

describe("ApprovalGate borrow extension", () => {
  it("renders 3 grant buttons and targets the explicit approver", async () => {
    const { app, posted } = fakeApp();
    const gate = new ApprovalGate(app, [], {});
    void gate.request({ channel: "C", threadTs: "1.1", summary: "borrow jira_search", approvers: ["U1"], grantButtons: true });
    const blocks = posted.at(-1).blocks as any[];
    const actions = blocks.find((b) => b.type === "actions");
    const labels = actions.elements.map((e: any) => e.text.text);
    expect(labels).toEqual(["Allow for thread", "Just once", "Deny"]);
    const approverCtx = blocks.find((b) => b.type === "context" && JSON.stringify(b).includes("Approver"));
    expect(JSON.stringify(approverCtx)).toContain("U1");
  });

  it("rejects a non-owner clicker and stays pending", async () => {
    const { app, posted, fire } = fakeApp();
    const gate = new ApprovalGate(app, [], {});
    const p = gate.request({ channel: "C", threadTs: "1.1", summary: "borrow", approvers: ["U1"], grantButtons: true });
    const grantThread = actionIdFor(posted, "Allow for thread");

    const responses: any[] = [];
    await fire({ ack: async () => {}, action: { action_id: grantThread }, body: { user: { id: "U999" } }, respond: async (r: any) => responses.push(r) });
    expect(responses[0].text).toMatch(/not on the approver/i);

    const settled = await Promise.race([p.then(() => "resolved"), new Promise((r) => setTimeout(() => r("pending"), 40))]);
    expect(settled).toBe("pending");
  });

  it("Allow-for-thread resolves with approved + scope=thread by the owner", async () => {
    const { app, posted, fire } = fakeApp();
    const gate = new ApprovalGate(app, [], {});
    const p = gate.request({ channel: "C", threadTs: "1.1", summary: "borrow", approvers: ["U1"], grantButtons: true });
    const grantThread = actionIdFor(posted, "Allow for thread");
    await fire({ ack: async () => {}, action: { action_id: grantThread }, body: { user: { id: "U1" } }, respond: async () => {} });
    const d = await p;
    expect(d).toEqual({ approved: true, by: "U1", scope: "thread" });
  });

  it("Just-once resolves with scope=once; Deny resolves approved=false", async () => {
    {
      const { app, posted, fire } = fakeApp();
      const gate = new ApprovalGate(app, [], {});
      const p = gate.request({ channel: "C", threadTs: "1.1", summary: "b", approvers: ["U1"], grantButtons: true });
      await fire({ ack: async () => {}, action: { action_id: actionIdFor(posted, "Just once") }, body: { user: { id: "U1" } }, respond: async () => {} });
      expect((await p).scope).toBe("once");
    }
    {
      const { app, posted, fire } = fakeApp();
      const gate = new ApprovalGate(app, [], {});
      const p = gate.request({ channel: "C", threadTs: "1.1", summary: "b", approvers: ["U1"], grantButtons: true });
      await fire({ ack: async () => {}, action: { action_id: actionIdFor(posted, "Deny") }, body: { user: { id: "U1" } }, respond: async () => {} });
      const d = await p;
      expect(d.approved).toBe(false);
      expect(d.scope).toBeUndefined();
    }
  });
});
