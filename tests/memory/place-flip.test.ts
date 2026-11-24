/**
 * The flag's semantics across a flip, for one persona (rc.46): on, then off, then on again.
 * Off and shadow write where rc.45 wrote (the persona's slice) and read only the current turn's place
 * when something was bound there while on; a persona outside SLAUDE_MEMORY_BOUNDARIES_PERSONAS behaves as shadow.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { env } from "../../src/config/env";
import { brainHandlers, type BrainToolDeps } from "../../src/knowledge/mcp-tools";
import { resetStandingGrants, turnBrainScope, type GateInput } from "../../src/knowledge/gated-dispatch";
import { agentSourceId } from "../../src/knowledge/scope";
import { placeSourceId, type PlaceRef } from "../../src/memory/place";
import { __resetPlaceBindingForTests } from "../../src/memory/place-binding";
import { fakeBrain } from "./fake-brain";

const AGENT = "AGENT1";
const A = agentSourceId(AGENT);
const ref = (b: string): PlaceRef => ({ kind: "place", source: placeSourceId(AGENT, b), boundaryId: b, boundaryKind: "channel" });
const CH1 = ref("ch1");
const CH2 = ref("ch2");
const src = (p: PlaceRef) => (p.kind === "place" ? p.source : "");

beforeAll(() => {
  process.env.SLAUDE_AGENT_ID ??= AGENT;
});
beforeEach(async () => {
  resetStandingGrants();
  __resetPlaceBindingForTests();
  await db.run("DELETE FROM memory_scopes");
});
afterEach(() => {
  delete process.env.SLAUDE_MEMORY_BOUNDARIES;
  delete process.env.SLAUDE_MEMORY_BOUNDARIES_PERSONAS;
});

function world(persona: string) {
  const brain = fakeBrain();
  const writes: Array<{ source: string; slug: string }> = [];
  const call: NonNullable<BrainToolDeps["call"]> = async (name, params, scope) => {
    if (name === "put_page") writes.push({ source: scope.sourceId, slug: String(params.slug) });
    return brain.call(name, params, scope);
  };
  // As the gateway builds it: placesOn is read from the flag on every call.
  const turn = (place: PlaceRef): BrainToolDeps => {
    const gate = (): GateInput => ({
      userId: "U0ALICE", teamId: "T0TEAM", interactive: true, origin: "slack", lockedUser: null, channelTrust: "trusted", isManager: false,
      place, agentId: AGENT, threadKey: "C0CHAN:1.1", turnSenders: [{ userId: "U0ALICE", teamId: "T0TEAM", origin: "slack" }],
      ...(env.memory.placesOn(persona) ? { placesOn: true } : {}),
    });
    return { scope: async () => turnBrainScope(gate(), []), gate, managers: () => ["U0MGR"], requestApproval: async () => ({ approved: true, by: "U0MGR" }), call };
  };
  const save = (t: BrainToolDeps, slug: string) => brainHandlers.kb_memoize({ pages: [{ slug, content: `body ${slug}`, summary: "s" }] }, t);
  const get = async (t: BrainToolDeps, slug: string) => (await brainHandlers.kb_get_page({ slug }, t)).content[0]!.text;
  return { turn, save, get, writes };
}

describe("on, then off, then on, for one persona", () => {
  test("writes follow the flag; pages saved while on stay visible only where written", async () => {
    const w = world("alpha");
    process.env.SLAUDE_MEMORY_BOUNDARIES = "on";
    process.env.SLAUDE_MEMORY_BOUNDARIES_PERSONAS = "alpha";
    await w.save(w.turn(CH1), "notes/on-1");
    expect(w.writes.at(-1)).toEqual({ source: src(CH1), slug: "notes/on-1" });

    process.env.SLAUDE_MEMORY_BOUNDARIES = "off";
    await w.save(w.turn(CH1), "notes/off-1");
    expect(w.writes.at(-1)).toEqual({ source: A, slug: "notes/off-1" });
    expect(await w.get(w.turn(CH1), "notes/on-1")).toContain("body notes/on-1"); // still visible where it was written
    expect(await w.get(w.turn(CH2), "notes/on-1")).toBe("null"); // and nowhere else
    expect(await w.get(w.turn(CH2), "notes/off-1")).toContain("body notes/off-1"); // persona-wide, as before

    process.env.SLAUDE_MEMORY_BOUNDARIES = "on";
    await w.save(w.turn(CH2), "notes/on-2");
    expect(w.writes.at(-1)).toEqual({ source: src(CH2), slug: "notes/on-2" });
    expect(await w.get(w.turn(CH1), "notes/on-1")).toContain("body notes/on-1");
    expect(await w.get(w.turn(CH1), "notes/on-2")).toBe("null");
    expect(await w.get(w.turn(CH1), "notes/off-1")).toContain("body notes/off-1");
  });

  test("shadow behaves like off", async () => {
    const w = world("alpha");
    process.env.SLAUDE_MEMORY_BOUNDARIES = "on";
    await w.save(w.turn(CH1), "notes/on-1");
    process.env.SLAUDE_MEMORY_BOUNDARIES = "shadow";
    await w.save(w.turn(CH1), "notes/sh-1");
    expect(w.writes.at(-1)).toEqual({ source: A, slug: "notes/sh-1" });
    expect(await w.get(w.turn(CH1), "notes/on-1")).toContain("body");
    expect(await w.get(w.turn(CH2), "notes/on-1")).toBe("null");
  });

  test("a persona outside the canary list is untouched while another is on", async () => {
    process.env.SLAUDE_MEMORY_BOUNDARIES = "on";
    process.env.SLAUDE_MEMORY_BOUNDARIES_PERSONAS = "alpha";
    const other = world("beta");
    await other.save(other.turn(CH1), "notes/beta-1");
    expect(other.writes.at(-1)).toEqual({ source: A, slug: "notes/beta-1" });
    expect(other.writes.length).toBe(1);
    const rows = await db.query("SELECT 1 FROM memory_scopes");
    expect(rows.length).toBe(0); // no place was bound for a persona the canary leaves out
  });
});
