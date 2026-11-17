/**
 * Slice C task 14: approval and permission cards go through the shadow seam and
 * keep returning the legacy decision under every source mode, and when the
 * resolver or the engine is broken or disagrees.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { canDecidePermission } from "../../src/access/permission-auth";
import { __setGrantsReader, invalidateGrants } from "../../src/access/role";
import type { Grant } from "../../src/access/grants";
import { settleShadows } from "../../src/access/wired";
import { paths } from "../../src/config/home";
import { ApprovalGate } from "../../src/gateway/slack/approval-gate";
import { SoulDataSchema } from "../../src/soul/data";
import { __resetSoulDataMemo, setSoulData } from "../../src/soul/extract";
import { compared, decisions, legacyUnderEveryMode, useShadowEnv } from "../helpers/shadow-modes";

const TEAM = "T0EXAMPLE";
const APPR = "U0APPR";
const OTHER = "U0OTHER";
const DENIED = "U0DENIED";

const slack = (id: string, role: Grant["role"], o: Partial<Grant> = {}): Grant => ({ subjectKind: "user", subjectId: id, role, deny: false, dmOnly: false, source: "console", subject: { service: "slack" }, ...o });
const email = (a: string, role: Grant["role"]): Grant => ({ subjectKind: "user", subjectId: `email:${a}`, role, deny: false, dmOnly: false, source: "console", subject: { service: "email", address: a } });

useShadowEnv({
  before: () => {
    if (existsSync(paths.soul)) unlinkSync(paths.soul);
    setSoulData(SoulDataSchema.parse({ manager: { userId: "U0MGR" } }));
    __setGrantsReader(async () => [email("a@example.com", "manager"), slack(DENIED, "member", { deny: true })]);
  },
  after: () => {
    __setGrantsReader(null);
    invalidateGrants();
    __resetSoulDataMemo();
  },
});

function fakeApp() {
  const handlers: { matcher: RegExp; fn: (a: any) => Promise<void> }[] = [];
  const posts: any[] = [];
  const app: any = {
    action: (matcher: RegExp, fn: any) => handlers.push({ matcher, fn }),
    client: { chat: { postMessage: async (m: any) => (posts.push(m), { ok: true, ts: "1.1" }), update: async () => ({ ok: true }) } },
  };
  const fire = async (actionId: string, userId: string, team: string | null = TEAM) => {
    for (const h of handlers) {
      if (h.matcher.test(actionId)) await h.fn({ ack: async () => {}, action: { action_id: actionId }, body: { user: { id: userId }, ...(team ? { team: { id: team } } : {}) }, respond: async () => {} });
    }
  };
  return { app, posts, fire };
}

async function firstApprove(f: { posts: any[] }): Promise<string> {
  for (let i = 0; i < 500 && f.posts.length === 0; i++) await Bun.sleep(1);
  return f.posts[0].blocks.find((b: any) => b.type === "actions").elements.find((e: any) => e.action_id.includes("approve")).action_id;
}

/** A card with one env approver: who gets through. */
async function cardScenario(envApprovers: string[], clickers: string[]): Promise<Record<string, string>> {
  const f = fakeApp();
  const gate = new ApprovalGate(f.app, envApprovers);
  let by: string | undefined;
  const p = gate.request({ channel: "C0EXAMPLE", threadTs: "1.1", summary: "x", sessionId: `S${Math.random()}` }).then((d) => ((by = d.by), d));
  const id = await firstApprove(f);
  const out: Record<string, string> = {};
  for (const c of clickers) {
    by = undefined;
    await f.fire(id, c);
    await Bun.sleep(5);
    out[c] = by ?? "pending";
    if (by) break;
  }
  await p.catch(() => {});
  return out;
}

describe("approval click", () => {
  legacyUnderEveryMode("env allowlist", () => cardScenario([APPR], [OTHER, APPR]), { [OTHER]: "pending", [APPR]: APPR });
  legacyUnderEveryMode("a deny grant refuses a listed clicker", () => cardScenario([DENIED, APPR], [DENIED, APPR]), { [DENIED]: "pending", [APPR]: APPR });
  legacyUnderEveryMode("an empty allowlist admits anyone but a denied clicker", () => cardScenario([], [DENIED, OTHER]), { [DENIED]: "pending", [OTHER]: OTHER });

  test("the click sites count decisions and compare", async () => {
    await cardScenario([APPR], [OTHER, APPR]);
    await settleShadows();
    for (const site of ["approval.click_allowlist", "approval.click_denied"]) {
      expect(decisions(site)).toBeGreaterThan(0);
      expect(compared(site)).toBeGreaterThan(0);
    }
  });

  test("the chain's deny filter counts a decision per member", async () => {
    await cardScenario([DENIED, APPR], [APPR]);
    await settleShadows();
    expect(decisions("approval.resolve_denied")).toBe(2);
  });

  test("a click without a workspace counts no_team and decides the same", async () => {
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, [APPR]);
    const p = gate.request({ channel: "C0EXAMPLE", threadTs: "1.1", summary: "x", sessionId: "S-noteam" });
    const id = await firstApprove(f);
    await f.fire(id, OTHER, null);
    await f.fire(id, APPR, null);
    expect((await p).by).toBe(APPR);
    await settleShadows();
    expect(compared("approval.click_allowlist")).toBe(0);
  });
});

describe("permission card deciders", () => {
  const base = { initiator: "U0ALICE", lockOwner: "U0LOCK", persona: "default", channel: "C0EXAMPLE", teamId: TEAM, lockTeamId: TEAM };
  const scenario = async () => {
    const out: Record<string, boolean> = {};
    for (const c of ["U0ALICE", "U0LOCK", "U0MGR", "U0RAND"]) out[c] = await canDecidePermission({ ...base, clicker: c });
    return out;
  };
  legacyUnderEveryMode("initiator, lock owner, manager, random", scenario, { U0ALICE: true, U0LOCK: true, U0MGR: true, U0RAND: false });

  test("each comparison counts a decision", async () => {
    await scenario();
    await settleShadows();
    for (const site of ["permission.initiator_same", "permission.lock_owner_same", "permission.role"]) expect(decisions(site)).toBeGreaterThan(0);
  });

  test("without a workspace the answer is the same and nothing is shadowed", async () => {
    expect(await canDecidePermission({ ...base, teamId: null, clicker: "U0LOCK" })).toBe(true);
    expect(await canDecidePermission({ ...base, teamId: null, clicker: "U0RAND" })).toBe(false);
    await settleShadows();
    expect(compared("permission.role")).toBe(0);
  });
});
