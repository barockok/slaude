import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { __resetDecide } from "../../src/access/decide";
import type { Grant } from "../../src/access/grants";
import { SITES, type SiteId } from "../../src/access/sites";
import { MAX_INFLIGHT, admitAt, approversAt, checkAt, deniedAt, listAt, roleAt, sameAt, settleShadows } from "../../src/access/wired";
import * as Domain from "../../src/db/domain";
import { metrics } from "../../src/metrics";
import * as Actor from "../../src/refs/actor";
import * as Authority from "../../src/access/authority";
import { setMode } from "../helpers/shadow-modes";

import { roleInternal } from "../../src/access/authority";
const roleInternalProbe = (gs: Grant[], actor: any): boolean => roleInternal(gs, actor) === "manager";

const T1 = "T0EXAMPLE";
const SELF = "U0EXAMPLE";
const OTHER = "U0SECOND";

const g = (o: Partial<Grant> & Pick<Grant, "subjectKind" | "subjectId">): Grant => ({ role: "member", deny: false, dmOnly: false, source: "console", ...o });
const slack = (id: string, role: Grant["role"], o: Partial<Grant> = {}) => g({ subjectKind: "user", subjectId: id, role, subject: { service: "slack" }, ...o });
const email = (address: string, role: Grant["role"]) => g({ subjectKind: "user", subjectId: `email:${address}`, role, subject: { service: "email", address } });

function raw(text: string, name: string, labels: Record<string, string>): number {
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  return text
    .split("\n")
    .filter((l) => l.startsWith(name + "{") && want.every((w) => l.includes(w)))
    .reduce((sum, l) => sum + Number(l.split(" ").pop()), 0);
}
let baseline = "";
const count = (name: string, labels: Record<string, string>): number => raw(metrics.render(), name, labels) - raw(baseline, name, labels);

let saved: string | undefined;
beforeEach(async () => {
  // Shadows another test file left running would otherwise land in this test's counts.
  await settleShadows();
  baseline = metrics.render();
  saved = process.env.SLAUDE_ACCESS_SOURCE;
  delete process.env.SLAUDE_ACCESS_SOURCE;
  await Domain._wipeForTests();
  Actor.invalidateActors();
  __resetDecide();
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await settleShadows();
  if (saved === undefined) delete process.env.SLAUDE_ACCESS_SOURCE;
  else process.env.SLAUDE_ACCESS_SOURCE = saved;
  mock.restore();
});

/** A user with a verified Slack binding and a verified email, so an `email:` grant disagrees with the string path. */
async function verifiedUser() {
  const s = await Domain.ensureBinding({ service: "slack", kind: "user", workspace: T1, value: SELF, state: "verified", source: "test" });
  await Domain.ensureBinding({ service: "email", kind: "address", workspace: "", value: "a@example.com", state: "verified", source: "test", userId: s.userId });
}

type Probe = { site: SiteId; legacy: unknown; run: () => unknown };
/** One probe per registered site: its helper, over grants where the engine would answer differently than the string path. */
function probe(site: SiteId, kind: (typeof SITES)[number]["kind"], teamId: string | null): Probe {
  const grants = [email("a@example.com", "manager"), slack(OTHER, "member")];
  switch (kind) {
    case "admit": {
      const o = { site, persona: "scout", teamId, userId: SELF, channelId: "D0DM", isDM: true, grants };
      return { site, legacy: { ok: false, reason: "whitelist" }, run: async () => (await admitAt(o)) };
    }
    case "role": {
      const o = { site, persona: "scout", teamId, userId: SELF, channelId: null, grants };
      return { site, legacy: null, run: async () => (await roleAt(o)) };
    }
    case "approvers": {
      const o = { site, persona: "scout", teamId, grants, roles: ["manager" as const] };
      return { site, legacy: [], run: async () => (await approversAt(o)) };
    }
    case "same": {
      const o = { site, persona: "scout", teamId, userId: SELF, otherUserId: OTHER, otherTeamId: teamId };
      return { site, legacy: false, run: async () => (await sameAt(o)) };
    }
    case "list": {
      const o = { site, persona: "scout", teamId, legacy: [OTHER], roles: ["manager" as const], grants: () => grants };
      return { site, legacy: [OTHER], run: async () => (await listAt(o)) };
    }
    case "denied": {
      const o = { site, persona: "scout", teamId, userId: SELF, grants };
      return { site, legacy: false, run: async () => (await deniedAt(o)) };
    }
    case "check": {
      const o = { site, persona: "scout", teamId, userId: SELF, legacy: false, grants: () => grants, internal: ({ grants: gs, actor }: any) => roleInternalProbe(gs, actor) };
      return { site, legacy: false, run: async () => (await checkAt(o)) };
    }
  }
}

describe("every registered site returns the legacy value", () => {
  for (const s of SITES) {
    describe(s.id, () => {
      for (const mode of ["shadow", "legacy", "unset"] as const) {
        test(`${mode}: the engine disagrees`, async () => {
          setMode(mode);
          await verifiedUser();
          const p = probe(s.id, s.kind, T1);
          expect(await p.run()).toEqual(p.legacy as never);
          await settleShadows();
          if (mode !== "legacy") {
            expect(count("slaude_access_shadow_total", { site: s.id, outcome: "mismatch" }) + count("slaude_access_shadow_total", { site: s.id, outcome: "match" })).toBe(1);
          }
          expect(count("slaude_access_decision_total", { source: "legacy", site: s.id })).toBeGreaterThanOrEqual(1);
        });
      }
      test("the resolver throws", async () => {
        spyOn(Actor, "actingUser").mockRejectedValue(new Error("db down"));
        spyOn(Actor, "sameUser").mockRejectedValue(new Error("db down"));
        const p = probe(s.id, s.kind, T1);
        expect(await p.run()).toEqual(p.legacy as never);
        await settleShadows();
        expect(count("slaude_access_shadow_total", { site: s.id, outcome: "match" })).toBe(0);
      });
      test("the engine throws", async () => {
        await verifiedUser();
        for (const fn of ["admitInternal", "roleInternal", "usersWithRoleInternal", "isDeniedInternal"] as const) spyOn(Authority, fn).mockImplementation(() => { throw new Error("engine bug"); });
        spyOn(Actor, "sameUser").mockImplementation(() => { throw new Error("engine bug"); });
        const p = probe(s.id, s.kind, T1);
        expect(await p.run()).toEqual(p.legacy as never);
        await settleShadows();
        expect(count("slaude_access_shadow_total", { site: s.id, outcome: "new_error" })).toBeGreaterThanOrEqual(1);
      });
      for (const how of ["resolver_throws", "engine_throws", "records_throw"] as const) {
        test(`internal: ${how} never throws into the caller`, async () => {
          process.env.SLAUDE_ACCESS_SOURCE = "internal";
          await verifiedUser();
          if (how === "resolver_throws") {
            spyOn(Actor, "actingUser").mockRejectedValue(new Error("db down"));
            spyOn(Actor, "sameUser").mockRejectedValue(new Error("db down"));
          } else if (how === "records_throw") {
            spyOn(Domain, "findBinding").mockRejectedValue(new Error("db down"));
            spyOn(Domain, "resolveUserId").mockRejectedValue(new Error("db down"));
          } else {
            for (const fn of ["admitInternal", "roleInternal", "usersWithRoleInternal", "isDeniedInternal"] as const) spyOn(Authority, fn).mockImplementation(() => { throw new Error("engine bug"); });
            spyOn(Actor, "sameUser").mockImplementation(() => { throw new Error("engine bug"); });
          }
          const p = probe(s.id, s.kind, T1);
          await expect(Promise.resolve(p.run())).resolves.toBeDefined();
        });
      }
      test("an unknown workspace never reaches the engine and keeps the legacy value", async () => {
        const acting = spyOn(Actor, "actingUser");
        const same = spyOn(Actor, "sameUser");
        const p = probe(s.id, s.kind, null);
        expect(await p.run()).toEqual(p.legacy as never);
        await settleShadows();
        expect(acting).not.toHaveBeenCalled();
        expect(same).not.toHaveBeenCalled();
        expect(count("slaude_access_shadow_total", { site: s.id, outcome: "no_team" })).toBe(1);
      });
    });
  }
});

describe("hot path", () => {
  test("legacy source calls no resolver and does no shadow work", async () => {
    process.env.SLAUDE_ACCESS_SOURCE = "legacy";
    const acting = spyOn(Actor, "actingUser");
    const same = spyOn(Actor, "sameUser");
    (await admitAt({ site: "gateway.admit", persona: "scout", teamId: T1, userId: SELF, channelId: "D0DM", isDM: true, grants: [slack(SELF, "member")] }));
    (await roleAt({ site: "gateway.cron.role", persona: "scout", teamId: T1, userId: SELF, grants: [slack(SELF, "member")] }));
    (await sameAt({ site: "gateway.mcp_slash.lock_owner", persona: "scout", teamId: T1, userId: SELF, otherUserId: SELF, otherTeamId: T1 }));
    await settleShadows();
    expect(acting).not.toHaveBeenCalled();
    expect(same).not.toHaveBeenCalled();
    expect(count("slaude_access_decision_total", { source: "legacy", site: "gateway.admit", result: "ok" })).toBe(1);
  });

  test("the caller gets its answer before the shadow finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    spyOn(Actor, "actingUser").mockImplementation(async () => (await gate, null));
    const out = (await roleAt({ site: "gateway.cron.role", persona: "scout", teamId: T1, userId: SELF, grants: [slack(SELF, "manager")] }));
    expect(out).toBe("manager");
    release();
    await settleShadows();
  });

  test("a stalled resolver does not pile up unbounded shadow work", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = spyOn(Actor, "actingUser").mockImplementation(async () => (await gate, null));
    for (let i = 0; i < 1000; i++) (await roleAt({ site: "gateway.cron.role", persona: "scout", teamId: T1, userId: SELF, grants: [slack(SELF, "manager")] }));
    await Bun.sleep(5);
    expect(count("slaude_access_shadow_total", { site: "gateway.cron.role", outcome: "dropped" })).toBe(1000 - MAX_INFLIGHT);
    expect(spy).toHaveBeenCalledTimes(MAX_INFLIGHT);
    release();
    await settleShadows();
  });
});

describe("an email grant for a linked user", () => {
  test("shadow records a mismatch while the answer stays legacy", async () => {
    await verifiedUser();
    const grants = [email("a@example.com", "manager")];
    expect((await roleAt({ site: "gateway.cron.role", persona: "scout", teamId: T1, userId: SELF, grants }))).toBeNull();
    await settleShadows();
    expect(count("slaude_access_shadow_total", { site: "gateway.cron.role", outcome: "mismatch" })).toBe(1);
  });
});

describe("sameAt", () => {
  test("legacy is the string compare, whatever the workspaces say", async () => {
    expect((await sameAt({ site: "gateway.mcp_slash.lock_owner", persona: null, teamId: T1, userId: SELF, otherUserId: SELF, otherTeamId: "T1EXAMPLE" }))).toBe(true);
    expect((await sameAt({ site: "gateway.mcp_slash.lock_owner", persona: null, teamId: T1, userId: SELF, otherUserId: OTHER, otherTeamId: T1 }))).toBe(false);
    expect((await sameAt({ site: "gateway.mcp_slash.lock_owner", persona: null, teamId: T1, userId: "", otherUserId: "", otherTeamId: T1 }))).toBe(true);
  });
});
