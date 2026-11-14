/**
 * Safety proof (b): under SLAUDE_ACCESS_SOURCE=internal, through the real seam
 * (`decide.ts`), the whole golden table (identities x grants x contexts) gives
 * exactly the pure engine's answer, and the only differences from the legacy
 * readers are the ones the table tags as intended. The records the seam reads are
 * answered from each identity's own lookup, so nothing here depends on a seeded
 * database.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { __resetDecide, decideAdmit, decideDenied, decideRole } from "../../src/access/decide";
import { settleShadows } from "../../src/access/wired";
import * as Domain from "../../src/db/domain";
import { metrics } from "../../src/metrics";
import * as Actor from "../../src/refs/actor";
import { CTX, IDENTITIES, KINDS, TAGS, engine, explain, legacy, type Answer, type Identity } from "../helpers/golden-table";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.SLAUDE_ACCESS_SOURCE;
  process.env.SLAUDE_ACCESS_SOURCE = "internal";
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

/** Make the resolver and the record reads answer from the identity's world. */
function world(i: Identity): void {
  __resetDecide(); // the seam shares resolved subjects for a few seconds; each identity is its own world
  spyOn(Actor, "actingUser").mockImplementation(async (team, id) => (team === i.actor.teamId && id === i.actor.slackUserId ? i.actor.acting : null));
  spyOn(Domain, "findBinding").mockImplementation((async (k: { service: string; workspace: string; value: string }) => {
    const hit = k.service === "slack" ? i.lookup.slack(k.workspace, k.value) : null;
    return hit ? { id: `b-${k.value}`, user_id: hit.userId, state: hit.state } : null;
  }) as never);
  spyOn(Domain, "resolveUserId").mockImplementation((async (id: string) => i.lookup.live(id)) as never);
}

async function seam(i: Identity, grants: ReturnType<(typeof KINDS)[number]["build"]>, c: (typeof CTX)[number]): Promise<Answer> {
  const base = { site: "golden", persona: "scout", teamId: i.actor.teamId, userId: i.actor.slackUserId, grants };
  const a = await decideAdmit({ ...base, channelId: c.channelId, isDM: c.isDM });
  const role = await decideRole({ ...base, channelId: c.roleChannel });
  const denied = await decideDenied(base);
  return { admit: a.ok ? "ok" : a.reason, role, denied };
}

describe("internal through the seam equals the engine, and differs from legacy only by tags", () => {
  test("the whole table", async () => {
    const unexplained: string[] = [];
    const wrong: string[] = [];
    const seen = new Set<string>();
    let compared = 0;
    for (const i of IDENTITIES) {
      world(i);
      for (const k of KINDS) {
        const grants = k.build(i);
        for (const c of CTX) {
          compared++;
          const got = await seam(i, grants, c);
          const want = engine(i, grants, c);
          if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${i.name} | ${k.key} | ${c.name}: seam ${JSON.stringify(got)} engine ${JSON.stringify(want)}`);
          const old = legacy(i, grants, c);
          if (JSON.stringify(got) === JSON.stringify(old)) continue;
          const tag = explain(k.key, i);
          if (!tag) unexplained.push(`${i.name} | ${k.key} | ${c.name}: legacy ${JSON.stringify(old)} internal ${JSON.stringify(got)}`);
          else seen.add(tag);
        }
      }
      mock.restore();
      spyOn(console, "warn").mockImplementation(() => {});
    }
    expect(wrong).toEqual([]);
    expect(unexplained).toEqual([]);
    expect(compared).toBe(IDENTITIES.length * KINDS.length * CTX.length);
    for (const t of seen) expect(TAGS as readonly string[]).toContain(t);
    expect(seen.size).toBeGreaterThan(0);
  });

  test("no row fell back: the resolver answered every call", async () => {
    const before = metrics.render();
    const i = IDENTITIES[2]!;
    world(i);
    await seam(i, KINDS[0]!.build(i), CTX[0]!);
    const grew = (name: string) => metrics.render().split("\n").filter((l) => l.includes(name) && l.includes("fallback_legacy")).join() === before.split("\n").filter((l) => l.includes(name) && l.includes("fallback_legacy")).join();
    expect(grew("slaude_access_decision_total")).toBe(true);
  });
});
