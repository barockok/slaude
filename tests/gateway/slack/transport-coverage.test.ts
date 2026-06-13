import { describe, expect, mock, test } from "bun:test";

// createSlackTransport() constructs a bolt App. Building a *real* App leaks a
// background Slack auth call (invalid_auth) that surfaces as an unhandled
// rejection between tests under full-suite timing. Mock @slack/bolt with a fake
// App so the factory + its delegations are exercised entirely offline.
//
// The mock spreads the real module (preserving LogLevel etc.) and only swaps
// App for the fake. mock.module can leak across files, but the only other bolt
// consumers (adapter.ts, transport.ts) are never constructed-with-network by
// any other test, so a leaked inert FakeApp is harmless.

const calls = {
  actions: [] as unknown[],
  events: [] as unknown[],
  uses: 0,
  started: 0,
  stopped: 0,
  ctorOpts: null as any,
};

class FakeApp {
  client = { chat: { postMessage: async () => ({ ok: true }) } };
  constructor(opts: any) {
    calls.ctorOpts = opts;
  }
  action(id: unknown, _h: unknown) {
    calls.actions.push(id);
  }
  event(name: unknown, _h: unknown) {
    calls.events.push(name);
  }
  use(_mw: unknown) {
    calls.uses += 1;
  }
  start() {
    calls.started += 1;
    return Promise.resolve();
  }
  stop() {
    calls.stopped += 1;
    return Promise.resolve();
  }
}

const realBolt = await import("@slack/bolt");
mock.module("@slack/bolt", () => ({ ...realBolt, App: FakeApp }));

// Query string forces transport.ts to re-evaluate so its `import { App }` binds
// the mock even when an earlier file already imported the real module.
// @ts-expect-error — the ?query suffix is a runtime cache-buster bun resolves; TS can't type it.
const { createSlackTransport } = await import("../../../src/gateway/slack/transport.ts?bolt-mock");

describe("createSlackTransport", () => {
  test("builds a Transport over bolt offline and wires every delegation", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-1-A111-1-deadbeef";

    const t = createSlackTransport();

    // App constructed in Socket Mode from the env tokens.
    expect(calls.ctorOpts.socketMode).toBe(true);
    expect(calls.ctorOpts.token).toBe("xoxb-test-token");
    expect(calls.ctorOpts.appToken).toBe("xapp-1-A111-1-deadbeef");

    // client is the bolt App's WebClient, exposed as WebClientLike.
    expect(typeof (t.client as any).chat?.postMessage).toBe("function");

    // registration wrappers delegate to the App (string + regex action ids).
    t.action("approve_btn", async () => {});
    t.action(/dyn_.*/ as any, async () => {});
    t.event("message", async () => {});
    t.use(async () => {});
    expect(calls.actions.length).toBe(2);
    expect(calls.events).toEqual(["message"]);
    expect(calls.uses).toBe(1);

    // start/stop resolve to undefined via the App (no socket opened here).
    await expect(t.start()).resolves.toBeUndefined();
    await expect(t.stop()).resolves.toBeUndefined();
    expect(calls.started).toBe(1);
    expect(calls.stopped).toBe(1);
  });
});
