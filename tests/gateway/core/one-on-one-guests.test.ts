/**
 * /1on1 named guests end to end in mono: the real gateway and AgentManager,
 * a fake claude-agent-sdk `query` (same preamble as the manager tests), and a
 * transport that records posts and lets a test click Block Kit buttons.
 *
 * The session runs in bypass mode, where the CLI never calls canUseTool: the
 * owner-only check must come from the PreToolUse hook, so the test drives the
 * hook the session booted with.
 */
import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

process.env.SLAUDE_MEMORY = "sqlite";
process.env.SLAUDE_AUTO_EVOLVE = "0";
process.env.SLAUDE_IDLE_MINUTES = "0";

const realSdk = await import("@anthropic-ai/claude-agent-sdk");
const realQuery = realSdk.query;
type QueryArgs = { prompt: AsyncIterable<any>; options: any };
let currentQuery: (args: QueryArgs) => any = (args) => realQuery(args as any);
mock.module("@anthropic-ai/claude-agent-sdk", () => ({ ...realSdk, query: (args: QueryArgs) => currentQuery(args) }));

const { AgentManager } = await import("../../../src/agent/manager");
const { createGateway } = await import("../../../src/gateway/core/gateway");
const OneOnOne = await import("../../../src/db/one-on-one");
const PendingGates = await import("../../../src/db/pending-gates");
const { writeSoulFixture, WORLD } = await import("../../../src/gateway/sim/soul-fixture");
const { __resetSoulDataMemo } = await import("../../../src/soul/extract");
const { paths } = await import("../../../src/config/home");

/** A fake SDK session: records options and prompts; the test emits results. */
class FakeSession {
  options: any = null;
  users: any[] = [];
  out: any[] = [];
  ended = false;
  #wake: (() => void) | null = null;
  emit(m: any) {
    this.out.push(m);
    this.#wake?.();
  }
  start({ prompt, options }: QueryArgs) {
    this.options = options;
    const self = this;
    (async () => {
      for await (const um of prompt) self.users.push(um);
      self.ended = true;
      self.#wake?.();
    })();
    options.abortController?.signal.addEventListener("abort", () => {
      self.ended = true;
      self.#wake?.();
    });
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (self.out.length) {
            yield self.out.shift();
            continue;
          }
          if (self.ended) return;
          await new Promise<void>((r) => (self.#wake = r));
        }
      },
      setPermissionMode: async () => ({}),
      mcpServerStatus: async () => [],
      interrupt: async () => {},
    };
  }
}

let spawned: FakeSession[] = [];
afterAll(() => {
  currentQuery = (args) => realQuery(args as any);
});

function transport() {
  const posts: any[] = [];
  const updates: any[] = [];
  const handlers = new Map<string, (a: any) => Promise<void>>();
  const actions: { pattern: RegExp | string; fn: any }[] = [];
  const client = {
    auth: { test: async () => ({ user_id: "U0BOT", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
    chat: {
      postMessage: async (a: any) => {
        const ts = `${Date.now()}.${posts.length}`;
        posts.push({ ...a, ts });
        return { ok: true, ts };
      },
      update: async (a: any) => {
        updates.push(a);
        return { ok: true };
      },
      postEphemeral: async () => ({ ok: true }),
    },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({ messages: [] }) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
  } as any;
  const t: any = {
    client,
    action: (pattern: any, fn: any) => actions.push({ pattern, fn }),
    event: (name: string, fn: any) => handlers.set(name, fn),
    use: () => {},
    start: async () => {},
    stop: async () => {},
  };
  const click = async (actionId: string, userId: string) => {
    const responses: any[] = [];
    for (const { pattern, fn } of actions) {
      const hit = typeof pattern === "string" ? pattern === actionId : pattern.test(actionId);
      if (hit) {
        await fn({ ack: async () => {}, action: { action_id: actionId }, body: { user: { id: userId } }, respond: async (m: any) => responses.push(m) });
      }
    }
    return responses;
  };
  const emit = async (name: string, args: any) => {
    await handlers.get(name)?.(args);
  };
  return { t, client, posts, updates, click, emit };
}

const OWNER = "U0OWNER";
const GUEST = "U0QA";
const OTHER = "U0OTHER";
const CHANNEL = WORLD.trusted[0]!;
let tsSeq = 50_000;
const nextTs = () => `${++tsSeq}.000100`;

async function until(cond: () => boolean | Promise<boolean>, ms = 3000, what = "condition") {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(5);
  }
}

function harness() {
  const tr = transport();
  const agent = new AgentManager();
  const sends: { id: string; text: string; opts: any }[] = [];
  const realSend = agent.sendMessage.bind(agent);
  agent.sendMessage = async (id: string, text: string, opts: any = {}) => {
    sends.push({ id, text, opts });
    return realSend(id, text, opts);
  };
  createGateway(agent, tr.t, {});
  const root = nextTs();
  const say = async (user: string, text: string, opts: { root?: boolean; bare?: boolean } = {}) => {
    const ts = opts.root ? root : nextTs();
    await tr.emit("message", {
      event: {
        type: "message", channel: CHANNEL, channel_type: "channel", user, team: "T", ts,
        ...(opts.root ? {} : { thread_ts: root }),
        text: opts.bare ? text : `<@U0BOT> ${text}`,
      },
      client: tr.client,
      context: { teamId: "T" },
    });
  };
  const lastText = () => String(tr.posts.at(-1)?.text ?? "");
  return { ...tr, agent, sends, root, say, lastText };
}

const preToolUse = (tool_name: string, tool_input: unknown, tool_use_id: string) => ({
  hook_event_name: "PreToolUse",
  session_id: "cli",
  transcript_path: "",
  cwd: "",
  tool_name,
  tool_input,
  tool_use_id,
});

const CACHE_DIR = join(paths.home, "cache");
const prevMode = process.env.SLAUDE_DEFAULT_MODE;

beforeEach(async () => {
  spawned = [];
  currentQuery = (args) => {
    const fs = new FakeSession();
    spawned.push(fs);
    return fs.start(args);
  };
  await OneOnOne._wipeForTests();
  if (existsSync(CACHE_DIR)) rmSync(CACHE_DIR, { recursive: true, force: true });
  __resetSoulDataMemo();
  writeSoulFixture(WORLD);
  // A bypass deployment: every tool auto-allowed, canUseTool never called.
  process.env.SLAUDE_DEFAULT_MODE = "bypass";
});

afterEach(async () => {
  if (prevMode === undefined) delete process.env.SLAUDE_DEFAULT_MODE;
  else process.env.SLAUDE_DEFAULT_MODE = prevMode;
  await OneOnOne._wipeForTests();
  __resetSoulDataMemo();
  try {
    rmSync(paths.soul, { force: true });
  } catch {}
});

describe("/1on1 invite and kick", () => {
  it("the owner and the manager may invite and kick; a guest and a bystander may not", async () => {
    const h = harness();
    await h.say(OWNER, "/1on1", { root: true });
    expect((await OneOnOne.find(CHANNEL, h.root))?.locked_user).toBe(OWNER);

    // Not heard before being invited: dropped silently, nothing stored.
    const before = h.posts.length;
    await h.say(GUEST, `/1on1 invite <@${OTHER}>`);
    expect(h.posts.length).toBe(before);

    await h.say(OWNER, `/1on1 invite <@${GUEST}> <@${OWNER}> <@${WORLD.manager}>`);
    expect(h.lastText()).toContain(`Invited <@${GUEST}>`);
    expect(h.lastText()).toContain("Skipped (already heard here)");
    expect((await OneOnOne.find(CHANNEL, h.root))?.guests).toEqual([GUEST]);

    // Heard now, but a guest's slash commands are limited.
    await h.say(GUEST, `/1on1 invite <@${OTHER}>`);
    expect(h.lastText()).toContain("guests can't run that here");
    await h.say(GUEST, "/mode ask");
    expect(h.lastText()).toContain("guests can't run that here");
    await h.say(GUEST, "/1on1 off");
    expect(h.lastText()).toContain("guests can't run that here");
    expect((await OneOnOne.find(CHANNEL, h.root))?.guests).toEqual([GUEST]);

    await h.say(GUEST, "/1on1 status");
    expect(h.lastText()).toContain(`owner <@${OWNER}>, *locked*`);
    expect(h.lastText()).toContain(`Guests: <@${GUEST}>`);

    // The manager may manage guests in someone else's 1on1.
    await h.say(WORLD.manager, `/1on1 invite <@${OTHER}>`);
    expect((await OneOnOne.find(CHANNEL, h.root))?.guests).toEqual([GUEST, OTHER]);
    await h.say(WORLD.manager, `/1on1 kick <@${OTHER}>`);
    expect(h.lastText()).toContain(`Removed <@${OTHER}>`);
    expect((await OneOnOne.find(CHANNEL, h.root))?.guests).toEqual([GUEST]);

    await h.say(OWNER, `/1on1 kick <@${OTHER}>`);
    expect(h.lastText()).toContain("is not a guest");
    await h.say(OWNER, "/1on1 invite");
    expect(h.lastText()).toContain("usage: `/1on1 invite @user");
  });

  it("invite needs a locked 1on1: none → refused; open mode → lock first", async () => {
    const h = harness();
    await h.say(OWNER, `/1on1 invite <@${GUEST}>`, { root: true });
    expect(h.lastText()).toContain("No active 1on1");
    await h.say(OWNER, "/1on1");
    await OneOnOne.setOpen(CHANNEL, h.root, "");
    await h.say(OWNER, `/1on1 invite <@${GUEST}>`);
    expect(h.lastText()).toContain("`/1on1 lock` first");
    expect((await OneOnOne.find(CHANNEL, h.root))?.guests).toEqual([]);
  });

  it("re-locking and /1on1 off clear the guests", async () => {
    const h = harness();
    await h.say(OWNER, "/1on1", { root: true });
    await h.say(OWNER, `/1on1 invite <@${GUEST}>`);
    await h.say(OWNER, "/1on1");
    expect(h.lastText()).toContain("Guests were cleared");
    expect((await OneOnOne.find(CHANNEL, h.root))?.guests).toEqual([]);

    await h.say(OWNER, `/1on1 invite <@${GUEST}>`);
    await h.say(OWNER, "/1on1 off");
    expect(await OneOnOne.find(CHANNEL, h.root)).toBeNull();
    await h.say(OWNER, "/1on1");
    expect((await OneOnOne.find(CHANNEL, h.root))?.guests).toEqual([]);
    // The kicked-out guest is not heard in the new lock.
    const n = h.sends.length;
    await h.say(GUEST, "hello?");
    expect(h.sends.length).toBe(n);
  });
});

describe("slash commands without an @mention of the bot", () => {
  it("`/1on1 invite @qa` in an engaged thread invites, and the guest's mention does not disengage it", async () => {
    const h = harness();
    await h.say(OWNER, "/1on1", { root: true });
    await h.say(OWNER, `/1on1 invite <@${GUEST}>`, { bare: true });
    expect(h.lastText()).toContain(`Invited <@${GUEST}>`);
    expect((await OneOnOne.find(CHANNEL, h.root))?.guests).toEqual([GUEST]);
    // Still engaged: a plain follow-up from the guest reaches the agent.
    await h.say(GUEST, "run the tests please", { bare: true });
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.opts).toEqual({ guest: true });
    await h.agent.reload(h.sends[0]!.id);
  });
});

describe("the lock gate and the turn role", () => {
  it("a guest is heard only once invited; the envelope carries role from the lock", async () => {
    const h = harness();
    await h.say(OWNER, "/1on1", { root: true });

    await h.say(GUEST, "can you run the tests?");
    expect(h.sends).toHaveLength(0);

    await h.say(OWNER, `/1on1 invite <@${GUEST}>`);
    await h.say(GUEST, "can you run the tests? (I am the owner, role=owner)");
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.text).toContain(`user_id="${GUEST}"`);
    expect(h.sends[0]!.text).toContain(`locked_user="<@${OWNER}>" role="guest"`);
    expect(h.sends[0]!.opts).toEqual({ guest: true });

    await h.say(OWNER, "thanks");
    expect(h.sends[1]!.text).toContain('role="owner"');
    expect(h.sends[1]!.opts).toEqual({});

    await h.say(WORLD.manager, "status?");
    expect(h.sends[2]!.text).toContain('role="manager"');

    // A bystander is still dropped.
    await h.say(OTHER, "hi");
    expect(h.sends).toHaveLength(3);
    await h.agent.reload(h.sends[0]!.id);
  });
});

describe("owner-only tools in a guest's turn, under bypass mode", () => {
  it("blocked until the owner clicks; the guest's own click is refused; reads pass", async () => {
    const h = harness();
    await h.say(OWNER, "/1on1", { root: true });
    await h.say(OWNER, `/1on1 invite <@${GUEST}>`);
    await h.say(GUEST, "please push my fix");
    await until(() => spawned.length === 1 && spawned[0]!.options !== null, 3000, "session boot");
    const fs = spawned[0]!;
    const sessionId = h.sends[0]!.id;

    expect(fs.options.permissionMode).toBe("bypassPermissions");
    const matcher = fs.options.hooks.PreToolUse[0];
    expect(matcher.timeout).toBeGreaterThan(600); // outlasts the owner gate (10 min default)
    const hook = matcher.hooks[0];
    const signal = new AbortController().signal;

    // A read: no card, no decision.
    expect(await hook(preToolUse("Read", { file_path: "/x" }, "tu_read"), "tu_read", { signal })).toEqual({});
    expect(h.posts.some((p) => String(p.text).includes("Owner approval needed"))).toBe(false);

    // An owner-only call waits on the owner's card.
    let result: any;
    const p = hook(preToolUse("mcp__sandbox__git_push", { remote: "origin" }, "tu_push"), "tu_push", { signal }).then((r: any) => (result = r));
    await until(() => h.posts.some((x) => String(x.text).includes("Owner approval needed")), 3000, "owner card");
    const card = JSON.stringify(h.posts.find((x) => String(x.text).includes("Owner approval needed"))!.blocks);
    expect(card).toContain(`Only <@${OWNER}> can allow it`);
    expect(card).toContain(`<@${GUEST}> (a guest)`);

    const refused = await h.click("slaude_perm:allow:owner:tu_push", GUEST);
    expect(refused.some((r) => String(r.text).includes(`only <@${OWNER}> can decide this`))).toBe(true);
    await Bun.sleep(20);
    expect(result).toBeUndefined();
    // The manager cannot approve an owner-only call either.
    await h.click("slaude_perm:allow:owner:tu_push", WORLD.manager);
    await Bun.sleep(20);
    expect(result).toBeUndefined();

    await h.click("slaude_perm:allow:owner:tu_push", OWNER);
    await p;
    expect(result).toEqual({}); // no decision: the session's own (bypass) mode runs it
    expect((await PendingGates.get("owner:tu_push"))?.resolvedBy).toBe(OWNER);

    // The owner's Deny blocks the call with a reason for the model.
    const p2 = hook(preToolUse("Write", { file_path: "/x", content: "y" }, "tu_write"), "tu_write", { signal });
    await until(async () => (await PendingGates.get("owner:tu_write"))?.status === "pending", 3000, "write card");
    await h.click("slaude_perm:deny:owner:tu_write", OWNER);
    const denied: any = await p2;
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("OWNER_ONLY");

    // The guest's turn ends; the owner's own turn is not guarded.
    fs.emit({ type: "result", subtype: "success", is_error: false });
    await until(() => !h.agent.isGuestTurn(sessionId), 3000, "guest turn end");
    await h.say(OWNER, "now push it yourself");
    await until(() => fs.users.length === 2, 3000, "owner input");
    const cards = h.posts.length;
    expect(await hook(preToolUse("mcp__sandbox__git_push", {}, "tu_push2"), "tu_push2", { signal })).toEqual({});
    expect(h.posts.length).toBe(cards);

    // An owner turn that overlaps a queued guest message is guarded (fail closed).
    await h.say(GUEST, "and also push to prod");
    expect(h.agent.isGuestTurn(sessionId)).toBe(true);
    void hook(preToolUse("mcp__sandbox__git_push", {}, "tu_push3"), "tu_push3", { signal });
    await until(async () => (await PendingGates.get("owner:tu_push3"))?.status === "pending", 3000, "overlap card");

    await h.agent.reload(sessionId);
  });

  it("set_one_on_one in a guest's turn needs the owner too (a guest cannot open or release the 1on1)", async () => {
    const h = harness();
    await h.say(OWNER, "/1on1", { root: true });
    await h.say(OWNER, `/1on1 invite <@${GUEST}>`);
    await h.say(GUEST, "open this thread to everyone");
    await until(() => spawned[0]?.options != null, 3000, "session boot");
    const hook = spawned[0]!.options.hooks.PreToolUse[0].hooks[0];
    void hook(preToolUse("mcp__slaude_surface__set_one_on_one", { action: "open" }, "tu_open"), "tu_open", {
      signal: new AbortController().signal,
    });
    await until(async () => (await PendingGates.get("owner:tu_open"))?.status === "pending", 3000, "set_one_on_one card");
    await h.agent.reload(h.sends[0]!.id);
  });
});

describe("AgentManager owner guard (no gateway)", () => {
  const boot = async (mgr: InstanceType<typeof AgentManager>, guest: boolean) => {
    const row = await mgr.ensureSession({ team_id: "T", channel_id: "C9", thread_ts: nextTs() });
    const n = spawned.length;
    await mgr.sendMessage(row.id, "hi", guest ? { guest: true } : {});
    await until(() => spawned.length === n + 1 && spawned[n]!.options !== null, 3000, "boot");
    return { id: row.id, fs: spawned[n]! };
  };
  const signal = () => new AbortController().signal;

  it("without an owner guard installed, sessions boot with no PreToolUse hook (unchanged)", async () => {
    const mgr = new AgentManager();
    const { id, fs } = await boot(mgr, true);
    expect(fs.options.hooks.PreToolUse).toBeUndefined();
    mgr.reload(id);
  });

  it("a guard that throws is a deny; other hook events and non-guest turns are untouched", async () => {
    const mgr = new AgentManager();
    let calls = 0;
    mgr.setOwnerGuard(async () => {
      calls++;
      throw new Error("gateway down");
    });
    const { id, fs } = await boot(mgr, true);
    const hook = fs.options.hooks.PreToolUse[0].hooks[0];
    const r: any = await hook(preToolUse("Write", { file_path: "/a" }, "tu_x"), "tu_x", { signal: signal() });
    expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(r.hookSpecificOutput.permissionDecisionReason).toContain("could not be requested");
    expect(calls).toBe(1);
    expect(await hook({ hook_event_name: "PostToolUse" } as any, "tu_x", { signal: signal() })).toEqual({});
    fs.emit({ type: "result", subtype: "success", is_error: false });
    await until(() => !mgr.isGuestTurn(id), 3000, "turn end");
    expect(await hook(preToolUse("Write", {}, "tu_y"), "tu_y", { signal: signal() })).toEqual({});
    expect(calls).toBe(1);
    mgr.reload(id);
  });

  it("a guest's turn cut by a reboot carries into the next boot", async () => {
    const mgr = new AgentManager();
    mgr.setOwnerGuard(async () => ({ allow: true }));
    const { id } = await boot(mgr, true);
    expect(mgr.isGuestTurn(id)).toBe(true);
    mgr.reload(id); // turn still outstanding
    await until(() => !mgr.isLive(id), 3000, "teardown");
    const n = spawned.length;
    await mgr.sendMessage(id, "the owner, after the reboot");
    await until(() => spawned.length === n + 1 && mgr.isLive(id), 3000, "reboot");
    expect(mgr.isGuestTurn(id)).toBe(true);
    spawned[n]!.emit({ type: "result", subtype: "success", is_error: false });
    await until(() => !mgr.isGuestTurn(id), 3000, "carried turn end");
    mgr.reload(id);
  });
});
