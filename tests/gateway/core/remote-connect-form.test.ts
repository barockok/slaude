import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import * as OneOnOne from "../../../src/db/one-on-one";
import * as Remote from "../../../src/db/remote";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { REMOTE_CONNECT_VIEW, REMOTE_OPEN_ACTION, REMOTE_OFFER_TTL_MS } from "../../../src/gateway/core/remote-command";
import { generateSshKeyPair } from "../../../src/remote/keygen";

// /remote Connect form, end to end through the gateway: a bare `/remote` posts a
// private Connect button, the click opens a modal, and the submission runs the
// same `on` path as `/remote <addr> <dir>`, without the address in the thread.

function harness() {
  const posts: any[] = [];
  const ephemerals: any[] = [];
  const opened: any[] = [];
  const events = new Map<string, (args: any) => Promise<void>>();
  const actions: { pattern: RegExp | string; fn: any }[] = [];
  const views = new Map<string, any>();
  const client = {
    auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
    chat: {
      postMessage: async (a: any) => { const ts = `${Date.now()}.${posts.length}`; posts.push({ ...a, ts }); return { ok: true, ts }; },
      update: async () => ({ ok: true }),
      postEphemeral: async (a: any) => { ephemerals.push(a); return { ok: true }; },
    },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
    views: { open: async (a: any) => { opened.push(a); return { ok: true }; } },
  } as any;
  const t: Transport = {
    client,
    action: (pattern: any, fn: any) => actions.push({ pattern, fn }),
    view: (id: string, fn: any) => views.set(id, fn),
    event: (name: string, fn: any) => events.set(name, fn),
    use: () => {},
    start: async () => {},
    stop: async () => {},
  };
  const agent = new AgentManager();
  agent.sendMessage = async () => {};
  createGateway(agent, t);
  const say = (text: string, threadTs: string, user = WORLD.manager) =>
    events.get("message")!({
      event: { type: "message", channel: "D_MGR", channel_type: "im", user, team: "T", ts: `${threadTs.split(".")[0]}.${Math.random().toString().slice(2, 8)}`, thread_ts: threadTs, text },
      client,
      context: { teamId: "T" },
    });
  const click = async (value: string, user: string, respond: (m: any) => Promise<void> = async () => {}) => {
    for (const { pattern, fn } of actions) {
      const hit = typeof pattern === "string" ? pattern === REMOTE_OPEN_ACTION : pattern.test(REMOTE_OPEN_ACTION);
      if (hit) await fn({ ack: async () => {}, action: { action_id: REMOTE_OPEN_ACTION, value }, body: { user: { id: user }, trigger_id: "TRIG", team: { id: "T" } }, respond });
    }
  };
  const submit = (privateMetadata: string, user: string, addr: string, dir: string) =>
    views.get(REMOTE_CONNECT_VIEW)!({
      ack: async () => {},
      view: {
        callback_id: REMOTE_CONNECT_VIEW,
        private_metadata: privateMetadata,
        state: { values: { remote_addr: { value: { value: addr } }, remote_dir: { value: { value: dir } } } },
      },
      body: { user: { id: user }, team: { id: "T" } },
    });
  const buttonValue = () => {
    const withBlocks = ephemerals.filter((e) => Array.isArray(e.blocks));
    return withBlocks[withBlocks.length - 1]?.blocks?.[1]?.elements?.[0]?.value as string | undefined;
  };
  return { posts, ephemerals, opened, say, click, submit, buttonValue };
}

let tsCounter = 9100;
const nextTs = () => `${++tsCounter}.1`;
const savedMasterKey = process.env.SLAUDE_MASTER_KEY;

beforeEach(async () => {
  writeSoulFixture(WORLD);
  process.env.SLAUDE_REMOTE = "1";
  // Harmless stub: tailcat "succeeds" with no output, so preflight fails without a network.
  process.env.SLAUDE_TAILCAT_BIN = "/usr/bin/true";
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
  __resetMasterKeyCache();
  await Remote._wipeForTests();
  await OneOnOne._wipeForTests();
});
afterEach(() => {
  delete process.env.SLAUDE_REMOTE;
  delete process.env.SLAUDE_TAILCAT_BIN;
  if (savedMasterKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
  else process.env.SLAUDE_MASTER_KEY = savedMasterKey;
  __resetMasterKeyCache();
});

describe("/remote connect form (gateway)", () => {
  it("bare /remote posts status in the thread and a Connect button only to the sender", async () => {
    const h = harness();
    const ts = nextTs();
    await h.say("/remote", ts);
    expect(h.posts.some((p) => String(p.text).includes("Remote mode: *off*"))).toBe(true);
    const eph = h.ephemerals.find((e) => Array.isArray(e.blocks));
    expect(eph?.user).toBe(WORLD.manager);
    expect(eph?.thread_ts).toBe(ts);
    expect(h.buttonValue()).toBeDefined();
  });

  it("click opens the modal for the button's user; anyone else's click does nothing", async () => {
    const h = harness();
    const ts = nextTs();
    await h.say("/remote", ts);
    await h.click(h.buttonValue()!, "U_SOMEONE_ELSE");
    expect(h.opened).toHaveLength(0);
    await h.click(h.buttonValue()!, WORLD.manager);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0].trigger_id).toBe("TRIG");
    expect(h.opened[0].view.callback_id).toBe(REMOTE_CONNECT_VIEW);
  });

  it("an expired button is answered with a resend hint, no modal", async () => {
    const h = harness();
    const ts = nextTs();
    await h.say("/remote", ts);
    const stale = JSON.stringify({ ...JSON.parse(h.buttonValue()!), i: Date.now() - REMOTE_OFFER_TTL_MS - 1000 });
    const responses: any[] = [];
    await h.click(stale, WORLD.manager, async (m) => { responses.push(m); });
    expect(h.opened).toHaveLength(0);
    expect(responses[0]?.text).toContain("expired");
  });

  it("submission runs the /remote on path (key + preflight) and never posts the address", async () => {
    const h = harness();
    const ts = nextTs();
    await h.say("/remote", ts);
    await h.click(h.buttonValue()!, WORLD.manager);
    const meta = h.opened[0].view.private_metadata;
    // A real pair: an unparseable stored key would be replaced and setup re-sent instead.
    await Remote.putKeyIfAbsent("T", WORLD.manager, generateSshKeyPair(`slaude:${WORLD.manager}`));
    await h.submit(meta, WORLD.manager, "tcSecretFormAddr", "~/repo");
    // The stub tailcat cannot reach anything: preflight's refusal reaches the thread.
    expect(h.posts.some((p) => String(p.text).includes("Couldn't use"))).toBe(true);
    expect(await Remote.findTarget("D_MGR", ts)).toBeNull();
    const all = JSON.stringify([...h.posts, ...h.ephemerals]);
    expect(all).not.toContain("tcSecretFormAddr");
  });

  it("first-time submission sends setup privately instead of connecting", async () => {
    const h = harness();
    const ts = nextTs();
    await h.say("/remote", ts);
    await h.click(h.buttonValue()!, WORLD.manager);
    await h.submit(h.opened[0].view.private_metadata, WORLD.manager, "tcAddr1", "~/repo");
    expect(h.ephemerals.some((e) => String(e.text).includes("tailcat serve"))).toBe(true);
    expect(await Remote.findTarget("D_MGR", ts)).toBeNull();
  });

  it("a submission by another user than the modal's is ignored", async () => {
    const h = harness();
    const ts = nextTs();
    await h.say("/remote", ts);
    await h.click(h.buttonValue()!, WORLD.manager);
    const postsBefore = h.posts.length;
    const ephBefore = h.ephemerals.length;
    await h.submit(h.opened[0].view.private_metadata, "U_SOMEONE_ELSE", "tcAddr1", "~/repo");
    expect(h.posts.length).toBe(postsBefore);
    expect(h.ephemerals.length).toBe(ephBefore);
  });

  it("no button when the thread is locked to someone else", async () => {
    const h = harness();
    const ts = nextTs();
    await h.say("hi", ts);
    await OneOnOne.lock({ channelId: "D_MGR", threadTs: ts, lockedUser: "U0OWNER", createdBy: "U0OWNER" });
    await h.say("/remote", ts);
    expect(h.buttonValue()).toBeUndefined();
  });
});
