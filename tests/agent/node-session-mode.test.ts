/**
 * A node has no database. The /1on1 lock that shapes the <session-mode> block
 * used to be read straight from the database at session boot; on a node after
 * the Secret split that read hit an empty embedded database and the block
 * silently vanished. Now the gateway signs the lock into the job token, the
 * node installs a lock resolver over it, and the manager builds the same block
 * without touching the database.
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
let captured: any[] = [];
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...realSdk,
  query: (args: QueryArgs) => {
    captured.push(args.options);
    // Consume the first prompt, answer, then end.
    return {
      async *[Symbol.asyncIterator]() {
        for await (const _ of args.prompt) {
          yield { type: "result", subtype: "success", is_error: false };
          return;
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
const { lockFromClaims } = await import("../../src/node/session-lock");

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

/** A job token's payload as the gateway would sign it (unsigned here; the node decodes without verifying). */
const token = (claims: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify({ channel: "C1", thread: "1.1", ...claims })).toString("base64url")}.y`;

async function bootWith(claims: Record<string, unknown>): Promise<string> {
  captured = [];
  const mgr = new AgentManager();
  const store = fakeStore();
  mgr.setSessionStore(store as any);
  mgr.setPersonaSoulResolver(async () => ({ soulMd: "node soul", soulJson: null }));
  const dir = mkdtempSync(join(tmpdir(), "slaude-node-mode-"));
  mgr.setSessionConfigDirResolver(async () => dir);
  const tok = token(claims);
  mgr.setSessionLockResolver(async (sid) => lockFromClaims({ tokenFor: () => tok }, sid));
  const row = await mgr.ensureSession({ team_id: "T1", channel_id: "C1", thread_ts: "1.1" });
  await mgr.sendMessage(row.id, "hello");
  const t0 = Date.now();
  while (captured.length === 0 && Date.now() - t0 < 3000) await Bun.sleep(5);
  expect(captured.length).toBe(1);
  return captured[0].systemPrompt.append as string;
}

describe("node-role session mode from gateway-supplied data", () => {
  it("a locked thread gets the private 1on1 block, and the database is never asked", async () => {
    const find = spyOn(OneOnOne, "find");
    const prompt = await bootWith({ lock: { user: "U_OWNER", openScope: null } });
    expect(prompt).toContain("<session-mode>");
    expect(prompt).toContain("This thread is a private 1on1 session locked to <@U_OWNER>.");
    expect(find).not.toHaveBeenCalled();
    find.mockRestore();
  });

  it("an open thread gets the open block with its scope", async () => {
    const find = spyOn(OneOnOne, "find");
    const prompt = await bootWith({ lock: { user: "U_OWNER", openScope: "only billing" } });
    expect(prompt).toContain("currently open to all participants");
    expect(prompt).toContain("only billing");
    expect(find).not.toHaveBeenCalled();
    find.mockRestore();
  });

  it("an unlocked thread (lock: null) gets no block", async () => {
    const find = spyOn(OneOnOne, "find");
    const prompt = await bootWith({ lock: null });
    expect(prompt).not.toContain("<session-mode>");
    expect(find).not.toHaveBeenCalled();
    find.mockRestore();
  });
});

describe("lockFromClaims", () => {
  it("returns undefined for a token from a gateway that sends no lock claim, so the caller falls back", () => {
    expect(lockFromClaims({ tokenFor: () => token({}) }, "s")).toBeUndefined();
    expect(lockFromClaims({ tokenFor: () => undefined }, "s")).toBeUndefined();
  });

  it("builds the lock row from the claim", () => {
    expect(lockFromClaims({ tokenFor: () => token({ lock: { user: "U1", openScope: "x" } }) }, "s")).toEqual({
      channel_id: "C1", thread_ts: "1.1", locked_user: "U1", created_by: "", created_at: 0, open_scope: "x",
    });
    expect(lockFromClaims({ tokenFor: () => token({ lock: null }) }, "s")).toBeNull();
  });
});
