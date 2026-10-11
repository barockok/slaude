/**
 * D1.2: a gate posts (and later edits) its card as the app the session belongs
 * to, never as the transport's app-level client. (A click answers through its
 * own response_url, which belongs to the app that posted the card.)
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { ApprovalGate } from "../../../src/gateway/slack/approval-gate";
import { PermissionGate } from "../../../src/gateway/slack/permission-gate";
import type { AppRef, Transport } from "../../../src/gateway/core/transport";
import { __resetSoulDataMemo } from "../../../src/soul/extract";
import { paths } from "../../../src/config/home";

type Call = { app: string; method: string; args: any };

/** A multi-app transport: every call is recorded with the app whose client made it. */
function multiAppTransport() {
  const calls: Call[] = [];
  const actions: Array<{ id: any; h: any }> = [];
  const clientOf = (app: string): any => ({
    chat: {
      postMessage: async (a: any) => (calls.push({ app, method: "chat.postMessage", args: a }), { ok: true, ts: `${calls.length}.0` }),
      update: async (a: any) => (calls.push({ app, method: "chat.update", args: a }), { ok: true }),
    },
  });
  const t: Transport = {
    client: clientOf("PRIMARY"),
    clientFor: (app: AppRef) => clientOf(app.apiAppId ?? "NONE"),
    action: (id, h) => void actions.push({ id, h }),
    event: () => {},
    use: () => {},
    start: async () => {},
    stop: async () => {},
  };
  return { t, calls, actions };
}

const until = async (cond: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
};

const APP_B: AppRef = { apiAppId: "A0TWO", teamId: "T0AAA" };

describe("gates resolve their client from the session's app", () => {
  beforeEach(() => {
    if (existsSync(paths.soul)) unlinkSync(paths.soul);
    writeFileSync(paths.soul, "# Persona\n");
    __resetSoulDataMemo();
  });

  it("ApprovalGate.request posts as the request's app, and the timeout edit follows", async () => {
    const { t, calls } = multiAppTransport();
    const gate = new ApprovalGate(t, [], { timeoutSeconds: () => 0.05, gateBus: null });
    const d = await gate.request({ channel: "C1", threadTs: "1.0", summary: "do it", app: APP_B });
    expect(d.approved).toBe(false);
    await until(() => calls.some((c) => c.method === "chat.update"));
    expect(calls.map((c) => `${c.method}:${c.app}`)).toEqual(["chat.postMessage:A0TWO", "chat.update:A0TWO"]);
  });

  it("ApprovalGate.open (REST plane) posts as the request's app", async () => {
    const { t, calls } = multiAppTransport();
    const gate = new ApprovalGate(t, [], { timeoutSeconds: () => 0, gateBus: null });
    await gate.open({ channel: "C1", threadTs: "1.0", summary: "do it", app: APP_B });
    expect(calls.map((c) => `${c.method}:${c.app}`)).toEqual(["chat.postMessage:A0TWO"]);
  });

  it("PermissionGate posts its card as the bound session's app", async () => {
    const { t, calls } = multiAppTransport();
    const gate = new PermissionGate(t, { gateBus: null });
    gate.bindSession("S-perm-app", "C1", "1.0", APP_B);
    const ac = new AbortController();
    const toolUseID = `tu-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    void gate.resolver("S-perm-app", "Bash", { command: "rm -rf /tmp/x" }, { signal: ac.signal, toolUseID, suggestions: [] } as any);
    await until(() => calls.length > 0);
    ac.abort();
    expect(calls.map((c) => `${c.method}:${c.app}`)).toEqual(["chat.postMessage:A0TWO"]);
  });

  it("PermissionGate.open (REST plane) posts as the given app", async () => {
    const { t, calls } = multiAppTransport();
    const gate = new PermissionGate(t, { gateBus: null });
    const toolUseId = `tu-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await gate.open({ sessionId: "S-open", toolName: "Bash", input: { command: "rm -rf /tmp/x" }, toolUseId, channel: "C1", threadTs: "1.0", app: APP_B });
    expect(calls.map((c) => `${c.method}:${c.app}`)).toEqual(["chat.postMessage:A0TWO"]);
  });

  it("a single-app transport (no clientFor) keeps using its one client", async () => {
    const calls: string[] = [];
    const t: Transport = {
      client: { chat: { postMessage: async () => (calls.push("one"), { ok: true, ts: "1.1" }), update: async () => ({ ok: true }) } } as any,
      action: () => {}, event: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    };
    const gate = new ApprovalGate(t, [], { timeoutSeconds: () => 0, gateBus: null });
    await gate.open({ channel: "C1", threadTs: "1.0", summary: "x", app: APP_B });
    expect(calls).toEqual(["one"]);
  });
});
