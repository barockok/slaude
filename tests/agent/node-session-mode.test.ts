/**
 * A node has no database. The /1on1 lock that shapes the <session-mode> block
 * used to be read straight from the database at session boot; on a node after
 * the Secret split that read hit an empty embedded database and the block
 * silently vanished. Now the gateway signs the lock into the job token, the
 * node installs a lock resolver over it, and the manager builds the same block
 * without touching the database. A lock change reaches a WARM session through
 * the signed session-config fingerprint, which reboots it.
 *
 * Boots a node-role AgentManager (SLAUDE_ROLE=node, SLAUDE_DB=pg, no URL) with
 * a fake claude-agent-sdk `query`, a fake session store, and a spy on the
 * database lock lookup.
 */
import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SLAUDE_AUTO_EVOLVE = "0";
process.env.SLAUDE_IDLE_MINUTES = "0";

const realSdk = await import("@anthropic-ai/claude-agent-sdk");
type QueryArgs = { prompt: AsyncIterable<any>; options: any };
/** Options of every query() boot, in order: one entry per session (re)boot. */
let captured: any[] = [];
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...realSdk,
  query: (args: QueryArgs) => {
    captured.push(args.options);
    // A warm session: answer every prompt until the input closes.
    return {
      async *[Symbol.asyncIterator]() {
        for await (const _ of args.prompt) {
          yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
          yield { type: "result", subtype: "success", is_error: false };
        }
      },
      setPermissionMode: async () => ({}),
      mcpServerStatus: async () => [],
      interrupt: async () => {},
    };
  },
}));

const { AgentManager } = await import("../../src/agent/manager");
const OneOnOne = await import("../../src/db/one-on-one");
const { memory } = await import("../../src/memory");
const { memory: sqliteMemory } = await import("../../src/memory/sqlite-provider");
const { NodeDbAccessError } = await import("../../src/db/client");
const { lockFromClaims } = await import("../../src/node/session-lock");
const { sessionConfigFp } = await import("../../src/remote/fingerprint");

const ENV = ["SLAUDE_ROLE", "SLAUDE_DB", "SLAUDE_PG_URL"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.SLAUDE_ROLE = "node";
  process.env.SLAUDE_DB = "pg";
  delete process.env.SLAUDE_PG_URL;
});
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function fakeStore() {
  const rows = new Map<string, any>();
  return {
    rows,
    async findById(id: string) { return rows.get(id) ?? null; },
    async findByThread(k: any) {
      for (const r of rows.values()) if (r.slack_channel_id === k.channel_id && r.slack_thread_ts === k.thread_ts) return r;
      return null;
    },
    async createForThread(a: any) {
      const r = {
        id: `s-${rows.size + 1}`, created_at: 0, updated_at: 0, title: null, model: a.model, working_dir: a.working_dir,
        status: "idle", claude_started: 0, slack_team_id: a.thread.team_id, slack_channel_id: a.thread.channel_id,
        slack_thread_ts: a.thread.thread_ts, permission_mode: "default", engaged: 1, persona_id: "default",
      };
      rows.set(r.id, r);
      return r;
    },
    async markStarted() {}, async clearStarted() {}, async setStatus() {}, async setPermissionMode() {}, async setModel() {},
  };
}

type Lock = { user: string; openScope: string | null } | null;

/** A job token's payload as the gateway would sign it (unsigned here; the node decodes without verifying). */
const token = (claims: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify({ channel: "C1", thread: "1.1", ...claims })).toString("base64url")}.y`;
/** A token as the current gateway mints it: lock claim plus the fingerprint over it. */
const gatewayToken = (session: string, lock: Lock) =>
  token({ session, lock, sessionConfigFp: sessionConfigFp({ runAs: lock?.user ?? null, lock, remote: null }) });
const fpOf = (tok: string) => JSON.parse(Buffer.from(tok.split(".")[1]!, "base64url").toString()).sessionConfigFp as string | undefined;

async function until(cond: () => boolean, label: string, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await Bun.sleep(5);
  }
}

/** A node-role manager wired like the worker wires it: token store, lock
 *  resolver over the token, and a turn that runs the worker's config check. */
async function nodeSession() {
  captured = [];
  const mgr = new AgentManager();
  const events: any[] = [];
  mgr.on("event", (e: any) => events.push(e));
  const store = fakeStore();
  mgr.setSessionStore(store as any);
  mgr.setPersonaSoulResolver(async () => ({ soulMd: "node soul", soulJson: null }));
  const dir = mkdtempSync(join(tmpdir(), "slaude-node-mode-"));
  mgr.setSessionConfigDirResolver(async () => dir);
  let tok = "";
  mgr.setSessionLockResolver(async (sid) => lockFromClaims({ tokenFor: () => tok }, sid));
  const row = await mgr.ensureSession({ team_id: "T1", channel_id: "C1", thread_ts: "1.1" });
  /** One turn as runLockedTurn does it: bind the token, check the config, send. */
  const turn = async (t: string) => {
    tok = t;
    const done = events.filter((e) => e.type === "done" || e.type === "error").length;
    expect(await mgr.ensureConfigFp(row.id, fpOf(t), 3000)).toBe(true);
    await mgr.sendMessage(row.id, "hello");
    await until(() => events.filter((e) => e.type === "done" || e.type === "error").length > done, "turn end");
  };
  return { mgr, row, turn, events, setToken: (t: string) => (tok = t) };
}

const PRIVATE = "This thread is a private 1on1 session locked to <@U_OWNER>.";
const OPEN = "currently open to all participants";

describe("node-role session mode from gateway-supplied data", () => {
  it("a locked thread gets the private 1on1 block, and the database is never asked", async () => {
    const find = spyOn(OneOnOne, "find");
    const s = await nodeSession();
    await s.turn(gatewayToken(s.row.id, { user: "U_OWNER", openScope: null }));
    expect(captured).toHaveLength(1);
    expect(captured[0].systemPrompt.append).toContain(PRIVATE);
    expect(find).not.toHaveBeenCalled();
    find.mockRestore();
    s.mgr.reload(s.row.id);
  });

  it("an open thread gets the open block with its scope; an unlocked one gets none", async () => {
    const s = await nodeSession();
    await s.turn(gatewayToken(s.row.id, { user: "U_OWNER", openScope: "only billing" }));
    expect(captured[0].systemPrompt.append).toContain(OPEN);
    expect(captured[0].systemPrompt.append).toContain("only billing");
    s.mgr.reload(s.row.id);

    const u = await nodeSession();
    await u.turn(gatewayToken(u.row.id, null));
    expect(captured[0].systemPrompt.append).not.toContain("<session-mode>");
    u.mgr.reload(u.row.id);
  });
});

describe("a warm node session follows the lock", () => {
  it("locked → open reboots the session, which gets the open-mode instructions", async () => {
    const s = await nodeSession();
    await s.turn(gatewayToken(s.row.id, { user: "U_OWNER", openScope: null }));
    expect(captured).toHaveLength(1);
    await s.turn(gatewayToken(s.row.id, { user: "U_OWNER", openScope: "billing only" }));
    expect(captured).toHaveLength(2);
    expect(captured[1].systemPrompt.append).toContain(OPEN);
    expect(captured[1].systemPrompt.append).toContain("billing only");
    expect(captured[1].systemPrompt.append).not.toContain(PRIVATE);
    s.mgr.reload(s.row.id);
  });

  it("open → locked reboots the session, which gets the private instructions", async () => {
    const s = await nodeSession();
    await s.turn(gatewayToken(s.row.id, { user: "U_OWNER", openScope: "" }));
    await s.turn(gatewayToken(s.row.id, { user: "U_OWNER", openScope: null }));
    expect(captured).toHaveLength(2);
    expect(captured[1].systemPrompt.append).toContain(PRIVATE);
    s.mgr.reload(s.row.id);
  });

  // Upgrade: a session warm from a token without a fingerprint (older gateway,
  // or remote mode off before this release) reboots once on the first token
  // that carries one, then stays up — no reboot loop.
  it("a session booted without a fingerprint reboots exactly once when one arrives", async () => {
    const s = await nodeSession();
    const lock = { user: "U_OWNER", openScope: null };
    await s.turn(token({ session: s.row.id, lock }));
    expect(captured).toHaveLength(1);
    await s.turn(gatewayToken(s.row.id, lock));
    expect(captured).toHaveLength(2);
    await s.turn(gatewayToken(s.row.id, lock));
    await s.turn(gatewayToken(s.row.id, lock));
    expect(captured).toHaveLength(2);
    s.mgr.reload(s.row.id);
  });

  it("an unchanged lock does not reboot the session", async () => {
    const s = await nodeSession();
    const lock = { user: "U_OWNER", openScope: null };
    await s.turn(gatewayToken(s.row.id, lock));
    await s.turn(gatewayToken(s.row.id, lock));
    await s.turn(gatewayToken(s.row.id, lock));
    expect(captured).toHaveLength(1);
    s.mgr.reload(s.row.id);
  });
});

describe("failing closed on a node with no database", () => {
  // A token from a gateway that predates the lock claim: the node cannot know
  // the lock, and its database fallback is refused. The turn must error rather
  // than run without the privacy instruction.
  it("a token with no lock claim errors the turn; the session never starts", async () => {
    const s = await nodeSession();
    s.setToken(token({ session: s.row.id }));
    // The worker's runTurn rejects the turn when sendMessage rejects.
    await expect(s.mgr.sendMessage(s.row.id, "hello")).rejects.toBeInstanceOf(NodeDbAccessError);
    expect(captured).toHaveLength(0);
    expect(s.mgr.isLive(s.row.id)).toBe(false);
  });

  it("a token for another session is not trusted for this one", async () => {
    const s = await nodeSession();
    s.setToken(gatewayToken("some-other-session", { user: "U_OWNER", openScope: null }));
    await expect(s.mgr.sendMessage(s.row.id, "hello")).rejects.toBeInstanceOf(NodeDbAccessError);
    expect(captured).toHaveLength(0);
  });
});

// SLAUDE_MEMORY=sqlite: the sqlite provider needs the database a node refuses.
// Memory must never break a turn: the manager catches and logs both paths.
describe("memory on a node with no database", () => {
  it("the sqlite provider is refused in the node role", async () => {
    await expect(sqliteMemory.prefetch("s-x")).rejects.toBeInstanceOf(NodeDbAccessError);
    await expect(sqliteMemory.syncTurn({ sessionId: "s-x", user: "u", assistant: "a" })).rejects.toBeInstanceOf(NodeDbAccessError);
  });

  it("a failing prefetch and syncTurn do not break the turn", async () => {
    const pre = spyOn(memory, "prefetch").mockImplementation((id: string) => sqliteMemory.prefetch(id));
    const sync = spyOn(memory, "syncTurn").mockImplementation((t: any) => sqliteMemory.syncTurn(t));
    try {
      const s = await nodeSession();
      await s.turn(gatewayToken(s.row.id, null));
      expect(pre).toHaveBeenCalled();
      await until(() => sync.mock.calls.length > 0, "syncTurn");
      expect(s.events.some((e) => e.type === "error")).toBe(false);
      s.mgr.reload(s.row.id);
    } finally {
      pre.mockRestore();
      sync.mockRestore();
    }
  });
});

describe("lockFromClaims", () => {
  it("returns undefined for a token from a gateway that sends no lock claim, so the caller falls back", () => {
    expect(lockFromClaims({ tokenFor: () => token({ session: "s" }) }, "s")).toBeUndefined();
    expect(lockFromClaims({ tokenFor: () => undefined }, "s")).toBeUndefined();
  });

  it("returns undefined for a token minted for another session", () => {
    expect(lockFromClaims({ tokenFor: () => token({ session: "other", lock: null }) }, "s")).toBeUndefined();
  });

  it("builds the lock row from the claim", () => {
    expect(lockFromClaims({ tokenFor: () => token({ session: "s", lock: { user: "U1", openScope: "x" } }) }, "s")).toEqual({
      channel_id: "C1", thread_ts: "1.1", locked_user: "U1", created_by: "", created_at: 0, open_scope: "x",
    });
    expect(lockFromClaims({ tokenFor: () => token({ session: "s", lock: null }) }, "s")).toBeNull();
  });
});
