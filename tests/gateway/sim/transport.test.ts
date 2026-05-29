import { describe, it, expect } from "bun:test";
import { SimTransport } from "../../../src/gateway/sim/transport";

describe("SimTransport", () => {
  it("records postMessage as a message card and classifies approval cards", async () => {
    const t = new SimTransport({ users: { U1: "Alice" } });
    await t.client.chat.postMessage({ channel: "C1", thread_ts: "1.0", text: "hi", blocks: [] });
    expect(t.outbound[0]).toMatchObject({ kind: "message", channel: "C1", text: "hi", resolved: false });

    await t.client.chat.postMessage({
      channel: "C1", text: "appr",
      blocks: [{ type: "actions", elements: [{ type: "button", action_id: "slaude_appr:approve:x1" }, { type: "button", action_id: "slaude_appr:deny:x1" }] }],
    });
    const card = t.outbound[1]!;
    expect(card.kind).toBe("approval");
    expect(card.actionIds).toEqual(["slaude_appr:approve:x1", "slaude_appr:deny:x1"]);
  });

  it("feedMessage invokes the message handler with a bolt-shaped arg", async () => {
    const t = new SimTransport({});
    const seen: any[] = [];
    t.event("message", async (a) => { seen.push(a.event); });
    await t.feedMessage({ channel: "C1", user: "U1", text: "yo", team: "T1" });
    expect(seen[0]).toMatchObject({ channel: "C1", user: "U1", text: "yo" });
  });

  it("feedAction routes to the regex-matching handler and respond() resolves the card", async () => {
    const t = new SimTransport({});
    await t.client.chat.postMessage({ channel: "C1", text: "appr", blocks: [{ type: "actions", elements: [{ type: "button", action_id: "slaude_appr:approve:x1" }] }] });
    let gotUser = "";
    t.action(/^slaude_appr:(approve|deny):.+$/, async ({ action, body, respond, ack }) => {
      await ack(); gotUser = body.user.id;
      await respond({ replace_original: true, text: "done", blocks: [] });
    });
    await t.feedAction("slaude_appr:approve:x1", "U_MGR");
    expect(gotUser).toBe("U_MGR");
    expect(t.outbound[0]!.resolved).toBe(true);
    expect(t.outbound.at(-1)!.text).toBe("done");
  });
});
