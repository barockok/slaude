import { describe, it, expect } from "bun:test";
import { SimTransport } from "../../../src/gateway/sim/transport";

describe("SimTransport — WebClient stub surface", () => {
  it("answers every client stub and records message/update/reaction cards", async () => {
    const t = new SimTransport();
    const c: any = t.client;

    const auth = await c.auth.test();
    expect(auth.user_id).toBe("U_SLAUDE");

    await c.chat.postMessage({ channel: "C1", text: "hi" });
    await c.chat.update({ channel: "C1", ts: "1.0", text: "edited" });
    await c.reactions.add({ channel: "C1", timestamp: "1.0", name: "eyes" });
    expect((await c.reactions.remove({ channel: "C1" })).ok).toBe(true);

    expect((await c.conversations.info({ channel: "C9" })).channel.id).toBe("C9");
    expect((await c.conversations.members({ channel: "C9" })).members).toEqual([]);
    expect((await c.conversations.replies({ channel: "C9" })).messages).toEqual([]);
    expect((await c.users.info({ user: "UX" })).user.real_name).toBe("UX");   // unknown user echoes id
    expect((await c.users.profile.set({})).ok).toBe(true);
    expect((await c.search.messages({})).messages.matches).toEqual([]);
    expect((await c.assistant.threads.setStatus({})).ok).toBe(true);

    expect(t.outbound.map((x) => x.kind)).toEqual(["message", "message", "reaction"]);
    expect(t.outbound[2]!.text).toBe(":eyes:");
  });

  it("onCard unsubscribes cleanly; use/start/stop are no-ops; feedAction throws without a handler", async () => {
    const t = new SimTransport({ users: { U1: "One" }, botUserId: "UBOT" });
    expect((await (t.client as any).users.info({ user: "U1" })).user.real_name).toBe("One");

    const seen: string[] = [];
    const off = t.onCard((card) => seen.push(card.kind));
    await (t.client as any).chat.postMessage({ channel: "C1", text: "a" });
    off();
    await (t.client as any).chat.postMessage({ channel: "C1", text: "b" });
    expect(seen).toEqual(["message"]);

    t.use((async () => {}) as any);
    await t.start();
    await t.stop();
    await expect(t.feedAction("nope:x", "U1")).rejects.toThrow("no action handler");
  });

  it("feedMessage fans out app_mention + message; replace_original resolves the source card", async () => {
    const t = new SimTransport({ botUserId: "UBOT" });
    const got: string[] = [];
    t.event("message", (async ({ event }: any) => { got.push(`msg:${event.type}`); }) as any);
    t.event("app_mention", (async ({ event }: any) => { got.push(`mention:${event.type}`); }) as any);
    await t.feedMessage({ channel: "C1", user: "U1", text: "<@UBOT> hi" });
    expect(got).toEqual(["mention:app_mention", "msg:message"]);

    t.action(/^slaude_perm:/, (async ({ respond }: any) => {
      await respond({ replace_original: true, text: "resolved" });
    }) as any);
    await (t.client as any).chat.postMessage({
      channel: "C1", text: "gate",
      blocks: [{ type: "actions", elements: [{ action_id: "slaude_perm:allow:1" }] }],
    });
    const gate = t.outbound.find((card) => card.kind === "permission")!;
    expect(gate.resolved).toBe(false);
    await t.feedAction("slaude_perm:allow:1", "U1");
    expect(gate.resolved).toBe(true);
  });
});
