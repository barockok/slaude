/**
 * Slice F, review item 5: the REAL gate construction (`brainGateFor`, through the gateway's
 * `__brainGateForClaims`) and `memoryScopeForClaims`, end to end, under every mode of
 * SLAUDE_PERSON_SLICES with a stand-in resolver that always answers with a union. For unset,
 * off, shadow and garbage the gate input and the memory scope must be byte-identical to
 * what a gateway with no resolver at all produces (so a mode can never leak a union by
 * accident); under `union` the gate carries the speaker's slices and only the reads grow.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AgentManager } from "../../../src/agent/manager";
import { db } from "../../../src/db/schema";
import { createGateway, type GatewayHandle } from "../../../src/gateway/core/gateway";
import { memoryScopeForClaims } from "../../../src/gateway/api/memory";
import { mintJobToken, verifyJobToken, type JobClaims } from "../../../src/gateway/api/auth";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import * as PersonSlices from "../../../src/knowledge/person-slices";
import { settlePersonSliceShadows } from "../../../src/slices/decide";
import { cleanWorld } from "../../helpers/person-world";
import { userSourceId } from "../../../src/knowledge/scope";

const SECRET_ENV = process.env.SLAUDE_JOB_SECRET;
const OWN = userSourceId("U0ALICE");
const OTHER = userSourceId("U1ALICE");
let h: GatewayHandle | null = null;

beforeEach(async () => {
  process.env.SLAUDE_JOB_SECRET = "person-parity-secret";
  await db.run("DELETE FROM sessions");
  await db.run("DELETE FROM cron_jobs");
  writeSoulFixture(WORLD);
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await h?.stop();
  h = null;
  delete process.env.SLAUDE_PERSON_SLICES;
  if (SECRET_ENV === undefined) delete process.env.SLAUDE_JOB_SECRET;
  else process.env.SLAUDE_JOB_SECRET = SECRET_ENV;
  spyOn(console, "warn").mockRestore();
}, 60_000);

function transport(): any {
  return {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    },
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {}, event: () => {},
  };
}
const claimsWith = (over: Partial<JobClaims>): JobClaims => {
  const v = verifyJobToken(mintJobToken({ tenant: "default", persona: "default", session: "S-node", team: "T0TEAM", channel: "D0DM", thread: "1.0", initiator: "U0ALICE", scope: "turn", origin: "slack", ...over }));
  if (!v.ok) throw new Error(v.reason);
  return v.claims;
};

/** A resolver stand-in that always answers with a union for the asked id. */
function fakeResolver() {
  return spyOn(PersonSlices, "personSlicesDetailed").mockImplementation(async (_t, id) => ({
    slices: { own: userSourceId(id), reads: [userSourceId(id), OTHER], via: "union", dropped: { conflict: 0, tombstoned: 0 } },
    status: "ok",
    ms: 1,
  }));
}

const MODES: Array<string | undefined> = [undefined, "off", "OFF", "shadow", "garbage", ""];

describe("brainGateFor and memoryScopeForClaims, end to end", () => {
  test("every non-union mode is byte-identical to a gateway with no resolver involved; union attaches the speaker's slices", async () => {
    h = createGateway(new AgentManager(), transport());
    const claims = claimsWith({ runAs: "user:U0ALICE" });
    const snapshot = async () => {
      const gate = await h!.__brainGateForClaims!(claims);
      const mem = await memoryScopeForClaims(gate, claims);
      return { gate: JSON.stringify(gate), mem: JSON.stringify(mem) };
    };
    // The baseline: the resolver stand-in is not even installed.
    delete process.env.SLAUDE_PERSON_SLICES;
    const baseline = await snapshot();
    expect(JSON.parse(baseline.gate).person).toBeUndefined();
    const spy = fakeResolver();
    try {
      for (const mode of MODES) {
        if (mode === undefined) delete process.env.SLAUDE_PERSON_SLICES;
        else process.env.SLAUDE_PERSON_SLICES = mode;
        const got = await snapshot();
        await settlePersonSliceShadows();
        expect({ mode, ...got }).toEqual({ mode, ...baseline });
        // Off, unset and garbage never even call the resolver; shadow calls it in the background only.
        if (mode !== "shadow") expect(spy.mock.calls.length).toBe(0);
        spy.mockClear();
      }
      process.env.SLAUDE_PERSON_SLICES = "union";
      const gate = await h.__brainGateForClaims!(claims);
      expect(gate.person?.reads).toEqual([OWN, OTHER]);
      // Union: the DM and runAs reads grow by exactly the extra, the writes are the same as the baseline.
      const mem = await memoryScopeForClaims(gate, claims);
      const base = JSON.parse(baseline.mem) as { read: { allowedSources: string[] } | null; write: unknown };
      expect(mem.write).toEqual(base.write as never);
      expect(mem.read!.allowedSources).toEqual([...(base.read?.allowedSources ?? []), OTHER]);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  test("a turn locked by someone else is public-only for the speaker in every mode, union included", async () => {
    h = createGateway(new AgentManager(), transport());
    const OneOnOne = await import("../../../src/db/one-on-one");
    await OneOnOne._wipeForTests();
    await OneOnOne.lock({ channelId: "C0TEAM", threadTs: "9.9", lockedUser: "U0BOB", createdBy: "U0BOB", teamId: "T0TEAM" } as never).catch(() => {});
    const spy = fakeResolver();
    try {
      for (const mode of [...MODES, "union"]) {
        if (mode === undefined) delete process.env.SLAUDE_PERSON_SLICES;
        else process.env.SLAUDE_PERSON_SLICES = mode;
        const claims = claimsWith({ channel: "C0TEAM", thread: "9.9", lock: { user: "U0BOB" } as never });
        const gate = await h.__brainGateForClaims!(claims);
        const mem = await memoryScopeForClaims(gate, claims);
        expect(mem.read).toBeNull();
        expect(mem.write).toBeNull();
      }
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});

afterAll(async () => {
  await cleanWorld();
});
