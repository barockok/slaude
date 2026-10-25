/**
 * The per-turn `<memory-context>` block in the Slack turn envelope (phase C
 * §8.4): built at envelope time for the message's own sender, placed right
 * after `</channel>` and before the reply instruction, sent through both
 * dispatch paths (mono's agent.sendMessage and the gateway role's queue), and
 * left out of a suppressed (record-only) message. The brain is a fake backend.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createGateway, type GatewayHandle } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { DispatchMeta, QueueDispatch } from "../../../src/gateway/core/dispatch";
import type { SessionRow } from "../../../src/db/schema";
import { db } from "../../../src/db/schema";
import * as OneOnOne from "../../../src/db/one-on-one";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { setBackendForTest, resetBackend } from "../../../src/knowledge/backend";
import { resetAgentId, setAgentId } from "../../../src/knowledge/agent-identity";
import { resetStandingGrants } from "../../../src/knowledge/gated-dispatch";
import { composePage } from "../../../src/knowledge/memory-pages";
import { agentSourceId, profileSourceId, type BrainScope } from "../../../src/knowledge/scope";
import { fakeBrain } from "../../memory/fake-brain";

const ENV = ["SLAUDE_BRAIN_MODE", "SLAUDE_BRAIN_DISABLED"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const AGENT = agentSourceId("U_SLAUDE");

let fb: ReturnType<typeof fakeBrain>;
const put = async (source: string, slug: string, content: string, typed?: { type: string; fields?: Record<string, string> }) => {
  let text = content;
  if (typed) {
    const r = composePage({ slug, content, ...typed }, new Date("2026-10-20T12:00:00Z"));
    if ("error" in r) throw new Error(r.error);
    text = r.content;
  }
  await fb.call("put_page", { slug, content: text }, { clientId: "x", sourceId: source, allowedSources: [source] });
};

function transport() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const client: any = {
    auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
    chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({ members: [] }), replies: async () => ({ messages: [] }) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  };
  const t: any = {
    client,
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => void handlers.set(name, fn),
  };
  /** As Slack delivers a mention: app_mention, then the message copy. */
  const mention = async (user: string, thread: string, ts: string, text = "hello") => {
    const event = { type: "message", channel: "C0TEAM", channel_type: "channel", user, team: "T", ts, thread_ts: thread, text: `<@U_SLAUDE> ${text}` };
    const args = { event, client, context: { teamId: "T" } };
    await handlers.get("app_mention")?.({ ...args, event: { ...event, type: "app_mention" } });
    await handlers.get("message")!(args);
  };
  /** A thread message addressed to another person (disengages; recorded suppressed). */
  const toOther = async (user: string, thread: string, ts: string) => {
    const event = { type: "message", channel: "C0TEAM", channel_type: "channel", user, team: "T", ts, thread_ts: thread, text: "<@U0OTHER> over to you" };
    await handlers.get("message")!({ event, client, context: { teamId: "T" } });
  };
  return { t, mention, toOther };
}

let h: GatewayHandle | null = null;
let texts: string[];
let agent: AgentManager;
const waitTexts = async (n: number) => {
  const end = Date.now() + 3000;
  while (texts.length < n && Date.now() < end) await Bun.sleep(10);
  expect(texts.length).toBeGreaterThanOrEqual(n);
};

beforeAll(() => {
  process.env.SLAUDE_BRAIN_MODE = "remote";
  delete process.env.SLAUDE_BRAIN_DISABLED;
  setAgentId("U_SLAUDE");
});
afterAll(() => {
  resetBackend();
  resetAgentId();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(async () => {
  fb = fakeBrain();
  setBackendForTest({ call: (n: string, p: Record<string, unknown>, s: BrainScope) => fb.call(n, p, s), adminCall: async () => null } as any);
  texts = [];
  resetStandingGrants();
  writeSoulFixture(WORLD);
  await OneOnOne._wipeForTests();
  await db.run("DELETE FROM cron_jobs");
  agent = new AgentManager();
  agent.sendMessage = async (_id: string, text: string) => void texts.push(text);
});
afterEach(async () => {
  await h?.stop();
  h = null;
});

const seedAlice = async () => {
  await put(profileSourceId("T", "U0ALICE"), "profile", "Call me Al.", { type: "profile" });
  await put(AGENT, "self/lessons", "Check the deploy log first.", { type: "lessons" });
  await put(AGENT, "commitments/report", "Send the weekly report.", {
    type: "commitment", fields: { promiser: "U_SLAUDE", beneficiary: "U0ALICE", thread: "C0OTHER:1.1", status: "open" },
  });
  await put(profileSourceId("T", "U0BOB"), "profile", "Bob likes bullet points.", { type: "profile" });
};

describe("the Slack envelope carries this message's <memory-context>", () => {
  test("mono: after </channel>, before the reply instruction; the sender's profile, never another person's", async () => {
    await seedAlice();
    const { t, mention } = transport();
    h = createGateway(agent, t);
    await mention("U0ALICE", "800.0", "800.1");
    await waitTexts(1);
    const env = texts[0]!;
    const close = env.indexOf("</channel>");
    const open = env.indexOf("<memory-context>\n");
    const end = env.indexOf("\n</memory-context>\n\n");
    const instr = env.indexOf("Reply by calling");
    expect(close).toBeGreaterThan(0);
    expect(open).toBe(close + "</channel>\n\n".length);
    expect(end).toBeGreaterThan(open);
    expect(instr).toBe(end + "\n</memory-context>\n\n".length);
    const block = env.slice(open, end);
    expect(block).toContain("<profile>\nCall me Al.");
    expect(block).toContain("Check the deploy log first.");
    expect(block).toContain("Send the weekly report.");
    expect(block).not.toContain("Bob likes bullet points.");

    // Bob in the same thread: his own profile, not Alice's, nor her commitment.
    await mention("U0BOB", "800.0", "800.2");
    await waitTexts(2);
    expect(texts[1]).toContain("Bob likes bullet points.");
    expect(texts[1]).not.toContain("Call me Al.");
    expect(texts[1]).not.toContain("Send the weekly report.");
  });

  test("nothing to show: no block at all", async () => {
    const { t, mention } = transport();
    h = createGateway(agent, t);
    await mention("U0ALICE", "810.0", "810.1");
    await waitTexts(1);
    expect(texts[0]).not.toContain("<memory-context>");
    expect(texts[0]).toContain("</channel>\n\nReply by calling");
  });

  test("a suppressed (record-only) message carries no block", async () => {
    await seedAlice();
    const { t, mention, toOther } = transport();
    h = createGateway(agent, t);
    await mention("U0ALICE", "820.0", "820.1");
    await waitTexts(1);
    expect(texts[0]).toContain("<memory-context>");
    await toOther("U0ALICE", "820.0", "820.2");
    await waitTexts(2);
    expect(texts[1]).toContain("disengaged from this thread");
    expect(texts[1]).not.toContain("<memory-context>");
  });

  test("gateway role: the envelope queued for the node carries the block", async () => {
    await seedAlice();
    const queued: Array<{ text: string; meta: DispatchMeta }> = [];
    const qd = {
      dispatch: async (_s: SessionRow, text: string, meta: DispatchMeta) => void queued.push({ text, meta }),
      abort: async () => {},
      pubsub: { close: async () => {} },
      turns: { close: async () => {}, turnSenders: async () => null },
      registry: { close: async () => {}, liveLabels: async () => [] },
      close: async () => {},
    } as unknown as QueueDispatch;
    const { t, mention } = transport();
    h = createGateway(new AgentManager(), t, { queueDispatch: qd });
    await mention("U0ALICE", "830.0", "830.1");
    const end = Date.now() + 3000;
    while (queued.length === 0 && Date.now() < end) await Bun.sleep(10);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.text).toContain("</channel>\n\n<memory-context>\n<profile>\nCall me Al.");
    expect(queued[0]!.text).not.toContain("Bob likes bullet points.");
  });
});
